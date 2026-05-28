/**
 * Internal API endpoints for the audit RPC bridge.
 * Called by the in-container RPC bridge server (not external clients).
 * All endpoints verify the run-scoped RPC token.
 */

import type { FastifyInstance } from 'fastify';
import { getPrisma } from '@modulewarden/prisma-client';
import { fetchUpstreamPackument } from '@modulewarden/shared/services/upstream';
import { shouldEscalateVerdict } from '../services/escalation.js';
import type {
  PredecessorDiffResponse,
  WebSearchResponse,
} from '@modulewarden/shared/services/rpc-tools';

const RPC_TOKEN = process.env.MW_RPC_TOKEN ?? '';

function checkAuth(token: string | undefined): boolean {
  // Fail closed: if no token is configured, reject all internal requests
  if (!RPC_TOKEN) return false;
  return token === RPC_TOKEN;
}

/**
 * Register internal API routes used by the audit RPC bridge.
 */
export async function registerInternalRoutes(app: FastifyInstance): Promise<void> {
  // ── Auth middleware ────────────────────────────────────────

  app.addHook('onRequest', async (request, reply) => {
    const token = request.headers['authorization']?.replace(/^Bearer\s+/i, '');
    if (!checkAuth(token)) {
      reply.status(401).send({ error: 'Invalid or missing RPC token' });
    }
  });

  // ── GET /internal/predecessor-diff ──────────────────────────
  // Returns basic predecessor info. Enhanced by TASK-1.9.

  app.get<{
    Querystring: { package: string; version: string; hash: string };
  }>('/internal/predecessor-diff', async (request, reply) => {
    const { package: packageName, version, hash } = request.query;
    if (!packageName || !version || !hash) {
      return reply.status(400).send({ error: 'Missing required query params: package, version, hash' });
    }

    const prisma = getPrisma();
    const currentPv = await prisma.packageVersion.findFirst({
      where: { packageName, version, registrySource: 'npm', ...(hash ? { tarballHash: hash } : {}) },
      orderBy: { createdAt: 'desc' },
      select: { id: true },
    });

    if (!currentPv) {
      return reply.send({
        hasPredecessor: false,
        fileDiff: { added: [], removed: [], changed: [], totalAddedBytes: 0, totalRemovedBytes: 0 },
        dependencyDiff: { added: {}, removed: {}, changed: {} },
        lifecycleScriptDiff: { added: [], removed: [], changed: [] },
        capabilityDelta: [],
      } satisfies PredecessorDiffResponse);
    }

    // Find predecessor using numeric version comparison to avoid
    // lexicographic ordering issues (e.g., 1.9.0 > 1.10.0 as strings).
    const allVersions = await prisma.packageVersion.findMany({
      where: { packageName, registrySource: 'npm' },
      select: { version: true, tarballHash: true },
    });

    // Semver-aware predecessor: find the highest version < current
    const currentParts = version.split('.').map(Number);
    const predecessors = allVersions
      .filter((v) => {
        const vParts = v.version.split('.').map(Number);
        if (vParts.some(isNaN)) return false; // skip non-numeric versions
        // Compare part by part
        for (let i = 0; i < Math.max(currentParts.length, vParts.length); i++) {
          const cp = currentParts[i] ?? 0;
          const vp = vParts[i] ?? 0;
          if (vp < cp) return true;
          if (vp > cp) return false;
        }
        return false; // equal — not a predecessor
      })
      .sort((a, b) => {
        const aParts = a.version.split('.').map(Number);
        const bParts = b.version.split('.').map(Number);
        for (let i = 0; i < Math.max(aParts.length, bParts.length); i++) {
          const ap = aParts[i] ?? 0;
          const bp = bParts[i] ?? 0;
          if (bp !== ap) return bp - ap;
        }
        return 0;
      });

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
  // Proxies web search requests from the audit container.

  app.post<{ Body: { query: string; sources?: string[] } }>(
    '/internal/web-search', async (request, reply) => {
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
  // Persists evidence artifact from the audit container.

  app.post<{
    Body: { label: string; description: string; type: string };
  }>('/internal/evidence', async (request, reply) => {
    const { label, description } = request.body;

    const prisma = getPrisma();
    const auditRun = await prisma.auditRun.findFirst({
      where: { status: 'RUNNING' },
      orderBy: { createdAt: 'desc' },
      select: { id: true },
    });

    // Map incoming type to EvidenceType enum
    const artifactType = request.body.type === 'static-analysis' ? 'DIFF_SUMMARY'
      : request.body.type === 'sandbox-trace' ? 'SANDBOX_INSTALL_TRACE'
      : request.body.type === 'web-search' ? 'CHANGELOG_CONTEXT'
      : 'CAPABILITY_DELTA' as const;

    const evidence = await prisma.evidenceArtifact.create({
      data: {
        auditRunId: auditRun?.id ?? '00000000-0000-0000-0000-000000000000',
        artifactType,
        name: label,
        content: { description, source: 'audit-rpc' },
        contentHash: `sha256-${Date.now()}`,
        filePath: label.replace(/[^a-zA-Z0-9_-]/g, '_'),
      },
      select: { id: true },
    });

    return reply.status(201).send({ evidenceId: evidence.id, success: true });
  });

  // ── POST /internal/verdict ──────────────────────────────────
  // Receives and persists the final structured verdict.

  app.post<{
    Body: {
      verdict: string;
      riskSummary: string;
      scores: Record<string, number>;
      piSessionId?: string;
      promptPackVersion?: string;
    };
  }>('/internal/verdict', async (request, reply) => {
    const { verdict, riskSummary, scores, piSessionId } = request.body;

    const prisma = getPrisma();
    const auditRun = await prisma.auditRun.findFirst({
      where: { status: 'RUNNING' },
      orderBy: { createdAt: 'desc' },
      select: { id: true, reviewJobId: true },
    });

    if (!auditRun) {
      return reply.status(404).send({ error: 'No active audit run found', success: false });
    }

    const reviewJob = await prisma.reviewJob.findUnique({
      where: { id: auditRun.reviewJobId },
      select: { packageVersionId: true, id: true },
    });

    if (!reviewJob) {
      return reply.status(404).send({ error: 'Review job not found', success: false });
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
      where: { id: auditRun.id },
      data: { status: 'COMPLETED', completedAt: new Date() },
    });

    await prisma.reviewJob.update({
      where: { id: reviewJob.id },
      data: { status: 'COMPLETED' },
    });

    // Check if escalation is warranted based on the verdict
    const needsEscalation = shouldEscalateVerdict(verdict, scores, riskSummary);
    if (needsEscalation) {
      // Store escalation request as evaluation label
      try {
        await prisma.evaluationLabel.create({
          data: {
            decisionId: decision.id,
            labelType: 'EVALUATION_RESULT',
            labelValue: 'escalation_recommended',
            labelDescription: `Escalation recommended for ${request.body.verdict} verdict: ${riskSummary.slice(0, 200)}`,
            labeledBy: 'system',
          },
        });
      } catch { /* best-effort label creation */ }
    }

    return reply.status(201).send({ decisionId: decision.id, success: true, needsEscalation });
  });
}
