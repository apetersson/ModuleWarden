import { getPrisma } from '@modulewarden/prisma-client';
import type { JobQueue } from '../jobs/queue.js';

/**
 * Register the model escalation handler.
 *
 * TASK-1.16 requires escalation jobs to exist in the durable
 * orchestration graph. v1 currently records the escalation request as a
 * provenance action so operators can see when model re-evaluation was
 * triggered.
 */
export async function registerModelEscalationHandler(queue: JobQueue): Promise<void> {
  await queue.work('model-escalation', async (job) => {
    const { reviewJobId, evidenceBundleId } = job.data;
    const prisma = getPrisma();

    const evidence = await prisma.evidenceArtifact.findUnique({
      where: { id: evidenceBundleId },
      select: {
        id: true,
        auditRun: {
          select: {
            id: true,
            status: true,
            reviewJobId: true,
          },
        },
      },
    });

    if (!evidence) {
      throw new Error(`Evidence artifact ${evidenceBundleId} not found for escalation`);
    }

    if (evidence.auditRun.reviewJobId !== reviewJobId) {
      throw new Error(`Escalation job ${reviewJobId} does not own evidence ${evidenceBundleId}`);
    }

    const decision = await prisma.decision.findFirst({
      where: { reviewJobId },
      select: { id: true },
      orderBy: { createdAt: 'desc' },
    });

    if (!decision) {
      throw new Error(`No decision exists for review job ${reviewJobId}; cannot record escalation evidence`);
    }

    await prisma.evaluationLabel.create({
      data: {
        decisionId: decision.id,
        evidenceArtifactId: evidenceBundleId,
        labelType: 'EVALUATION_RESULT',
        labelValue: 'model_escalation_requested',
        labelDescription: `Escalation queued for review job ${reviewJobId}; audit run ${evidence.auditRun.id} status ${evidence.auditRun.status}`,
        labeledBy: 'system',
      },
    });
  });
}

