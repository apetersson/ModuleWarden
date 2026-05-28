import { getPrisma } from '@modulewarden/prisma-client';
import type { JobQueue } from '../jobs/queue.js';

/**
 * Register the evidence post-processing handler.
 *
 * The v1 pipeline records evidence artifacts and then emits a
 * `evidence-post-process` job so downstream tasks can enrich provenance,
 * persist metadata, or trigger notifications. This handler keeps the
 * orchestration durable by validating the referenced rows and marking
 * the run/review state as processed for visibility.
 */
export async function registerEvidencePostProcessHandler(queue: JobQueue): Promise<void> {
  await queue.work('evidence-post-process', async (job) => {
    const { auditRunId, evidenceBundleId } = job.data;
    const prisma = getPrisma();

    const auditRun = await prisma.auditRun.findUnique({
      where: { id: auditRunId },
      select: { id: true, reviewJobId: true, status: true },
    });

    if (!auditRun) {
      throw new Error(`Audit run ${auditRunId} not found for post-processing`);
    }

    const evidence = await prisma.evidenceArtifact.findUnique({
      where: { id: evidenceBundleId },
      select: { id: true, auditRunId: true },
    });

    if (!evidence || evidence.auditRunId !== auditRunId) {
      throw new Error(`Evidence ${evidenceBundleId} not associated with audit run ${auditRunId}`);
    }

    // Keep explicit state that downstream processing happened.
    // The audit run itself remains in its existing terminal state; this
    // is purely a provenance/visibility transition.
    await prisma.reviewJob.update({
      where: { id: auditRun.reviewJobId },
      data: { status: auditRun.status === 'COMPLETED' ? 'COMPLETED' : 'RUNNING' },
    });
  });
}

