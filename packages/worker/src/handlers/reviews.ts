import { getPrisma } from '@modulewarden/prisma-client';
import { fetchUpstreamPackument } from '@modulewarden/shared/services/upstream';
import type { JobQueue } from '../jobs/queue.js';

export async function registerPackageReviewHandler(queue: JobQueue): Promise<void> {
  await queue.work('package-review', async (job) => {
    const { packageName, packageVersion, tarballHash, auditContext, idempotencyKey } = job.data;
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

    const reviewJob = await prisma.reviewJob.upsert({
      where: { idempotencyKey },
      create: {
        packageVersionId: packageVersionRecord.id,
        auditContext,
        trigger,
        status: 'QUEUED',
        idempotencyKey,
        pgBossJobId: job.id,
      },
      update: {
        status: 'QUEUED',
        pgBossJobId: job.id,
      },
    });

    await queue.enqueueAuditContainerExec(
      reviewJob.id,
      packageName,
      packageVersion,
      effectiveTarballHash,
      packageVersionRecord.predecessor?.tarballHash ?? null,
      auditContext
    );
  });
}
