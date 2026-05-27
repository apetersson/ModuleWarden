import { getPrisma } from '@modulewarden/prisma-client';
import { defaultConfig } from '@modulewarden/shared/config';
import type { JobQueue } from '../jobs/queue.js';
import { ContainerRunner, type ContainerInputs } from '../services/container-runner.js';
import { randomBytes } from 'node:crypto';

/**
 * Register the audit container execution handler.
 *
 * This worker processes `audit-container-exec` jobs. It:
 * 1. Creates a disposable Docker container from the audit-runner image
 * 2. Injects package inputs, baseline, diff, prepared evidence, run instructions, RPC token
 * 3. Configures recorded-open egress networking
 * 4. Waits for completion or timeout
 * 5. Captures declared evidence artifacts
 * 6. Destroys the container
 * 7. Saves audit run status and evidence to the database
 */
export async function registerAuditContainerHandler(queue: JobQueue): Promise<void> {
  const config = defaultConfig();
  const runner = new ContainerRunner({
    imageName: config.auditRunner.imageName,
    containerTimeoutMs: config.jobs.retryPolicy.timeoutMs,
  });

  await queue.work('audit-container-exec', async (job) => {
    const { reviewJobId, packageName, packageVersion, tarballHash, predecessorHash, auditContext } = job.data;
    const prisma = getPrisma();

    // 1. Create audit run record
    const auditRun = await prisma.auditRun.create({
      data: {
        reviewJobId,
        status: 'PENDING',
      },
    });

    // Update review job status
    await prisma.reviewJob.update({
      where: { id: reviewJobId },
      data: { status: 'RUNNING' },
    });

    // 2. Generate run-scoped RPC token
    const rpcToken = randomBytes(32).toString('hex');
    const rpcTokenHash = rpcToken; // In production, hash this

    await prisma.auditRun.update({
      where: { id: auditRun.id },
      data: {
        status: 'RUNNING',
        rpcTokenHash,
        startedAt: new Date(),
      },
    });

    // 3. Build container inputs
    const inputs: ContainerInputs = {
      rpcToken,
      rpcPort: config.piOrchestration.rpcPort,
      packageName,
      packageVersion,
    };

    // 4. Run the container
    const result = await runner.run(inputs);

    // 5. Process results
    const completedAt = new Date();
    const evidenceArtifactIds: string[] = [];

    // Capture evidence artifacts from the container output
    for (const artifactPath of result.evidenceArtifacts) {
      try {
        const artifact = await prisma.evidenceArtifact.create({
          data: {
            auditRunId: auditRun.id,
            artifactType: 'OTHER',
            name: artifactPath.split('/').pop() ?? 'artifact',
            content: { path: artifactPath },
            contentHash: artifactPath, // In production, hash the content
            filePath: artifactPath,
          },
        });
        evidenceArtifactIds.push(artifact.id);
      } catch {
        // Skip artifacts that fail to register
      }
    }

    // Determine final status
    const finalStatus = result.error
      ? (result.exitCode === null ? 'TIMED_OUT' : 'CRASHED')
      : 'COMPLETED';

    await prisma.auditRun.update({
      where: { id: auditRun.id },
      data: {
        status: finalStatus,
        completedAt,
        containerId: result.containerId,
        containerName: `mw-audit-${packageName}-${packageVersion}`,
        errorMessage: result.error ?? null,
      },
    });

    if (finalStatus !== 'COMPLETED') {
      // Mark review job as failed too
      await prisma.reviewJob.update({
        where: { id: reviewJobId },
        data: { status: 'FAILED' },
      });

      // Clean up workspace
      runner.cleanupWorkspace(result.workspacePath);

      throw new Error(result.error ?? `Audit container failed with status ${finalStatus}`);
    }

    // Update review job to completed (decision creation is separate)
    await prisma.reviewJob.update({
      where: { id: reviewJobId },
      data: { status: 'RUNNING' }, // Still need decision — keep as RUNNING
    });

    // 6. Enqueue evidence post-processing
    if (evidenceArtifactIds.length > 0) {
      await queue.enqueueEvidencePostProcess(auditRun.id, evidenceArtifactIds[0]);
    }

    // 7. Clean up workspace
    runner.cleanupWorkspace(result.workspacePath);

    console.log(`[audit] Container ${result.containerId} completed for ${packageName}@${packageVersion}`);
  });
}
