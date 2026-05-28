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

    if (evidence?.auditRunId !== auditRunId) {
      throw new Error(`Evidence ${evidenceBundleId} not associated with audit run ${auditRunId}`);
    }

    // OBS-05: Compute and store evidence summary metadata.
    const allEvidence = await prisma.evidenceArtifact.findMany({
      where: { auditRunId },
      select: { artifactType: true, status: true, sizeBytes: true },
    });

    const evidenceSummary = {
      totalCount: allEvidence.length,
      byType: allEvidence.reduce<Record<string, number>>((acc, e) => {
        acc[e.artifactType] = (acc[e.artifactType] ?? 0) + 1;
        return acc;
      }, {}),
      totalSizeBytes: allEvidence.reduce((sum, e) => sum + (e.sizeBytes ?? 0), 0),
      activeCount: allEvidence.filter((e) => e.status === 'ACTIVE').length,
    };

    // Store summary as structured log entry (visible in dashboard)
    console.log(
      JSON.stringify({
        level: 'info',
        time: new Date().toISOString(),
        msg: `Evidence post-processed for audit run ${auditRunId}`,
        auditRunId,
        evidenceBundleId,
        evidenceSummary,
      })
    );
  });
}

