/**
 * Internal API endpoints for the audit RPC bridge.
 * Called by the in-container RPC bridge server (not external clients).
 *
 * All routes are scoped to a Fastify plugin so the auth hook does NOT
 * apply to other routes (packument, tarball, admin, status, health).
 * Auth uses per-run token lookup against AuditRun.rpcTokenHash.
 */

import type { FastifyInstance } from 'fastify';
import { getPrisma } from '@modulewarden/prisma-client';
import { defaultConfig } from '@modulewarden/shared/config';
import { logger } from '@modulewarden/shared/services/logger';
import { fetchUpstreamPackument } from '@modulewarden/shared/services/upstream';
import { shouldEscalateVerdict } from '../services/escalation.js';
import type { PredecessorDiffResponse, WebSearchResponse } from '@modulewarden/shared/services/rpc-tools';
import type { JobQueue } from '@modulewarden/worker/jobs/queue.js';
import { createHash } from 'node:crypto';

type QueueProvider = () => Promise<JobQueue | null | undefined>;

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function normalizeVerdictBody(body: Record<string, unknown>): {
  verdict: 'ALLOW' | 'BLOCK' | 'QUARANTINE' | null;
  riskSummary: string;
  scores: Record<string, number>;
  piSessionId?: string;
  promptPackVersion?: string;
} {
  const rawVerdict = body.verdict ?? body.decision;
  const verdict = typeof rawVerdict === 'string'
    ? rawVerdict.toUpperCase()
    : '';
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
 * Look up the AuditRun associated with a given RPC token.
 * Validates the token against stored rpcTokenHash.
 */
async function findAuditRunByToken(token: string): Promise<{ id: string; reviewJobId: string } | null> {
  const prisma = getPrisma();
  const tokenHash = hashToken(token);
  return prisma.auditRun.findFirst({
    where: { rpcTokenHash: tokenHash, status: 'RUNNING' },
    select: { id: true, reviewJobId: true },
  });
}

function addSearchResult(
  results: WebSearchResponse['results'],
  seenUrls: Set<string>,
  result: WebSearchResponse['results'][number]
): void {
  const key = result.url.trim();
  if (!key || seenUrls.has(key)) return;
  seenUrls.add(key);
  results.push(result);
}

async function searchSearxng(query: string): Promise<WebSearchResponse['results']> {
  const config = defaultConfig();
  if (config.search.provider === 'disabled') return [];

  const url = new URL('/search', config.search.searxngUrl);
  url.searchParams.set('q', query);
  url.searchParams.set('format', 'json');
  url.searchParams.set('language', 'en');
  url.searchParams.set('safesearch', '1');

  const response = await fetch(url, {
    headers: {
      Accept: 'application/json',
      'User-Agent': 'ModuleWarden/0.1 audit-search',
    },
  });
  if (!response.ok) {
    throw new Error(`SearXNG returned ${response.status}`);
  }

  const body = await response.json() as {
    results?: Array<{
      title?: string;
      url?: string;
      content?: string;
      engine?: string;
    }>;
  };

  return (body.results ?? [])
    .filter((item) => item.url)
    .slice(0, 10)
    .map((item) => ({
      title: item.title ?? item.url ?? 'Search result',
      url: item.url ?? '',
      snippet: item.content ?? '',
      source: item.engine ? `searxng:${item.engine}` : 'searxng',
    }));
}

/**
 * Register internal API routes used by the audit RPC bridge.
 * Routes are registered inside a scoped plugin so that the auth hook
 * only applies to /internal/* paths (C-1).
 */
export async function registerInternalRoutes(app: FastifyInstance, queueProvider?: QueueProvider): Promise<void> {
  async function resolveQueue(): Promise<JobQueue | null> {
    if (!queueProvider) return null;
    try {
      return (await queueProvider()) ?? null;
    } catch (err) {
      logger.warn('Failed to resolve job queue for internal route side effect', {
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
  }

  await app.register(async function internalScope(scoped: FastifyInstance) {
    // Routes inside this plugin get /internal/ prefix via app.register's prefix option
    // ── Auth middleware (scoped to /internal/* only) ──────────
    // Validates the Bearer token against AuditRun.rpcTokenHash
    // so each run has a unique, verifiable token (C-2, C-3, H-3).

    scoped.addHook('onRequest', async (request, reply) => {
      const token = request.headers['authorization']?.replace(/^Bearer\s+/i, '');
      if (!token) {
        reply.status(401).send({ error: 'Authorization required' });
        return;
      }
      const auditRun = await findAuditRunByToken(token);
      if (!auditRun) {
        reply.status(401).send({ error: 'Invalid or expired RPC token' });
        return;
      }
      // Attach the audit run ID to the request for downstream use
      (request as any).auditRunId = auditRun.id;
      (request as any).reviewJobId = auditRun.reviewJobId;
    });

    // ── GET /internal/predecessor-diff ──────────────────────────

    scoped.get<{
      Querystring: { package: string; version: string; hash: string };
    }>('/predecessor-diff', async (request, reply) => {
      const { package: packageName, version, hash } = request.query;
      if (!packageName || !version || !hash) {
        return reply.status(400).send({ error: 'Missing required query params: package, version, hash' });
      }

      // L-1: Predecessor diff computation not yet implemented.
      // Return hasPredecessor=false so PI applies cold-start conservative standards
      // instead of believing it has predecessor context.
      // Once actual tarball diff computation is implemented, remove this override.
      return reply.send({
        hasPredecessor: false,
        fileDiff: { added: [], removed: [], changed: [], totalAddedBytes: 0, totalRemovedBytes: 0 },
        dependencyDiff: { added: {}, removed: {}, changed: {} },
        lifecycleScriptDiff: { added: [], removed: [], changed: [] },
        capabilityDelta: [],
      } satisfies PredecessorDiffResponse);
    });

    // ── POST /internal/web-search ───────────────────────────────

    scoped.post<{ Body: { query: string; sources?: string[] } }>(
      '/web-search', async (request, reply) => {
        const { query, sources } = request.body;
        if (!query) return reply.status(400).send({ error: 'Missing query' });

        const results: WebSearchResponse['results'] = [];
        const seenUrls = new Set<string>();

        if (!sources || sources.includes('web') || sources.includes('searxng')) {
          try {
            for (const result of await searchSearxng(query)) {
              addSearchResult(results, seenUrls, result);
            }
          } catch (err) {
            logger.warn('SearXNG search failed', { query, error: err instanceof Error ? err.message : String(err) });
          }
        }

        if (!sources || sources.includes('npm')) {
          try {
            const packument = await fetchUpstreamPackument(query);
            if (packument) {
              addSearchResult(results, seenUrls, {
                title: `${packument.name} — npm registry`,
                url: `https://www.npmjs.com/package/${query}`,
                snippet: packument.description ?? `Package ${query} on npm`,
                source: 'npm',
              });
            }
          } catch (err) {
            logger.warn('Web search upstream fetch failed', { query, error: err instanceof Error ? err.message : String(err) });
          }
        }

        if (!sources || sources.includes('advisories')) {
          try {
            const resp = await fetch(
              `https://registry.npmjs.org/-/npm/v1/security/advisories?package=${encodeURIComponent(query)}`
            );
            if (resp.ok) {
              const advisoryData = await resp.json() as { data?: Array<{ title: string; url: string; severity: string }> };
              for (const adv of advisoryData?.data ?? []) {
                addSearchResult(results, seenUrls, {
                  title: `[${adv.severity}] ${adv.title}`,
                  url: adv.url,
                  snippet: `Security advisory for ${query}`,
                  source: 'npm-advisory',
                });
              }
            }
          } catch (err) {
            logger.warn('Web search advisory fetch failed', { query, error: err instanceof Error ? err.message : String(err) });
          }

          try {
            const resp = await fetch('https://api.osv.dev/v1/query', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                package: {
                  name: query,
                  ecosystem: 'npm',
                },
              }),
            });
            if (resp.ok) {
              const osvData = await resp.json() as {
                vulns?: Array<{
                  id: string;
                  summary?: string;
                  details?: string;
                  aliases?: string[];
                  database_specific?: { severity?: string };
                  references?: Array<{ url?: string }>;
                }>;
              };
              for (const vuln of osvData.vulns ?? []) {
                addSearchResult(results, seenUrls, {
                  title: `[${vuln.database_specific?.severity ?? 'UNKNOWN'}] ${vuln.summary ?? vuln.id}`,
                  url: vuln.references?.find((ref) => ref.url)?.url ?? `https://osv.dev/vulnerability/${vuln.id}`,
                  snippet: [
                    vuln.aliases?.length ? `Aliases: ${vuln.aliases.join(', ')}` : '',
                    vuln.details ?? vuln.summary ?? `OSV advisory for ${query}`,
                  ].filter(Boolean).join(' — ').slice(0, 1000),
                  source: 'osv',
                });
              }
            }
          } catch (err) {
            logger.warn('OSV advisory fetch failed', { query, error: err instanceof Error ? err.message : String(err) });
          }
        }

        return reply.send({ results } satisfies WebSearchResponse);
      }
    );

    // ── POST /internal/evidence ─────────────────────────────────

    scoped.post<{ Body: { label: string; description: string; type: string } }>(
      '/evidence', async (request, reply) => {
        const { label, description } = request.body;
        if (!label) return reply.status(400).send({ error: 'Missing label' });

        const prisma = getPrisma();
        const auditRunId = (request as any).auditRunId as string;

        const artifactType = request.body.type === 'static-analysis' ? 'DIFF_SUMMARY'
          : request.body.type === 'sandbox-trace' ? 'SANDBOX_INSTALL_TRACE'
          : request.body.type === 'web-search' ? 'CHANGELOG_CONTEXT'
          : 'CAPABILITY_DELTA' as const;

        const evidence = await prisma.evidenceArtifact.create({
          data: {
            auditRunId,
            artifactType,
            name: label,
            content: { description, source: 'audit-rpc' },
            // ⚠️ STUB: contentHash is a timestamp, not a true hash of evidence content.
            // This is acceptable for v1 provenance tracking but does NOT provide
            // content-integrity guarantees (evidence-integrity framing).
            // TODO: Replace with real SHA-256 hash of serialized evidence content.
            contentHash: `sha256-${Date.now()}`,
            filePath: label.replace(/[^a-zA-Z0-9_-]/g, '_'),
          },
          select: { id: true },
        });

        return reply.status(201).send({ evidenceId: evidence.id, success: true });
      }
    );

    // ── POST /internal/verdict ──────────────────────────────────

    scoped.post<{
      Body: {
        verdict: string;
        riskSummary: string;
        scores: Record<string, number>;
        piSessionId?: string;
        promptPackVersion?: string;
      };
    }>('/verdict', async (request, reply) => {
      const { verdict, riskSummary, scores, piSessionId, promptPackVersion } = normalizeVerdictBody(request.body as Record<string, unknown>);
      if (!verdict) return reply.status(400).send({ error: 'Missing verdict' });

      const prisma = getPrisma();
      const auditRunId = (request as any).auditRunId as string;
      const reviewJobId = (request as any).reviewJobId as string;

      const reviewJob = await prisma.reviewJob.findUnique({
        where: { id: reviewJobId },
        select: {
          packageVersionId: true, id: true, status: true,
          packageVersion: {
            select: { packageName: true, version: true, tarballHash: true },
          },
        },
      });

      if (!reviewJob) {
        return reply.status(404).send({ error: 'Review job not found', success: false });
      }

      if (reviewJob.status === 'COMPLETED') {
        return reply.status(409).send({ error: 'Review job already completed', success: false });
      }

      const decision = await prisma.decision.create({
        data: {
          reviewJobId: reviewJob.id,
          packageVersionId: reviewJob.packageVersionId,
          verdict,
          reasonSummary: riskSummary,
          actorType: 'AGENT',
          piSessionId: piSessionId ?? null,
          promptVersion: promptPackVersion ?? null,
          scores: scores,
        },
        select: { id: true },
      });

      // A-4: Enqueue verdaccio promotion when verdict is ALLOW
      const queue = await resolveQueue();
      if (verdict === 'ALLOW' && queue && reviewJob.packageVersion) {
        const { packageName, version: pkgVersion, tarballHash } = reviewJob.packageVersion;
        try {
          await queue.send('verdaccio-promotion', {
            decisionId: decision.id,
            packageName,
            packageVersion: pkgVersion,
            tarballHash,
          });
          logger.info('Promotion enqueued for ALLOWed package', { packageName, packageVersion: pkgVersion });
        } catch (err) {
          logger.warn('Failed to enqueue promotion', {
            packageName,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }

      // Cascade to pipeline regardless of verdict — if this ReviewJob
      // belongs to a pipeline step, enqueue audit-pipeline-unblock so
      // BLOCKED/QUARANTINED verdicts cascade downstream too.
      if (queue && reviewJob) {
        try {
          const step = await prisma.auditPipelineStep.findFirst({
            where: { reviewJobId: reviewJob.id },
            select: { id: true, pipelineId: true, packageName: true, packageVersion: true },
          });
          if (step) {
            await queue.send('audit-pipeline-unblock', {
              pipelineId: step.pipelineId,
              stepId: step.id,
              packageName: step.packageName,
              packageVersion: step.packageVersion,
            });
          }
        } catch (pipelineErr) {
          logger.warn('Failed to enqueue pipeline unblock from verdict endpoint', {
            reviewJobId: reviewJob.id,
            error: pipelineErr instanceof Error ? pipelineErr.message : String(pipelineErr),
          });
        }
      }

      await prisma.auditRun.update({
        where: { id: auditRunId },
        data: { status: 'COMPLETED', completedAt: new Date() },
      });

      await prisma.reviewJob.update({
        where: { id: reviewJob.id },
        data: { status: 'COMPLETED' },
      });

      // Check if escalation is warranted
      const needsEscalation = shouldEscalateVerdict(verdict, scores, riskSummary);
      if (needsEscalation) {
        try {
          await prisma.evaluationLabel.create({
            data: {
              decisionId: decision.id,
              labelType: 'EVALUATION_RESULT',
              labelValue: 'escalation_recommended',
              labelDescription: `Escalation recommended for ${verdict} verdict: ${riskSummary.slice(0, 200)}`,
              labeledBy: 'system',
            },
          });

          // L-5: Enqueue actual model-escalation job for second-pass review
          if (queue && reviewJob.packageVersion) {
            await queue.send('model-escalation', {
              reviewJobId: reviewJob.id,
              evidenceBundleId: auditRunId, // Use auditRunId as evidence bundle identifier
            });
            logger.info('Model escalation enqueued', { reviewJobId: reviewJob.id });
          }
        } catch (err) {
            logger.warn('Failed to process escalation', {
              decisionId: decision.id,
              error: err instanceof Error ? err.message : String(err),
            });
          }
      }

      return reply.status(201).send({ decisionId: decision.id, success: true, needsEscalation });
    });
  }, { prefix: '/internal' }); // end internalScope plugin
}
