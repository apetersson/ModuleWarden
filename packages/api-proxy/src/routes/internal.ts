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
import { fetchUpstreamPackument } from '@modulewarden/shared/services/upstream';
import { shouldEscalateVerdict } from '../services/escalation.js';
import type { PredecessorDiffResponse, WebSearchResponse } from '@modulewarden/shared/services/rpc-tools';
import { createHash } from 'node:crypto';

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
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

/**
 * Register internal API routes used by the audit RPC bridge.
 * Routes are registered inside a scoped plugin so that the auth hook
 * only applies to /internal/* paths (C-1).
 */
export async function registerInternalRoutes(app: FastifyInstance): Promise<void> {
  await app.register(async function internalScope(scoped: FastifyInstance) {
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

      const prisma = getPrisma();

      // Semver-aware predecessor: find the highest version < current
      const allVersions = await prisma.packageVersion.findMany({
        where: { packageName, registrySource: 'npm' },
        select: { version: true, tarballHash: true },
      });

      // Parse any semver string (including pre-release) into comparable parts.
      // Strips 'v' prefix and pre-release suffix for numeric comparison.
      function parseSemver(v: string): { major: number; minor: number; patch: number; preRelease: string | null } {
        const cleaned = v.replace(/^[vV]/, '');
        const preReleaseMatch = cleaned.match(/-([a-zA-Z0-9.]+)/);
        const preRelease = preReleaseMatch ? preReleaseMatch[1] : null;
        const matchIdx = preReleaseMatch?.index;
        const numeric = preRelease != null && matchIdx != null ? cleaned.slice(0, matchIdx) : cleaned;
        const parts = numeric.split('.').map(Number);
        while (parts.length < 3) parts.push(0);
        return { major: parts[0] ?? 0, minor: parts[1] ?? 0, patch: parts[2] ?? 0, preRelease };
      }

      function semverLt(a: string, b: string): boolean {
        const pa = parseSemver(a);
        const pb = parseSemver(b);
        if (pa.major !== pb.major) return pa.major < pb.major;
        if (pa.minor !== pb.minor) return pa.minor < pb.minor;
        if (pa.patch !== pb.patch) return pa.patch < pb.patch;
        // Same numeric version — pre-release versions are lower than release
        // e.g., 1.0.0-rc.1 < 1.0.0 (M-1)
        if (pa.preRelease && !pb.preRelease) return true;
        if (!pa.preRelease && pb.preRelease) return false;
        return false;
      }

      const predecessors = allVersions
        .filter((v) => semverLt(v.version, version))
        .sort((a, b) => semverLt(a.version, b.version) ? 1 : -1);

      const predecessorPv = predecessors[0] ?? null;

      if (!predecessorPv) {
        return reply.send({
          hasPredecessor: false,
          fileDiff: { added: [], removed: [], changed: [], totalAddedBytes: 0, totalRemovedBytes: 0 },
          dependencyDiff: { added: {}, removed: {}, changed: {} },
          lifecycleScriptDiff: { added: [], removed: [], changed: [] },
          capabilityDelta: [],
        } satisfies PredecessorDiffResponse);
      }

      return reply.send({
        hasPredecessor: true,
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
        if (!sources || sources.includes('npm')) {
          try {
            const packument = await fetchUpstreamPackument(query);
            if (packument) {
              results.push({
                title: `${packument.name} — npm registry`,
                url: `https://www.npmjs.com/package/${query}`,
                snippet: packument.description ?? `Package ${query} on npm`,
                source: 'npm',
              });
            }
          } catch { /* ignore */ }
        }

        if (!sources || sources.includes('advisories')) {
          try {
            const resp = await fetch(
              `https://registry.npmjs.org/-/npm/v1/security/advisories?package=${encodeURIComponent(query)}`
            );
            if (resp.ok) {
              const advisoryData = await resp.json() as { data?: Array<{ title: string; url: string; severity: string }> };
              for (const adv of advisoryData?.data ?? []) {
                results.push({
                  title: `[${adv.severity}] ${adv.title}`,
                  url: adv.url,
                  snippet: `Security advisory for ${query}`,
                  source: 'npm-advisory',
                });
              }
            }
          } catch { /* ignore */ }
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
      const { verdict, riskSummary, scores, piSessionId } = request.body;
      if (!verdict) return reply.status(400).send({ error: 'Missing verdict' });

      const prisma = getPrisma();
      const auditRunId = (request as any).auditRunId as string;
      const reviewJobId = (request as any).reviewJobId as string;

      const reviewJob = await prisma.reviewJob.findUnique({
        where: { id: reviewJobId },
        select: { packageVersionId: true, id: true, status: true },
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
          verdict: verdict.toUpperCase() as 'ALLOW' | 'BLOCK' | 'QUARANTINE',
          reasonSummary: riskSummary,
          actorType: 'AGENT',
          piSessionId: piSessionId ?? null,
          scores: scores as object,
        },
        select: { id: true },
      });

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
        } catch { /* best-effort */ }
      }

      return reply.status(201).send({ decisionId: decision.id, success: true, needsEscalation });
    });
  }); // end internalScope plugin
}
