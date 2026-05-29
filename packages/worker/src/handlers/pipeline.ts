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
 * Triggered when a pipeline step completes with ALLOW. It:
 * 1. Finds all steps in the same pipeline that depend on the completed step
 * 2. For each candidate, checks if ALL dependencies are now ALLOWED
 * 3. If a candidate's deps are all ALLOWED: flips it to READY, enqueues
 *    a package-review for it
 * 4. If the completed step was the root step AND all steps are done:
 *    marks the pipeline as COMPLETED
 */
export async function registerPipelineUnblockHandler(queue: JobQueue): Promise<void> {
  await queue.work('audit-pipeline-unblock', async (job) => {
    const { pipelineId, stepId, packageName, packageVersion } = job.data;
    const prisma = getPrisma();

    // 1. Find all steps in the same pipeline that depend on the completed step
    const completedStepIdentity = `${packageName}@${packageVersion}`;

    const pipeline = await prisma.auditPipeline.findUnique({
      where: { id: pipelineId },
      select: {
        id: true,
        rootPackageName: true,
        status: true,
        steps: {
          where: { status: 'PENDING' as any }, // Steps still waiting for deps
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

    if (pipeline.status !== 'IN_PROGRESS') {
      return; // Pipeline already completed or failed
    }

    // 2. Check each pending step to see if it can become READY
    let newlyReady = 0;

    for (const step of pipeline.steps) {
      if (step.status !== 'PENDING') continue;

      // Parse the dependsOn list
      const dependsOn = step.dependsOn
        ? step.dependsOn.split(',').filter(Boolean)
        : [];

      if (dependsOn.length === 0) continue; // Should already be READY, but skip

      // Check if all dependencies are now ALLOWED
      const allDepsAllowed = await checkAllDepsAllowed(dependsOn, prisma);

      if (!allDepsAllowed) continue;

      // All deps are ALLOWED — flip this step to READY
      await prisma.auditPipelineStep.update({
        where: { id: step.id },
        data: { status: 'READY' },
      });

      // Enqueue a package-review for this step
      const stepAuditContext = `pipeline:${pipeline.id}:step:${step.id}`;
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
        newlyReady++;
        logger.info('Pipeline step unblocked to READY', {
          pipelineId,
          stepId: step.id,
          packageName: step.packageName,
          packageVersion: step.packageVersion,
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

    // 3. Check if the entire pipeline is now complete
    if (newlyReady === 0 && stepId) {
      // No new steps were unblocked — check if this was the last step
      const remainingPending = await prisma.auditPipelineStep.count({
        where: {
          pipelineId,
          status: { in: ['PENDING', 'READY', 'RUNNING'] as any },
        },
      });

      if (remainingPending === 0) {
        await prisma.auditPipeline.update({
          where: { id: pipelineId },
          data: { status: 'COMPLETED' },
        });
        logger.info('Audit pipeline completed', {
          pipelineId,
          rootPackage: pipeline.rootPackageName,
        });
      }
    }

    if (newlyReady > 0) {
      logger.info('Pipeline unblock cascade', {
        pipelineId,
        newlyReadySteps: newlyReady,
      });
    }
  });
}

/**
 * Trigger pipeline-unblock after a decision is created.
 *
 * Looks up the ReviewJob's associated pipeline step (via the audit context or
 * ReviewJob ID stored on the step). If a step is found and the verdict is ALLOW,
 * enqueues an audit-pipeline-unblock job to cascade readiness to dependents.
 *
 * Safe to call from both the audit-container-exec handler and the internal RPC
 * verdict endpoint. Returns without action if no pipeline is associated.
 */
export async function triggerPipelineUnblock(
  reviewJobId: string,
  verdict: string,
  queue: JobQueue
): Promise<void> {
  if (verdict !== 'ALLOW') return;

  try {
    const prisma = getPrisma();

    // Find a pipeline step that references this reviewJobId
    const step = await prisma.auditPipelineStep.findFirst({
      where: { reviewJobId },
      select: { id: true, pipelineId: true, packageName: true, packageVersion: true },
    });

    if (!step) return; // Not a pipeline-managed review

    await queue.send('audit-pipeline-unblock', {
      pipelineId: step.pipelineId,
      stepId: step.id,
      packageName: step.packageName,
      packageVersion: step.packageVersion,
    });

    logger.info('Pipeline unblock enqueued after ALLOW', {
      pipelineId: step.pipelineId,
      stepId: step.id,
      packageName: step.packageName,
    });
  } catch (err) {
    logger.warn('Failed to enqueue pipeline unblock', {
      reviewJobId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Check whether all dependency identities (package@version) have an ALLOW
 * decision in the database.
 */
async function checkAllDepsAllowed(
  dependsOn: string[],
  prisma: ReturnType<typeof getPrisma>
): Promise<boolean> {
  for (const depId of dependsOn) {
    // Parse package@version
    const atIndex = depId.lastIndexOf('@');
    if (atIndex < 0) continue;
    const depName = depId.slice(0, atIndex);
    const depVersion = depId.slice(atIndex + 1);

    // Find the PackageVersion record
    const pv = await prisma.packageVersion.findFirst({
      where: {
        packageName: depName,
        version: depVersion,
        registrySource: 'npm',
      },
      orderBy: { createdAt: 'desc' },
      select: { id: true },
    });

    if (!pv) return false;

    // Check for an ALLOW decision
    const decision = await prisma.decision.findFirst({
      where: {
        packageVersionId: pv.id,
        verdict: 'ALLOW',
      },
      orderBy: { createdAt: 'desc' },
    });

    if (!decision) return false;
  }

  return true;
}
