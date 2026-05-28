/**
 * Dashboard API endpoints for the admin visibility UI.
 * Backed by Prisma and pg-boss — no direct DB access in browser.
 */

import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { getPrisma } from '@modulewarden/prisma-client';
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

  app.get('/admin/dashboard', async (_request: FastifyRequest, reply: FastifyReply) => {
    const prisma = getPrisma();

    // Use raw queries to avoid Prisma type complexity with nested includes
    const jobs = await prisma.$queryRawUnsafe<Array<Record<string, unknown>>>(`
      SELECT
        rj.id as job_id, rj.status as job_status, rj.trigger, rj.created_at,
        rj.updated_at, rj.failure_reason, rj.audit_context,
        pv.package_name, pv.version, pv.tarball_hash,
        ar.id as run_id, ar.status as run_status, ar.error_message,
        d.id as decision_id, d.verdict, d.reason_summary, d.prompt_version
      FROM review_jobs rj
      LEFT JOIN package_versions pv ON pv.id = rj.package_version_id
      LEFT JOIN LATERAL (
        SELECT id, status, error_message FROM audit_runs
        WHERE review_job_id = rj.id ORDER BY created_at DESC LIMIT 1
      ) ar ON true
      LEFT JOIN LATERAL (
        SELECT id, verdict, reason_summary, prompt_version FROM decisions
        WHERE review_job_id = rj.id ORDER BY created_at DESC LIMIT 1
      ) d ON true
      ORDER BY rj.created_at DESC
      LIMIT 200
    `);

    const columns: Record<string, AuditRunCard[]> = {};
    const colKeys: KanbanColumn[] = [
      'submitted', 'queued', 'running', 'needs-escalation',
      'quarantined', 'blocked', 'allowed', 'promotion-pending',
      'promoted', 'failed', 'superseded',
    ];
    for (const key of colKeys) columns[key] = [];

    for (const row of jobs) {
      const jobStatus = String(row.job_status ?? '');
      const jobTrigger = String(row.trigger ?? '');
      const verdict = row.verdict ? String(row.verdict) : null;

      const card: AuditRunCard = {
        id: String(row.run_id || row.job_id),
        packageName: String(row.package_name ?? 'unknown'),
        packageVersion: String(row.version ?? 'unknown'),
        tarballHash: String(row.tarball_hash ?? ''),
        triggerSource: jobTrigger === 'SUBSCRIPTION' ? 'subscription'
          : jobTrigger === 'RE_AUDIT' ? 're-audit'
          : jobTrigger === 'MANUAL' ? 'admin' : 'preflight',
        jobState: jobStatus,
        column: assignColumn(jobStatus, verdict),
        riskSummary: row.reason_summary ? String(row.reason_summary) : row.error_message ? String(row.error_message) : null,
        createdAt: String(row.created_at ?? new Date().toISOString()),
        updatedAt: String(row.updated_at ?? new Date().toISOString()),
        ageSeconds: row.created_at ? cardAge(new Date(String(row.created_at))) : 0,
        retryCount: row.failure_reason ? 1 : 0,
        predecessorVersion: null,
        modelProfile: null,
        promptPackVersions: row.prompt_version ? [String(row.prompt_version)] : [],
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
      columns: columns as Record<KanbanColumn, AuditRunCard[]>,
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

  app.get('/admin/queue-stats', async (_request: FastifyRequest, reply: FastifyReply) => {
    const prisma = getPrisma();
    const queueNames = [
      'package-review', 'upstream-subscription-poll', 'audit-container-exec',
      'model-escalation', 're-audit-campaign', 'evidence-post-process',
      'verdaccio-promotion', 'project-ready',
    ];
    const stats: QueueStats[] = [];

    for (const q of queueNames) {
      try {
        const counts = await prisma.$queryRawUnsafe<Array<Record<string, bigint>>>(`
          SELECT
            COUNT(*) FILTER (WHERE status = 'QUEUED' AND audit_context LIKE $1) as pending,
            COUNT(*) FILTER (WHERE status = 'RUNNING' AND audit_context LIKE $1) as running,
            COUNT(*) FILTER (WHERE status = 'COMPLETED' AND audit_context LIKE $1) as completed,
            COUNT(*) FILTER (WHERE status = 'FAILED' AND audit_context LIKE $1) as failed
          FROM review_jobs
        `, [`%${q}%`]);
        const c = counts[0] ?? { pending: 0n, running: 0n, completed: 0n, failed: 0n };
        stats.push({
          queue: q,
          pending: Number(c.pending ?? 0n),
          running: Number(c.running ?? 0n),
          completed: Number(c.completed ?? 0n),
          failed: Number(c.failed ?? 0n),
          deadLettered: 0,
        });
      } catch {
        stats.push({ queue: q, pending: 0, running: 0, completed: 0, failed: 0, deadLettered: 0 });
      }
    }
    return reply.send(stats);
  });

  // ── GET /admin/audit-run/:id ─────────────────────────────────

  app.get<{ Params: { id: string } }>(
    '/admin/audit-run/:id',
    async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
      const { id } = request.params;
      const prisma = getPrisma();

      const rows = await prisma.$queryRawUnsafe<Array<Record<string, unknown>>>(`
        SELECT
          ar.id as run_id, ar.status as run_status, ar.error_message,
          ar.pi_session_id, ar.pi_run_id, ar.created_at, ar.started_at, ar.completed_at,
          rj.id as job_id, rj.status as job_status, rj.audit_context, rj.trigger,
          pv.package_name, pv.version, pv.tarball_hash, pv.repository_url, pv.license,
          d.id as decision_id, d.verdict, d.reason_summary, d.scores, d.prompt_version, d.actor_type, d.created_at as decision_created
        FROM audit_runs ar
        JOIN review_jobs rj ON rj.id = ar.review_job_id
        JOIN package_versions pv ON pv.id = rj.package_version_id
        LEFT JOIN LATERAL (
          SELECT id, verdict, reason_summary, scores, prompt_version, actor_type, created_at
          FROM decisions WHERE review_job_id = rj.id ORDER BY created_at DESC LIMIT 1
        ) d ON true
        WHERE ar.id = $1
      `, [id]);

      if (rows.length === 0) {
        return reply.status(404).send({ error: 'Audit run not found' });
      }

      const row = rows[0];
      const scoresRaw = row.scores ? String(row.scores) : '{}';

      const detail: PackageVersionDetail = {
        packageName: String(row.package_name ?? 'unknown'),
        version: String(row.version ?? 'unknown'),
        tarballHash: String(row.tarball_hash ?? ''),
        predecessorVersion: null,
        predecessorHash: null,
        verdict: row.verdict ? String(row.verdict) : null,
        riskSummary: row.reason_summary ? String(row.reason_summary) : row.error_message ? String(row.error_message) : null,
        capabilityDeltas: [],
        dependencyChanges: {},
        lifecycleScripts: [],
        piSessionId: row.pi_session_id ? String(row.pi_session_id) : null,
        piRunId: row.pi_run_id ? String(row.pi_run_id) : null,
        modelProfile: null,
        promptPackVersions: row.prompt_version ? [String(row.prompt_version)] : [],
        evidenceArtifacts: [],
        scores: (() => { try { return JSON.parse(scoresRaw); } catch { return {}; } })(),
        decisionHistory: row.decision_id ? [{
          id: String(row.decision_id),
          verdict: String(row.verdict ?? ''),
          reasonSummary: String(row.reason_summary ?? ''),
          actorType: String(row.actor_type ?? ''),
          createdAt: String(row.decision_created ?? ''),
        }] : [],
      };

      // Fetch evidence artifacts
      try {
        const evidenceRows = await prisma.$queryRawUnsafe<Array<Record<string, unknown>>>(`
          SELECT id, artifact_type, name, content, file_path, created_at
          FROM evidence_artifacts WHERE audit_run_id = $1 ORDER BY created_at DESC
        `, [id]);
        detail.evidenceArtifacts = evidenceRows.map((e) => ({
          id: String(e.id),
          type: String(e.artifact_type ?? ''),
          name: String(e.name ?? ''),
          description: '',
          createdAt: String(e.created_at ?? ''),
          filePath: e.file_path ? String(e.file_path) : undefined,
          viewable: true,
        }));
      } catch { /* evidence fetch is best-effort */ }

      return reply.send(detail);
    }
  );

  // ── GET /admin/evidence/:id ─────────────────────────────────

  app.get<{ Params: { id: string } }>(
    '/admin/evidence/:id',
    async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
      const { id } = request.params;
      const prisma = getPrisma();

      const rows = await prisma.$queryRawUnsafe<Array<Record<string, unknown>>>(`
        SELECT ea.id, ea.artifact_type, ea.name, ea.content, ea.file_path, ea.created_at,
               ar.id as audit_run_id
        FROM evidence_artifacts ea
        JOIN audit_runs ar ON ar.id = ea.audit_run_id
        WHERE ea.id = $1
      `, [id]);

      if (rows.length === 0) {
        return reply.status(404).send({ error: 'Evidence artifact not found' });
      }

      const row = rows[0];
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
        type: String(row.artifact_type ?? ''),
        name: String(row.name ?? ''),
        content: redacted,
        filePath: row.file_path ? String(row.file_path) : undefined,
        createdAt: String(row.created_at ?? ''),
        labels: [],
      });
    }
  );
}
