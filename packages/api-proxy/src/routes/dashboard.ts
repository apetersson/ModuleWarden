/**
 * Dashboard API endpoints for the admin visibility UI.
 * Backed by Prisma and pg-boss — no direct DB access in browser.
 */

import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { getPrisma } from '@modulewarden/prisma-client';
import { checkAdmin } from '../middleware/auth.js';
import type {
  DashboardState,
  AuditRunCard,
  KanbanColumn,
  QueueStats,
  PackageVersionDetail,
} from '@modulewarden/shared/services/dashboard';

function cardAge(createdAt: Date): number {
  return Math.floor((Date.now() - createdAt.getTime()) / 1000);
}

function assignColumn(status: string, verdict: string | null): KanbanColumn {
  if (status === 'QUEUED' || status === 'PENDING') return 'queued';
  if (status === 'RUNNING') return 'running';
  if (status === 'FAILED' || status === 'DEAD_LETTER' || status === 'TIMED_OUT' || status === 'CRASHED') return 'failed';
  if (status === 'CANCELLED') return 'failed';
  if (status === 'COMPLETED') {
    if (verdict === 'BLOCK') return 'blocked';
    if (verdict === 'QUARANTINE') return 'quarantined';
    if (verdict === 'ALLOW') return 'allowed';
    return 'submitted';
  }
  return 'submitted';
}

/**
 * Register dashboard admin API routes.
 */
export async function registerDashboardRoutes(app: FastifyInstance): Promise<void> {
  // ── GET /admin/dashboard ─────────────────────────────────────

  app.get('/admin/dashboard', async (request: FastifyRequest, reply: FastifyReply) => {
    if (!checkAdmin(request, reply)) return;

    const prisma = getPrisma();

    // Use raw queries to avoid Prisma type complexity with nested includes
    const jobs = await prisma.$queryRawUnsafe<Array<Record<string, unknown>>>(`
      SELECT
        rj."id" as job_id, rj."status" as job_status, rj."trigger", rj."createdAt",
        rj."updatedAt", rj."failureReason", rj."auditContext",
        pv."packageName", pv."version", pv."tarballHash",
        ar."id" as run_id, ar."status" as run_status, ar."errorMessage",
        d."id" as decision_id, d."verdict", d."reasonSummary", d."promptVersion"
      FROM "ReviewJob" rj
      LEFT JOIN "PackageVersion" pv ON pv."id" = rj."packageVersionId"
      LEFT JOIN LATERAL (
        SELECT "id", "status", "errorMessage" FROM "AuditRun"
        WHERE "reviewJobId" = rj."id" ORDER BY "createdAt" DESC LIMIT 1
      ) ar ON true
      LEFT JOIN LATERAL (
        SELECT "id", "verdict", "reasonSummary", "promptVersion" FROM "Decision"
        WHERE "reviewJobId" = rj."id" ORDER BY "createdAt" DESC LIMIT 1
      ) d ON true
      ORDER BY rj."createdAt" DESC
      LIMIT 200
    `);

    const colKeys: KanbanColumn[] = [
      'submitted', 'queued', 'running', 'needs-escalation',
      'quarantined', 'blocked', 'allowed', 'promotion-pending',
      'promoted', 'failed', 'superseded',
    ];
    const columns = Object.fromEntries(
      colKeys.map((key) => [key, [] as AuditRunCard[]])
    ) as Record<KanbanColumn, AuditRunCard[]>;

    for (const row of jobs) {
      const jobStatus = String(row.job_status ?? '');
      const jobTrigger = String(row.trigger ?? '');
      const verdict = row.verdict ? String(row.verdict) : null;

      const card: AuditRunCard = {
        id: String(row.run_id || row.job_id),
        packageName: String(row.packageName ?? 'unknown'),
        packageVersion: String(row.version ?? 'unknown'),
        tarballHash: String(row.tarballHash ?? ''),
        triggerSource: jobTrigger === 'SUBSCRIPTION' ? 'subscription'
          : jobTrigger === 'RE_AUDIT' ? 're-audit'
          : jobTrigger === 'MANUAL' ? 'admin' : 'preflight',
        jobState: jobStatus,
        column: assignColumn(jobStatus, verdict),
        riskSummary: row.reasonSummary ? String(row.reasonSummary) : row.errorMessage ? String(row.errorMessage) : null,
        createdAt: String(row.createdAt ?? new Date().toISOString()),
        updatedAt: String(row.updatedAt ?? new Date().toISOString()),
        ageSeconds: row.createdAt ? cardAge(new Date(String(row.createdAt))) : 0,
        retryCount: row.failureReason ? 1 : 0,
        predecessorVersion: null,
        modelProfile: null,
        promptPackVersions: row.promptVersion ? [String(row.promptVersion)] : [],
        needsAttention: jobStatus === 'FAILED' || jobStatus === 'DEAD_LETTER' || jobStatus === 'CRASHED',
        escalationStatus: 'none',
        verdict,
        decisionId: row.decision_id ? String(row.decision_id) : null,
        promotionStatus: 'none',
        evidenceCount: 0,
      };
      columns[card.column].push(card);
    }

    const allCards = Object.values(columns).flat();
    const dashboard: DashboardState = {
      columns: columns,
      summary: {
        total: allCards.length,
        queued: columns.queued.length,
        running: columns.running.length,
        blocked: columns.blocked.length,
        quarantined: columns.quarantined.length,
        allowed: columns.allowed.length,
        failed: columns.failed.length,
        needsAttention: allCards.filter((c) => c.needsAttention).length,
      },
      refreshedAt: new Date().toISOString(),
    };

    return reply.send(dashboard);
  });

  // ── GET /admin/queue-stats ───────────────────────────────────

  app.get('/admin/queue-stats', async (request: FastifyRequest, reply: FastifyReply) => {
    if (!checkAdmin(request, reply)) return;

    const prisma = getPrisma();
    const queueNames = [
      'package-review', 'upstream-subscription-poll', 'audit-container-exec',
      'model-escalation', 're-audit-campaign', 'evidence-post-process',
      'verdaccio-promotion', 'project-ready',
    ];
    const stats: QueueStats[] = [];

    for (const q of queueNames) {
      const pattern = `%${q}%`;
      const counts = await prisma.$queryRawUnsafe<Array<Record<string, bigint>>>(`
        SELECT
          COUNT(*) FILTER (WHERE "status" = 'QUEUED' AND "auditContext" LIKE $1) as pending,
          COUNT(*) FILTER (WHERE "status" = 'RUNNING' AND "auditContext" LIKE $1) as running,
          COUNT(*) FILTER (WHERE "status" = 'COMPLETED' AND "auditContext" LIKE $1) as completed,
          COUNT(*) FILTER (WHERE "status" = 'FAILED' AND "auditContext" LIKE $1) as failed
        FROM "ReviewJob"
      `, pattern);
      const c = counts[0] ?? { pending: 0n, running: 0n, completed: 0n, failed: 0n };
      stats.push({
        queue: q,
        pending: Number(c.pending ?? 0n),
        running: Number(c.running ?? 0n),
        completed: Number(c.completed ?? 0n),
        failed: Number(c.failed ?? 0n),
        deadLettered: 0,
      });
    }
    return reply.send(stats);
  });

  // ── GET /admin/audit-run/:id ─────────────────────────────────

  app.get<{ Params: { id: string } }>(
    '/admin/audit-run/:id',
    async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
      if (!checkAdmin(request, reply)) return;

      const { id } = request.params;
      const prisma = getPrisma();

      const rows = await prisma.$queryRawUnsafe<Array<Record<string, unknown>>>(`
        SELECT
          ar."id" as run_id, ar."status" as run_status, ar."errorMessage",
          ar."piSessionId", ar."piRunId", ar."createdAt", ar."startedAt", ar."completedAt",
          rj."id" as job_id, rj."status" as job_status, rj."auditContext", rj."trigger",
          pv."packageName", pv."version", pv."tarballHash", pv."repositoryUrl", pv."license",
          d."id" as decision_id, d."verdict", d."reasonSummary", d."scores", d."promptVersion", d."actorType", d."createdAt" as decision_created
        FROM "AuditRun" ar
        JOIN "ReviewJob" rj ON rj."id" = ar."reviewJobId"
        JOIN "PackageVersion" pv ON pv."id" = rj."packageVersionId"
        LEFT JOIN LATERAL (
          SELECT "id", "verdict", "reasonSummary", "scores", "promptVersion", "actorType", "createdAt"
          FROM "Decision" WHERE "reviewJobId" = rj."id" ORDER BY "createdAt" DESC LIMIT 1
        ) d ON true
        WHERE ar."id" = $1
      `, [id]);

      if (rows.length === 0) {
        return reply.status(404).send({ error: 'Audit run not found' });
      }

      const row = rows[0];
      if (!row) {
        return reply.status(404).send({ error: 'Audit run not found' });
      }
      const scoresRaw = row.scores ? String(row.scores) : '{}';

      const detail: PackageVersionDetail = {
        packageName: String(row.packageName ?? 'unknown'),
        version: String(row.version ?? 'unknown'),
        tarballHash: String(row.tarballHash ?? ''),
        predecessorVersion: null,
        predecessorHash: null,
        verdict: row.verdict ? String(row.verdict) : null,
        riskSummary: row.reasonSummary ? String(row.reasonSummary) : row.errorMessage ? String(row.errorMessage) : null,
        capabilityDeltas: [],
        dependencyChanges: {},
        lifecycleScripts: [],
        piSessionId: row.piSessionId ? String(row.piSessionId) : null,
        piRunId: row.piRunId ? String(row.piRunId) : null,
        modelProfile: null,
        promptPackVersions: row.promptVersion ? [String(row.promptVersion)] : [],
        evidenceArtifacts: [],
        scores: (() => { try { return JSON.parse(scoresRaw); } catch { return {}; } })(),
        decisionHistory: row.decision_id ? [{
          id: String(row.decision_id),
          verdict: String(row.verdict ?? ''),
          reasonSummary: String(row.reasonSummary ?? ''),
          actorType: String(row.actorType ?? ''),
          createdAt: String(row.decision_created ?? ''),
        }] : [],
      };

      // Fetch evidence artifacts
      const evidenceRows = await prisma.$queryRawUnsafe<Array<Record<string, unknown>>>(`
        SELECT "id", "artifactType", "name", "content", "filePath", "createdAt"
        FROM "EvidenceArtifact" WHERE "auditRunId" = $1 ORDER BY "createdAt" DESC
      `, [id]);
      detail.evidenceArtifacts = evidenceRows.map((e) => ({
        id: String(e.id),
        type: String(e.artifactType ?? ''),
        name: String(e.name ?? ''),
        description: '',
        createdAt: String(e.createdAt ?? ''),
        ...(e.filePath ? { filePath: String(e.filePath) } : {}),
        viewable: true,
      }));

      return reply.send(detail);
    }
  );

  // ── GET /admin/evidence/:id ─────────────────────────────────

  app.get<{ Params: { id: string } }>(
    '/admin/evidence/:id',
    async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
      if (!checkAdmin(request, reply)) return;

      const { id } = request.params;
      const prisma = getPrisma();

      const rows = await prisma.$queryRawUnsafe<Array<Record<string, unknown>>>(`
        SELECT ea."id", ea."artifactType", ea."name", ea."content", ea."filePath", ea."createdAt",
               ar."id" as audit_run_id
        FROM "EvidenceArtifact" ea
        JOIN "AuditRun" ar ON ar."id" = ea."auditRunId"
        WHERE ea."id" = $1
      `, [id]);

      if (rows.length === 0) {
        return reply.status(404).send({ error: 'Evidence artifact not found' });
      }

      const row = rows[0];
      if (!row) {
        return reply.status(404).send({ error: 'Evidence artifact not found' });
      }
      const content = row.content ? JSON.parse(String(row.content)) : {};

      // Redact hidden content — only show safe fields
      const redacted: Record<string, unknown> = {};
      for (const [key, val] of Object.entries(content)) {
        if (!String(key).toLowerCase().includes('prompt') &&
            !String(key).toLowerCase().includes('secret') &&
            !String(key).toLowerCase().includes('token') &&
            !String(key).toLowerCase().includes('api_key')) {
          redacted[key] = val;
        }
      }

      return reply.send({
        id: String(row.id),
        auditRunId: String(row.audit_run_id),
        type: String(row.artifactType ?? ''),
        name: String(row.name ?? ''),
        content: redacted,
        filePath: row.filePath ? String(row.filePath) : undefined,
        createdAt: String(row.createdAt ?? ''),
        labels: [],
      });
    }
  );

  // ── GET /admin/campaigns — List re-audit campaigns ───────────

  app.get('/admin/campaigns', async (request: FastifyRequest, reply: FastifyReply) => {
    if (!checkAdmin(request, reply)) return;

    const prisma = getPrisma();
    const campaigns = await prisma.reAuditCampaign.findMany({
      orderBy: { createdAt: 'desc' },
      take: 50,
      select: {
        id: true,
        reason: true,
        triggerType: true,
        status: true,
        createdAt: true,
        completedAt: true,
        projectId: true,
      },
    });
    return reply.send(campaigns);
  });

  // ── GET /admin/prompts — List prompt pack versions ──────────

  app.get('/admin/prompts', async (request: FastifyRequest, reply: FastifyReply) => {
    if (!checkAdmin(request, reply)) return;

    const prisma = getPrisma();
    const prompts = await prisma.promptPack.findMany({
      orderBy: { createdAt: 'desc' },
      take: 100,
      select: {
        id: true,
        name: true,
        version: true,
        category: true,
        createdAt: true,
      },
    });
    return reply.send(prompts);
  });

  // ── GET /admin/evaluation — List evaluation corpus results ──

  app.get('/admin/evaluation', async (request: FastifyRequest, reply: FastifyReply) => {
    if (!checkAdmin(request, reply)) return;

    const prisma = getPrisma();
    // Query evaluation results: decisions with EVALUATION_RESULT labels
    const results = await prisma.$queryRawUnsafe<Array<Record<string, unknown>>>(`
      SELECT
        el."id" as label_id,
        el."labelValue",
        el."labelDescription",
        el."createdAt" as label_created_at,
        d."id" as decision_id,
        d."verdict",
        d."reasonSummary",
        d."createdAt" as decision_created_at,
        pv."packageName",
        pv."version"
      FROM "EvaluationLabel" el
      JOIN "Decision" d ON d."id" = el."decisionId"
      JOIN "PackageVersion" pv ON pv."id" = d."packageVersionId"
      WHERE el."labelType" = 'EVALUATION_RESULT'
      ORDER BY el."createdAt" DESC
      LIMIT 100
    `);

    const mapped = results.map((r) => ({
      labelId: String(r.label_id),
      labelValue: String(r.labelValue),
      labelDescription: r.labelDescription ? String(r.labelDescription) : null,
      labelCreatedAt: String(r.label_created_at),
      decisionId: String(r.decision_id),
      verdict: r.verdict ? String(r.verdict) : null,
      reasonSummary: r.reasonSummary ? String(r.reasonSummary) : null,
      decisionCreatedAt: String(r.decision_created_at),
      packageName: String(r.packageName ?? ''),
      packageVersion: String(r.version ?? ''),
    }));

    return reply.send(mapped);
  });
}
