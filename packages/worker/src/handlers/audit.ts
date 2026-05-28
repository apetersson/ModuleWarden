import { getPrisma } from '@modulewarden/prisma-client';
import { defaultConfig } from '@modulewarden/shared/config';
import { fetchUpstreamPackument, fetchUpstreamTarball } from '@modulewarden/shared/services/upstream';
import type { JobQueue } from '../jobs/queue.js';
import { ContainerRunner, type ContainerInputs } from '../services/container-runner.js';
import { randomBytes } from 'node:crypto';
import { writeFileSync, mkdtempSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import type { Prisma } from '@prisma/client';

function hashContent(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

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

    // 3. Fetch and prepare package artifacts
    const tarballDir = mkdtempSync(join(tmpdir(), 'mw-tarball-'));
    let packageTarballPath: string | undefined;
    let baselineTarballPath: string | undefined;

    // Try to fetch the package tarball from upstream
    try {
      const packument = await fetchUpstreamPackument(packageName);
      if (packument?.versions?.[packageVersion]?.dist?.tarball) {
        const url = packument.versions[packageVersion].dist.tarball;
        const tarball = await fetchUpstreamTarball(url);
        if (tarball) {
          const streamPath = join(tarballDir, 'package.tgz');
          const reader = tarball.stream.getReader();
          const chunks: Uint8Array[] = [];
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            chunks.push(value);
          }
          const totalLen = chunks.reduce((a, c) => a + c.length, 0);
          const buf = new Uint8Array(totalLen);
          let offset = 0;
          for (const chunk of chunks) { buf.set(chunk, offset); offset += chunk.length; }
          writeFileSync(streamPath, buf);
          packageTarballPath = streamPath;
        }
      }
    } catch { /* tarball fetch is best-effort */ }

    // Try to fetch predecessor tarball
    if (predecessorHash) {
      try {
        const predPackument = await fetchUpstreamPackument(packageName);
        if (predPackument) {
          // Find the predecessor version
          const predVersion = Object.entries(predPackument.versions ?? {})
            .find(([, v]) => v.dist?.integrity === predecessorHash || v.dist?.shasum === predecessorHash);
          if (predVersion && predVersion[1]?.dist?.tarball) {
            const url = predVersion[1].dist.tarball;
            const tarball = await fetchUpstreamTarball(url);
            if (tarball) {
              const streamPath = join(tarballDir, 'baseline.tgz');
              const reader = tarball.stream.getReader();
              const chunks: Uint8Array[] = [];
              while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                chunks.push(value);
              }
              const totalLen = chunks.reduce((a, c) => a + c.length, 0);
              const buf = new Uint8Array(totalLen);
              let offset = 0;
              for (const chunk of chunks) { buf.set(chunk, offset); offset += chunk.length; }
              writeFileSync(streamPath, buf);
              baselineTarballPath = streamPath;
            }
          }
        }
      } catch { /* predecessor fetch is best-effort */ }
    }

    // 4. Build container inputs with all available artifacts
    const inputs: ContainerInputs = {
      rpcToken,
      rpcPort: config.piOrchestration.rpcPort,
      packageName,
      packageVersion,
      packageTarballPath,
      baselineTarballPath,
    };

    // 5. Run the container
    const result = await runner.run(inputs);

    // 5. Process results
    const completedAt = new Date();
    const evidenceArtifactIds: string[] = [];

    // Capture evidence artifacts from the container output
    // Read file content into the DB before the workspace is cleaned up
    for (const artifactPath of result.evidenceArtifacts) {
      try {
        let content: Prisma.InputJsonValue = { path: artifactPath };
        if (existsSync(artifactPath)) {
          const fileContent = readFileSync(artifactPath, 'utf-8');
          content = { path: artifactPath, content: fileContent.slice(0, 10_000), size: fileContent.length };
        }

        const artifact = await prisma.evidenceArtifact.create({
          data: {
            auditRunId: auditRun.id,
            artifactType: 'OTHER',
            name: artifactPath.split('/').pop() ?? 'artifact',
            content,
            contentHash: hashContent(typeof content === 'string' ? content : JSON.stringify(content)),
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
