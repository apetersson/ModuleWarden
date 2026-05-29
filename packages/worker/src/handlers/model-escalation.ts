import { getPrisma } from '@modulewarden/prisma-client';
import type { JobQueue } from '../jobs/queue.js';

/**
 * Register the model escalation handler.
 *
 * ⚠️ STUB: This handler records an escalation label but does NOT call a
 * second model. The actual escalation to a higher-capability model (e.g.,
 * DeepSeek V4) is not yet implemented.
 *
 * TASK-1.16 requires escalation jobs to exist in the durable
 * orchestration graph. v1 currently records the escalation request as a
 * provenance action so operators can see when model re-evaluation was
 * triggered.
 *
 * TODO: Replace with actual second-model invocation once the model
 * escalation endpoint is finalized.
 */
export async function registerModelEscalationHandler(queue: JobQueue): Promise<void> {
  await queue.work('model-escalation', async (job) => {
    const { reviewJobId, evidenceBundleId } = job.data;
    const prisma = getPrisma();

    // evidenceBundleId is actually an AuditRun ID (passed from internal.ts:392).
    // Skip evidence lookup — this is a provenance-only handler.
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
        labelType: 'EVALUATION_RESULT',
        labelValue: 'model_escalation_requested',
        labelDescription: `Escalation recorded for review job ${reviewJobId} (audit run ${evidenceBundleId}). No second model invoked — this is a provenance-only stub.`,
        labeledBy: 'system',
      },
    });
  });
}

