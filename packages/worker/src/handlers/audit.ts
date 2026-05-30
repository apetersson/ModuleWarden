import { getPrisma } from '@modulewarden/prisma-client';
import { defaultConfig } from '@modulewarden/shared/config';
import { logger } from '@modulewarden/shared/services/logger';
import { fetchUpstreamPackument, fetchUpstreamTarball } from '@modulewarden/shared/services/upstream';
import type { JobQueue } from '../jobs/queue.js';
import { ContainerRunner, type ContainerInputs } from '../services/container-runner.js';
import { assembleAuditInstructions, buildContainerInstructionFile } from '../services/prompt-pack.js';
import { randomBytes, createHash } from 'node:crypto';
import { writeFileSync, mkdtempSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { Prisma } from '@modulewarden/prisma-client';
import { buildEvidenceBundle } from '@modulewarden/shared/services/evidence-bundle';
import type { CapabilityCategory } from '@modulewarden/shared/services/capability-extract';
import { triggerPipelineUnblock } from './pipeline.js';

function hashContent(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

function normalizeVerdictFile(value: unknown): {
  verdict: 'ALLOW' | 'BLOCK' | 'QUARANTINE' | null;
  riskSummary: string;
  scores: Record<string, number>;
  piSessionId?: string;
  promptPackVersion?: string;
} {
  const body = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  const rawVerdict = body.verdict ?? body.decision;
  const verdict = typeof rawVerdict === 'string' ? rawVerdict.toUpperCase() : '';
  const scores = body.scores && typeof body.scores === 'object' && !Array.isArray(body.scores)
    ? body.scores as Record<string, number>
    : {};
  return {
    verdict: verdict === 'ALLOW' || verdict === 'BLOCK' || verdict === 'QUARANTINE' ? verdict : null,
    riskSummary: typeof body.riskSummary === 'string'
      ? body.riskSummary
      : typeof body.reasonSummary === 'string'
        ? body.reasonSummary
        : '',
    scores,
    ...(typeof body.piSessionId === 'string' ? { piSessionId: body.piSessionId } : {}),
    ...(typeof body.promptPackVersion === 'string' ? { promptPackVersion: body.promptPackVersion } : {}),
  };
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
    modelEndpoint: config.modelEndpoint,
    containerTimeoutMs: config.jobs.retryPolicy.timeoutMs,
    ...(config.auditRunner.workspaceRoot ? { workspaceRoot: config.auditRunner.workspaceRoot } : {}),
  });

  await queue.work('audit-container-exec', async (job) => {
    const { reviewJobId, packageName, packageVersion, tarballHash, predecessorHash } = job.data;
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

    // 2. Generate run-scoped RPC token, hash before storing (C-3)
    const rpcToken = randomBytes(32).toString('hex');
    const rpcTokenHash = createHash('sha256').update(rpcToken).digest('hex');

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
      const packageDist = packument?.versions?.[packageVersion]?.dist;
      if (packageDist?.tarball) {
        const tarball = await fetchUpstreamTarball(packageDist.tarball);
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
    } catch (err) {
      logger.warn('Tarball fetch failed (best-effort)', { packageName, packageVersion, error: err instanceof Error ? err.message : String(err) });
    }

    // Try to fetch predecessor tarball
    if (predecessorHash) {
      try {
        const predPackument = await fetchUpstreamPackument(packageName);
        if (predPackument) {
          // Find the predecessor version
          const predVersion = Object.entries(predPackument.versions ?? {})
            .find(([, v]) => v.dist?.integrity === predecessorHash || v.dist?.shasum === predecessorHash);
          if (predVersion?.[1]?.dist?.tarball) {
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
      } catch (err) {
        logger.warn('Predecessor fetch failed (best-effort)', { error: err instanceof Error ? err.message : String(err) });
      }
    }

    // 4. Extract git metrics if not already cached (best-effort, non-blocking)
    try {
      const packument = await fetchUpstreamPackument(packageName);
      const repoField = (packument as Record<string, unknown> | null)?.repository as { url?: string } | undefined;
      const versionRepo = (packument?.versions?.[packageVersion] as Record<string, unknown> | undefined)?.repository as { url?: string } | undefined;
      const repoUrl = repoField?.url ?? versionRepo?.url ?? null;
      if (repoUrl) {
        const { GitMetricExtractor } = await import('../services/git-metric-extractor.js');
        const extractor = new GitMetricExtractor();
        await extractor.extractIfNeeded(packageName, packageVersion, repoUrl);
      }
    } catch (err) {
      logger.warn('Git metric extraction failed (best-effort)', {
        packageName,
        packageVersion,
        error: err instanceof Error ? err.message : String(err),
      });
    }

    // 5. Run temporal forecast (Sybillion time-series, blocking)
    let temporalEvidence: Awaited<ReturnType<typeof import('../services/temporal-forecast-runner.js')['runTemporalForecast']>> = null;
    try {
      const { runTemporalForecast } = await import('../services/temporal-forecast-runner.js');
      temporalEvidence = await runTemporalForecast(packageName, packageVersion, {
        sybillionToken: process.env.SYBILION_API_TOKEN ?? '',
        sybillionBaseUrl: process.env.SYBILION_API_BASE_URL ?? 'https://api.sybilion.dev',
        pollIntervalMs: parseInt(process.env.SYBILION_POLL_INTERVAL_MS ?? '10000', 10),
        forecastTimeoutMs: parseInt(process.env.SYBILION_FORECAST_TIMEOUT_MS ?? '600000', 10),
        enabled: (process.env.TEMPORAL_FORECAST_ENABLED ?? 'true') !== 'false',
      });

      if (temporalEvidence) {
        // Store temporal_evidence as a DB evidence artifact so the audit
        // container and downstream consumers can read it.
        await prisma.evidenceArtifact.create({
          data: {
            auditRunId: auditRun.id,
            artifactType: 'OTHER',
            name: 'temporal_evidence.json',
            content: temporalEvidence as unknown as Prisma.InputJsonValue,
            contentHash: hashContent(JSON.stringify(temporalEvidence)),
          },
        });

        logger.info('Temporal forecast evidence stored', {
          packageName,
          packageVersion,
          temporalRisk: temporalEvidence.temporal_risk,
        });
      }
    } catch (err) {
      logger.warn('Temporal forecast failed, proceeding without temporal signal', {
        packageName,
        packageVersion,
        error: err instanceof Error ? err.message : String(err),
      });
    }

    // 6. Build required prompt-pack instructions. Audits must be driven by
    // configured prompt packs; missing prompt configuration is a hard failure.
    const emptyCapabilitySummary = Object.fromEntries(
      ([
        'network',
        'filesystem',
        'process',
        'dynamic-code',
        'env-credential',
        'native-wasm',
        'obfuscation',
        'dependency-indirection',
        'install-time',
      ] satisfies CapabilityCategory[]).map((category) => [category, 'none'])
    ) as Record<CapabilityCategory, 'none'>;
    const bundle = buildEvidenceBundle({
      packageName,
      version: packageVersion,
      predecessorVersion: null,
      tarballHash,
      dependencyDiff: { added: {}, removed: {}, changed: {} },
      lifecycleScriptDiff: { scripts: [] },
      capabilityReport: { findings: [], summary: emptyCapabilitySummary },
      intentEvidence: { mismatchIndicators: [] },
    });
    let instructions: Awaited<ReturnType<typeof assembleAuditInstructions>>;
    try {
      instructions = await assembleAuditInstructions(bundle, null);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await prisma.auditRun.update({
        where: { id: auditRun.id },
        data: { status: 'CRASHED', completedAt: new Date(), errorMessage: message },
      });
      await prisma.reviewJob.update({
        where: { id: reviewJobId },
        data: { status: 'FAILED' },
      });
      throw err;
    }
    const appliedPromptPackVersions = [
      ...instructions.corePromptVersions,
      ...instructions.patternPromptVersions,
      ...instructions.escalationPromptVersions,
      ...instructions.customPromptNames,
    ];
    const instructionsPath = join(tarballDir, 'instructions.md');
    writeFileSync(instructionsPath, buildContainerInstructionFile(instructions));

    // 5. Build container inputs with all available artifacts
    const inputs: ContainerInputs = {
      auditRunId: auditRun.id,
      rpcToken,
      rpcPort: config.piOrchestration.rpcPort,
      packageName,
      packageVersion,
      instructionsPath,
      ...(packageTarballPath !== undefined ? { packageTarballPath } : {}),
      ...(baselineTarballPath !== undefined ? { baselineTarballPath } : {}),
    };

    // 6. Run the container
    const result = await runner.run(inputs);
    let preservedSessionPath: string | null = null;
    if (config.auditRunner.preserveSessions && config.auditRunner.sessionArchiveRoot) {
      const archiveName = `${auditRun.id}-${packageName}-${packageVersion}`;
      try {
        preservedSessionPath = runner.archiveWorkspace(
          result.workspacePath,
          config.auditRunner.sessionArchiveRoot,
          archiveName
        );
        console.log(`[audit] Preserved audit session for ${packageName}@${packageVersion} at ${preservedSessionPath}`);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.warn(`[audit] Failed to preserve audit session for ${packageName}@${packageVersion}: ${message}`);
      }
    }

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

    if (preservedSessionPath) {
      try {
        const content: Prisma.InputJsonValue = {
          path: preservedSessionPath,
          preservedWorkspace: true,
          note: 'Full audit workspace archived after container exit. Runtime RPC token is redacted in run-config.json.',
        };
        const artifact = await prisma.evidenceArtifact.create({
          data: {
            auditRunId: auditRun.id,
            artifactType: 'OTHER',
            name: 'session-archive',
            content,
            contentHash: hashContent(JSON.stringify(content)),
            filePath: preservedSessionPath,
          },
        });
        evidenceArtifactIds.push(artifact.id);
      } catch {
        // Session archive exists on disk even if DB registration fails.
      }
    }

    // Determine final status
    const finalStatus = result.error
      ? (result.exitCode === null ? 'TIMED_OUT' : 'CRASHED')
      : 'COMPLETED';

    let fallbackDecisionCreated = false;
    let fallbackDecisionId: string | null = null;
    if (finalStatus === 'COMPLETED') {
      const verdictPath = join(result.workspacePath, 'output', 'verdict.json');
      const existingDecision = await prisma.decision.findFirst({
        where: { reviewJobId },
        select: { id: true, promptVersion: true },
        orderBy: { createdAt: 'desc' },
      });
      if (existingDecision && !existingDecision.promptVersion) {
        await prisma.decision.update({
          where: { id: existingDecision.id },
          data: { promptVersion: JSON.stringify(appliedPromptPackVersions) },
        });
      }
      if (!existingDecision && existsSync(verdictPath)) {
        try {
          const parsed = normalizeVerdictFile(JSON.parse(readFileSync(verdictPath, 'utf-8')));
          if (parsed.verdict) {
            const reviewJob = await prisma.reviewJob.findUnique({
              where: { id: reviewJobId },
              select: {
                id: true,
                packageVersionId: true,
                packageVersion: {
                  select: { packageName: true, version: true, tarballHash: true },
                },
              },
            });
            if (reviewJob) {
              const decision = await prisma.decision.create({
                data: {
                  reviewJobId: reviewJob.id,
                  packageVersionId: reviewJob.packageVersionId,
                  verdict: parsed.verdict,
                  reasonSummary: parsed.riskSummary || `Agent submitted ${parsed.verdict} verdict.`,
                  actorType: 'AGENT',
                  piSessionId: parsed.piSessionId ?? null,
                  promptVersion: parsed.promptPackVersion ?? JSON.stringify(appliedPromptPackVersions),
                  scores: parsed.scores,
                },
                select: { id: true },
              });
              fallbackDecisionCreated = true;
              fallbackDecisionId = decision.id;

              if (parsed.verdict === 'ALLOW' && reviewJob.packageVersion) {
                await queue.enqueueVerdaccioPromotion(
                  decision.id,
                  reviewJob.packageVersion.packageName,
                  reviewJob.packageVersion.version,
                  reviewJob.packageVersion.tarballHash
                );
              }

              // Cascade to pipeline: if this ReviewJob is part of an audit
              // pipeline step, trigger pipeline-unblock to check downstream
              await triggerPipelineUnblock(reviewJob.id, parsed.verdict, queue);
            }
          }
        } catch (err) {
          logger.warn('Failed to import verdict.json after audit completion', {
            reviewJobId,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
    }

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

      // O-2: Fire notification webhook for terminal failures
      const webhookUrl = process.env.MW_FAILURE_WEBHOOK_URL;
      if (webhookUrl) {
        try {
          await fetch(webhookUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              event: 'audit_failed',
              packageName,
              packageVersion,
              status: finalStatus,
              error: result.error ?? 'Unknown error',
              reviewJobId,
              auditRunId: auditRun.id,
              timestamp: new Date().toISOString(),
            }),
          });
        } catch (err) {
          logger.warn('Failed to send failure webhook', { error: err instanceof Error ? err.message : String(err) });
        }
      }

      // Clean up workspace
      runner.cleanupWorkspace(result.workspacePath);

      throw new Error(result.error ?? `Audit container failed with status ${finalStatus}`);
    }

    // L-2: Proper state machine transition — transition from RUNNING to finalStatus
    // unless the verdict endpoint already set COMPLETED/FAILED.
    const currentJob = await prisma.reviewJob.findUnique({
      where: { id: reviewJobId },
      select: { status: true },
    });
    if (currentJob?.status === 'RUNNING') {
      await prisma.reviewJob.update({
        where: { id: reviewJobId },
        data: { status: finalStatus },
      });
    }

    // 6. Enqueue evidence post-processing
    const firstEvidenceArtifactId = evidenceArtifactIds[0];
    if (firstEvidenceArtifactId) {
      await queue.enqueueEvidencePostProcess(
        auditRun.id,
        firstEvidenceArtifactId,
        fallbackDecisionCreated && fallbackDecisionId ? fallbackDecisionId : undefined
      );
    }

    // 7. Clean up workspace
    runner.cleanupWorkspace(result.workspacePath);

    console.log(`[audit] Container ${result.containerId} completed for ${packageName}@${packageVersion}`);
  });
}
