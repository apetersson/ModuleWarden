import { getPrisma } from '@modulewarden/prisma-client';
import { fetchUpstreamPackument } from '@modulewarden/shared/services/upstream';
import { logger } from '@modulewarden/shared/services/logger';
import type { JobQueue } from '../jobs/queue.js';
import { buildIdempotencyKey } from '@modulewarden/shared/constants';

export async function registerPackageReviewHandler(queue: JobQueue): Promise<void> {
  await queue.work('package-review', async (job) => {
    const {
      packageName,
      packageVersion,
      tarballHash,
      auditContext,
      rawAuditContext,
    } = job.data;
    const sourceContext = rawAuditContext ?? auditContext;
    const prisma = getPrisma();

    const trigger = sourceContext.startsWith('subscription:')
      ? 'SUBSCRIPTION'
      : sourceContext.startsWith('re-audit:')
        ? 'RE_AUDIT'
        : sourceContext.startsWith('manual:')
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

    if (!packageVersionRecord) {
      // PackageVersion not found — fetch upstream and upsert.
      // This handles cases where the enqueue happens before the tarball route
      // has had a chance to create the record (background dep enqueue from
      // packument endpoint, subscription polling, etc.).
      const packument = await fetchUpstreamPackument(packageName);
      const versionData = packument?.versions[packageVersion];
      effectiveTarballHash = versionData?.dist?.integrity ?? versionData?.dist?.shasum ?? tarballHash;
      if (!effectiveTarballHash) {
        throw new Error(`Could not resolve tarball integrity for ${packageName}@${packageVersion}`);
      }
      try {
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
            ...(packument?.time?.[packageVersion]
              ? { publishDate: new Date(packument.time[packageVersion]) }
              : {}),
          },
          update: {},
          select: {
            id: true,
            predecessor: {
              select: { tarballHash: true },
            },
          },
        });
      } catch (upsertErr) {
        throw new Error(
          `Package version ${packageName}@${packageVersion} (${effectiveTarballHash}) ` +
          `not found and could not be created: ${upsertErr instanceof Error ? upsertErr.message : String(upsertErr)}`
        );
      }
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

    // ── Pipeline eligibility check ────────────────────────────────
    // If this ReviewJob is part of an audit pipeline, check that the
    // pipeline step is READY before proceeding. This ensures topological
    // ordering: leaf deps are audited before their dependents.
    //
    // The auditContext follows the format:
    //   <prefix>:pipeline:<pipelineId>:step:<stepId>
    // or for backfilled/legacy jobs we fall back to a direct lookup.
    let pipelineStep = await prisma.auditPipelineStep.findFirst({
      where: { reviewJobId },
      select: { id: true, status: true },
    });

    // If not found by reviewJobId, try parsing the audit context
    if (!pipelineStep) {
      const stepMatch = auditContext.match(/step:([a-f0-9-]+)$/);
      if (stepMatch?.[1]) {
        pipelineStep = await prisma.auditPipelineStep.findUnique({
          where: { id: stepMatch[1] },
          select: { id: true, status: true },
        });
      }
    }

    if (pipelineStep) {
      // Check eligibility FIRST before mutating state.
      if (pipelineStep.status !== 'READY') {
        // Step is not ready — dependencies haven't completed yet.
        // Store reviewJobId for traceability but keep existing status
        // so the pipeline-unblock handler can find and flip this step
        // when all dependencies are ALLOWED.
        await prisma.auditPipelineStep.update({
          where: { id: pipelineStep.id },
          data: { reviewJobId },
        });
        logger.info('Pipeline step not READY, deferring audit', {
          stepId: pipelineStep.id,
          packageName,
          packageVersion,
          stepStatus: pipelineStep.status,
        });
        return;
      }

      // Eligible: flip to RUNNING and proceed
      await prisma.auditPipelineStep.update({
        where: { id: pipelineStep.id },
        data: {
          reviewJobId,
          status: 'RUNNING',
        },
      });
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
