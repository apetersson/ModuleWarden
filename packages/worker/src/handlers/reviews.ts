import { getPrisma } from '@modulewarden/prisma-client';
import { fetchUpstreamPackument } from '@modulewarden/shared/services/upstream';
import type { JobQueue } from '../jobs/queue.js';
import { buildIdempotencyKey } from '@modulewarden/shared/constants';

export async function registerPackageReviewHandler(queue: JobQueue): Promise<void> {
  await queue.work('package-review', async (job) => {
    const { packageName, packageVersion, tarballHash, auditContext } = job.data;
    const prisma = getPrisma();

    const trigger = auditContext.startsWith('subscription:')
      ? 'SUBSCRIPTION'
      : auditContext.startsWith('re-audit:')
        ? 'RE_AUDIT'
        : auditContext.startsWith('manual:')
          ? 'MANUAL'
          : 'PREFLIGHT';

    let effectiveTarballHash = tarballHash;
    let packageVersionRecord = await prisma.packageVersion.findFirst({
      where: {
        packageName,
        version: packageVersion,
        registrySource: 'npm',
        tarballHash,
      },
      select: {
        id: true,
        predecessor: {
          select: { tarballHash: true },
        },
      },
      orderBy: { createdAt: 'desc' },
    });

    if (!packageVersionRecord && tarballHash.startsWith('unresolved:')) {
      const packument = await fetchUpstreamPackument(packageName);
      const versionData = packument?.versions[packageVersion];
      effectiveTarballHash = versionData?.dist?.integrity ?? versionData?.dist?.shasum ?? '';
      if (!effectiveTarballHash) {
        throw new Error(`Could not resolve tarball integrity for ${packageName}@${packageVersion}`);
      }
      packageVersionRecord = await prisma.packageVersion.upsert({
        where: {
          packageName_version_registrySource_tarballHash: {
            packageName,
            version: packageVersion,
            registrySource: 'npm',
            tarballHash: effectiveTarballHash,
          },
        },
        create: {
          packageName,
          version: packageVersion,
          registrySource: 'npm',
          tarballHash: effectiveTarballHash,
          hasLifecycleScript: typeof versionData?.scripts === 'object' && Object.keys(versionData.scripts ?? {}).length > 0,
          publishDate: packument?.time?.[packageVersion] ? new Date(packument.time[packageVersion]) : undefined,
        },
        update: {},
        select: {
          id: true,
          predecessor: {
            select: { tarballHash: true },
          },
        },
      });
    }

    if (!packageVersionRecord) {
      throw new Error(`Package version ${packageName}@${packageVersion} (${effectiveTarballHash}) not found`);
    }

    const canonicalIdempotencyKey = buildIdempotencyKey(
      'package-review',
      packageName,
      packageVersion,
      effectiveTarballHash,
      auditContext
    );

    let reviewJobId: string;
    let reviewJobStatus: string | undefined;

    const existingReviewJob = await prisma.reviewJob.findFirst({
      where: {
        auditContext,
        packageVersionId: packageVersionRecord.id,
      },
      select: { id: true, status: true },
      orderBy: { updatedAt: 'desc' },
    });
    const hasExactVersionMatch = !!existingReviewJob;

    const existingUnresolvedReviewJob = !existingReviewJob
      ? await prisma.reviewJob.findFirst({
          where: {
            auditContext,
            idempotencyKey: { contains: 'unresolved:' },
            packageVersion: {
              packageName,
              version: packageVersion,
              registrySource: 'npm',
            },
          },
          select: { id: true, status: true },
          orderBy: { updatedAt: 'desc' },
        })
      : null;

    const coalescedReviewJob = existingReviewJob ?? existingUnresolvedReviewJob;

    if (coalescedReviewJob) {
      reviewJobStatus = coalescedReviewJob.status;
      await prisma.reviewJob.update({
        where: { id: coalescedReviewJob.id },
        data: {
          packageVersionId: packageVersionRecord.id,
          idempotencyKey: canonicalIdempotencyKey,
          status: 'QUEUED',
          pgBossJobId: job.id,
        },
      });
      reviewJobId = coalescedReviewJob.id;
    } else {
      const reviewJob = await prisma.reviewJob.create({
        data: {
          packageVersionId: packageVersionRecord.id,
          auditContext,
          trigger,
          status: 'QUEUED',
          idempotencyKey: canonicalIdempotencyKey,
          pgBossJobId: job.id,
        },
      });
      reviewJobId = reviewJob.id;
      reviewJobStatus = reviewJob.status;
    }

    if (reviewJobStatus === 'RUNNING') {
      return;
    }

    await queue.enqueueAuditContainerExec(
      reviewJobId,
      packageName,
      packageVersion,
      effectiveTarballHash,
      packageVersionRecord.predecessor?.tarballHash ?? null,
      auditContext
    );
  });
}
