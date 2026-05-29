/**
 * Audit pipeline handlers for DAG-linearised dependency-aware review ordering.
 *
 * Two job types:
 *  - `audit-pipeline-schedule`: Resolves the full transitive dependency DAG for
 *    a root package, creates AuditPipeline + AuditPipelineStep records in the DB,
 *    and enqueues package-review jobs for steps that are immediately READY (leaf
 *    packages with no dependencies).
 *  - `audit-pipeline-unblock`: Triggered when a pipeline step completes with ALLOW.
 *    Checks all steps that depend on the completed one; if all their dependencies
 *    are now ALLOWED, flips them to READY and enqueues their package-review jobs.
 */

import { getPrisma } from '@modulewarden/prisma-client';
import { resolveDependencyDag } from '@modulewarden/shared/services/dag-resolver';
import { fetchUpstreamPackument } from '@modulewarden/shared/services/upstream';
import { buildIdempotencyKey, canonicalReviewAuditContext } from '@modulewarden/shared/constants';
import { logger } from '@modulewarden/shared/services/logger';
import type { JobQueue } from '../jobs/queue.js';

// ── audit-pipeline-schedule ──────────────────────────────────────

/**
 * Register the `audit-pipeline-schedule` handler.
 *
 * Flow:
 * 1. Resolve the full transitive dependency DAG for the requested package
 * 2. Create AuditPipeline + AuditPipelineStep records
 * 3. For steps with no dependencies (leaf packages): set status=READY and
 *    enqueue a `package-review` job
 * 4. All other steps remain PENDING — they will be flipped to READY by the
 *    unblock handler when their dependencies complete
 */
export async function registerPipelineScheduleHandler(queue: JobQueue): Promise<void> {
  await queue.work('audit-pipeline-schedule', async (job) => {
    const { packageName, packageVersion, tarballHash, auditContext } = job.data;
    const prisma = getPrisma();

    // 0. Use an advisory lock to coordinate pipeline creation.
    //    Since pnpm resolves all transitive deps simultaneously, the
    //    packument endpoint may fire audit-pipeline-schedule for 40+
    //    packages at once. The lock ensures only ONE handler creates
    //    a pipeline; all others check if their package is already
    //    covered and skip.
    const LOCK_ID = 20260529; // deterministic lock ID for pipeline creation
    await prisma.$executeRawUnsafe('SELECT pg_advisory_xact_lock($1)', LOCK_ID);

    // After acquiring the lock, re-check: is this package already covered?
    const existingStep = await prisma.auditPipelineStep.findFirst({
      where: {
        packageName,
        packageVersion,
        pipeline: { status: { in: ['IN_PROGRESS', 'COMPLETED'] } as any },
      },
      select: { id: true, pipelineId: true },
    });
    if (existingStep) {
      logger.info('Package already covered by pipeline, skipping', {
        packageName,
        packageVersion,
        existingPipelineId: existingStep.pipelineId,
      });
      return;
    }

    // 1. Resolve the full dependency DAG
    const dag = await resolveDependencyDag(packageName, packageVersion, fetchUpstreamPackument);

    if (dag.steps.length === 0) {
      logger.warn('DAG resolution returned no steps', { packageName, packageVersion });
      return;
    }

    // 2. Create the pipeline record
    const pipeline = await prisma.auditPipeline.create({
      data: {
        rootPackageName: packageName,
        rootPackageVersion: packageVersion,
        tarballHash,
        totalSteps: dag.steps.length,
        status: 'IN_PROGRESS',
      },
    });

    // 3. Create pipeline step records
    const normalizedAuditContext = canonicalReviewAuditContext(auditContext);

    for (const step of dag.steps) {
      // Build the dependsOn string: comma-separated list of package@version
      const dependsOnStr = step.dependsOn.length > 0 ? step.dependsOn.join(',') : '';
      // Determine initial status: leaf deps (no deps) start READY, others PENDING
      const initialStatus = step.dependsOn.length === 0 ? 'READY' : 'PENDING';

      const pipelineStep = await prisma.auditPipelineStep.create({
        data: {
          pipelineId: pipeline.id,
          packageName: step.packageName,
          packageVersion: step.packageVersion,
          tarballHash: step.tarballHash,
          depth: step.depth,
          dependsOn: dependsOnStr,
          linearOrder: step.linearOrder,
          status: initialStatus,
        },
      });

      // 4. For READY steps, enqueue a package-review immediately
      if (initialStatus === 'READY') {
        const stepAuditContext = `${normalizedAuditContext}:pipeline:${pipeline.id}:step:${pipelineStep.id}`;
        const idempotencyKey = buildIdempotencyKey(
          'package-review',
          step.packageName,
          step.packageVersion,
          step.tarballHash,
          stepAuditContext,
        );

        try {
          await queue.send('package-review', {
            packageName: step.packageName,
            packageVersion: step.packageVersion,
            tarballHash: step.tarballHash,
            auditContext: stepAuditContext,
            rawAuditContext: stepAuditContext,
            idempotencyKey,
          });
          logger.info('Enqueued package-review for pipeline step', {
            pipelineId: pipeline.id,
            stepId: pipelineStep.id,
            packageName: step.packageName,
            packageVersion: step.packageVersion,
            linearOrder: step.linearOrder,
          });
        } catch (err) {
          logger.warn('Failed to enqueue package-review for pipeline step', {
            pipelineId: pipeline.id,
            stepId: pipelineStep.id,
            packageName: step.packageName,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
    }

    // If cycles were detected, log them
    if (dag.cycles.length > 0) {
      logger.warn('DAG cycles detected and broken during pipeline schedule', {
        pipelineId: pipeline.id,
        packageName,
        cycleCount: dag.cycles.length,
        cycles: dag.cycles.map((c) => `${c.from} → ${c.to}`),
      });
    }

    logger.info('Audit pipeline scheduled', {
      pipelineId: pipeline.id,
      rootPackage: `${packageName}@${packageVersion}`,
      totalSteps: dag.steps.length,
      readySteps: dag.steps.filter((s) => s.dependsOn.length === 0).length,
      cyclesDetected: dag.cycles.length,
    });
  });
}

// ── audit-pipeline-unblock ───────────────────────────────────────

/**
 * Register the `audit-pipeline-unblock` handler.
 *
 * Triggered when ANY pipeline step completes (ALLOW, BLOCK, QUARANTINE, FAILED).
 *
 * For ALLOW:
 *  - Finds downstream steps waiting on this one
 *  - If ALL their deps are ALLOWED, flips them to READY and enqueues package-review
 *
 * For BLOCKED/FAILED/QUARANTINED:
 *  - Marks all downstream steps as BLOCKED (transitive cascade)
 *  - Eventually marks the pipeline as FAILED if root is blocked
 */
export async function registerPipelineUnblockHandler(queue: JobQueue): Promise<void> {
  await queue.work('audit-pipeline-unblock', async (job) => {
    const { pipelineId, stepId } = job.data;
    const prisma = getPrisma();

    // 1. Find the completed step to know its verdict
    const completedStep = stepId
      ? await prisma.auditPipelineStep.findUnique({
          where: { id: stepId },
          select: { status: true, dependsOn: true },
        })
      : null;

    if (!completedStep) {
      logger.warn('Completed step not found for unblock', { pipelineId, stepId });
      return;
    }

    // 2. Load all pending + ready steps for this pipeline
    const pipeline = await prisma.auditPipeline.findUnique({
      where: { id: pipelineId },
      select: {
        id: true,
        rootPackageName: true,
        status: true,
        steps: {
          where: { status: { in: ['PENDING', 'READY'] as any } },
          orderBy: { linearOrder: 'asc' },
          select: {
            id: true,
            packageName: true,
            packageVersion: true,
            tarballHash: true,
            dependsOn: true,
            status: true,
          },
        },
      },
    });

    if (!pipeline) {
      logger.warn('Pipeline not found for unblock', { pipelineId, stepId });
      return;
    }

    if (pipeline.status !== 'IN_PROGRESS') return;

    // 3. Batch-check dependency verdicts for all pending/ready steps
    const allDepIds = new Set<string>();
    for (const step of pipeline.steps) {
      const deps = step.dependsOn ? step.dependsOn.split(',').filter(Boolean) : [];
      for (const d of deps) allDepIds.add(d);
    }

    const depVerdicts = await batchCheckDepVerdicts([...allDepIds], prisma);
    // depVerdicts: package@version -> 'ALLOW' | 'BLOCK' | 'QUARANTINE' | 'PENDING'

    // 4. Evaluate each step
    let newlyReady = 0;
    let newlyBlocked = 0;

    for (const step of pipeline.steps) {
      const dependsOn = step.dependsOn
        ? step.dependsOn.split(',').filter(Boolean)
        : [];

      if (dependsOn.length === 0) {
        // Leaf dep — should already be READY; flip if still PENDING
        if (step.status === 'PENDING') {
          await flipStepToReady(step, pipeline.id, queue, prisma);
          newlyReady++;
        }
        continue;
      }

      // Check dependencies
      let hasBlockedDep = false;
      let allAllowed = true;

      for (const depId of dependsOn) {
        const verdict = depVerdicts.get(depId);
        if (!verdict || verdict === 'PENDING') {
          allAllowed = false;
        } else if (verdict === 'BLOCK' || verdict === 'QUARANTINE') {
          hasBlockedDep = true;
          allAllowed = false;
        }
        // verdict === 'ALLOW' counts as satisfied
      }

      if (hasBlockedDep) {
        // Transitively block this step
        await prisma.auditPipelineStep.update({
          where: { id: step.id },
          data: { status: 'BLOCKED' },
        });
        newlyBlocked++;
        logger.info('Pipeline step BLOCKED due to blocked dependency', {
          pipelineId,
          stepId: step.id,
          packageName: step.packageName,
        });
      } else if (allAllowed && step.status === 'PENDING') {
        await flipStepToReady(step, pipeline.id, queue, prisma);
        newlyReady++;
      }
    }

    // 5. Check if pipeline is fully done or fully blocked
    if (newlyReady === 0 && newlyBlocked === 0) {
      const remainingActive = await prisma.auditPipelineStep.count({
        where: {
          pipelineId,
          status: { in: ['PENDING', 'READY', 'RUNNING'] as any },
        },
      });

      if (remainingActive === 0) {
        const blockedCount = await prisma.auditPipelineStep.count({
          where: { pipelineId, status: 'BLOCKED' as any },
        });
        if (blockedCount > 0) {
          await prisma.auditPipeline.update({
            where: { id: pipelineId },
            data: { status: 'FAILED' },
          });
          logger.info('Audit pipeline FAILED due to blocked dependencies', {
            pipelineId,
            rootPackage: pipeline.rootPackageName,
            blockedSteps: blockedCount,
          });
        } else {
          await prisma.auditPipeline.update({
            where: { id: pipelineId },
            data: { status: 'COMPLETED' },
          });
          logger.info('Audit pipeline COMPLETED', {
            pipelineId,
            rootPackage: pipeline.rootPackageName,
          });
        }
      }
    }

    if (newlyReady > 0 || newlyBlocked > 0) {
      logger.info('Pipeline unblock cascade', {
        pipelineId,
        newlyReadySteps: newlyReady,
        newlyBlockedSteps: newlyBlocked,
      });
    }
  });
}

/**
 * Trigger pipeline-unblock after any decision is created.
 * Always fires regardless of verdict so that blocked deps cascade too.
 */
export async function triggerPipelineUnblock(
  reviewJobId: string,
  verdict: string,
  queue: JobQueue
): Promise<void> {
  try {
    const prisma = getPrisma();

    const step = await prisma.auditPipelineStep.findFirst({
      where: { reviewJobId },
      select: { id: true, pipelineId: true, packageName: true, packageVersion: true },
    });

    if (!step) return;

    await queue.send('audit-pipeline-unblock', {
      pipelineId: step.pipelineId,
      stepId: step.id,
      packageName: step.packageName,
      packageVersion: step.packageVersion,
    });

    logger.info('Pipeline unblock enqueued', {
      pipelineId: step.pipelineId,
      stepId: step.id,
      verdict,
    });
  } catch (err) {
    logger.warn('Failed to enqueue pipeline unblock', {
      reviewJobId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Batch-check verdicts for a list of dependency identities (package@version).
 * Returns a Map<package@version, 'ALLOW'|'BLOCK'|'QUARANTINE'|'PENDING'>.
 * Eliminates N+1 query patterns for steps with many dependencies.
 */
async function batchCheckDepVerdicts(
  depIds: string[],
  prisma: ReturnType<typeof getPrisma>
): Promise<Map<string, string>> {
  const result = new Map<string, string>();
  if (depIds.length === 0) return result;

  // Parse (name, version) pairs
  const packageVersions: Array<{ name: string; version: string; key: string }> = [];
  for (const depId of depIds) {
    const atIndex = depId.lastIndexOf('@');
    if (atIndex < 0) {
      result.set(depId, 'PENDING');
      continue;
    }
    packageVersions.push({
      name: depId.slice(0, atIndex),
      version: depId.slice(atIndex + 1),
      key: depId,
    });
  }

  if (packageVersions.length === 0) return result;

  // Batch-find PackageVersion records
  const pvMap = new Map<string, string>();
  for (const pv of packageVersions) {
    const record = await prisma.packageVersion.findFirst({
      where: {
        packageName: pv.name,
        version: pv.version,
        registrySource: 'npm',
      },
      orderBy: { createdAt: 'desc' },
      select: { id: true },
    });
    if (record) pvMap.set(pv.key, record.id);
  }

  if (pvMap.size === 0) {
    for (const pv of packageVersions) result.set(pv.key, 'PENDING');
    return result;
  }

  // Batch-find latest decisions for all package version IDs
  const pvIds = [...pvMap.values()];
  const decisions = await prisma.decision.findMany({
    where: { packageVersionId: { in: pvIds } },
    orderBy: { createdAt: 'desc' },
    select: { packageVersionId: true, verdict: true },
  });

  // Keep only the latest per packageVersionId
  const latestDecisions = new Map<string, string>();
  for (const d of decisions) {
    if (!latestDecisions.has(d.packageVersionId)) {
      latestDecisions.set(d.packageVersionId, d.verdict);
    }
  }

  for (const [key, pvId] of pvMap) {
    result.set(key, latestDecisions.get(pvId) ?? 'PENDING');
  }

  for (const pv of packageVersions) {
    if (!result.has(pv.key)) result.set(pv.key, 'PENDING');
  }

  return result;
}

/**
 * Helper: flip a pipeline step to READY and enqueue its package-review.
 */
async function flipStepToReady(
  step: {
    id: string;
    packageName: string;
    packageVersion: string;
    tarballHash: string;
  },
  pipelineId: string,
  queue: JobQueue,
  prisma: ReturnType<typeof getPrisma>
): Promise<void> {
  await prisma.auditPipelineStep.update({
    where: { id: step.id },
    data: { status: 'READY' },
  });

  const stepAuditContext = `pipeline:${pipelineId}:step:${step.id}`;
  const idempotencyKey = buildIdempotencyKey(
    'package-review',
    step.packageName,
    step.packageVersion,
    step.tarballHash,
    stepAuditContext,
  );

  try {
    await queue.send('package-review', {
      packageName: step.packageName,
      packageVersion: step.packageVersion,
      tarballHash: step.tarballHash,
      auditContext: stepAuditContext,
      rawAuditContext: stepAuditContext,
      idempotencyKey,
    });
  } catch (err) {
    logger.warn('Failed to enqueue package-review for unblocked step', {
      pipelineId,
      stepId: step.id,
      packageName: step.packageName,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
