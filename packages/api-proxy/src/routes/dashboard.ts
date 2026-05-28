/**
 * Dashboard API endpoints for the admin visibility UI.
 * Backed by Prisma and pg-boss — no direct DB access in browser.
 */

import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { getPrisma } from '@modulewarden/prisma-client';
import { checkAdmin } from '../middleware/auth.js';
import { JOB_TYPES } from '@modulewarden/shared/types';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import type {
  AgentStream,
  AgentStreamEntry,
  DashboardState,
  AuditRunCard,
  KanbanColumn,
  PromptUsage,
  QueueStats,
  PackageVersionDetail,
} from '@modulewarden/shared/services/dashboard';

type RetryAuditRun = (input: {
  reviewJobId: string;
  packageName: string;
  packageVersion: string;
  tarballHash: string;
  predecessorHash: string | null;
  auditContext: string;
  retryOfAuditRunId: string;
}) => Promise<string | null>;

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

function redactStringValue(value: string): string {
  return value
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [REDACTED]')
    .replace(/(api[_-]?key|token|password|secret|credential)(["'\s:=]+)([A-Za-z0-9._~+/=-]{8,})/gi, '$1$2[REDACTED]')
    .replace(/\beyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}\b/g, '[REDACTED_JWT]')
    .replace(/\b[A-Za-z0-9+/]{48,}={0,2}\b/g, '[REDACTED_LONG_SECRET]');
}

function compactContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (part && typeof part === 'object' && 'text' in part) {
          return String((part as { text?: unknown }).text ?? '');
        }
        if (part && typeof part === 'object' && (part as { type?: unknown }).type === 'toolCall') {
          const toolCall = part as { name?: unknown; arguments?: unknown; partialArgs?: unknown };
          const name = toolCall.name ? String(toolCall.name) : 'tool';
          const args = toolCall.arguments && Object.keys(toolCall.arguments as Record<string, unknown>).length > 0
            ? JSON.stringify(toolCall.arguments, null, 2)
            : toolCall.partialArgs ? String(toolCall.partialArgs) : '';
          return args ? `Tool call: ${name}\n${args}` : `Tool call: ${name}`;
        }
        return typeof part === 'string' ? part : '';
      })
      .filter(Boolean)
      .join('\n');
  }
  return '';
}

function streamEventKey(entry: AgentStreamEntry): string | null {
  if (entry.type !== 'message_update') return null;
  const typed = entry as AgentStreamEntry & { responseId?: string; eventKind?: string };
  return `message_update:${typed.responseId ?? typed.timestamp ?? entry.role ?? entry.index}`;
}

function coalesceStreamEntries(entries: AgentStreamEntry[]): AgentStreamEntry[] {
  const result: AgentStreamEntry[] = [];
  const updateIndexes = new Map<string, number>();

  for (const entry of entries) {
    const key = streamEventKey(entry);
    if (!key) {
      result.push(entry);
      continue;
    }
    const existingIndex = updateIndexes.get(key);
    if (existingIndex === undefined) {
      updateIndexes.set(key, result.length);
      result.push(entry);
    } else {
      result[existingIndex] = entry;
    }
  }

  return result.filter((entry, index, all) => {
    const previous = all[index - 1];
    return !(previous &&
      previous.type === entry.type &&
      previous.role === entry.role &&
      previous.timestamp === entry.timestamp &&
      previous.text === entry.text &&
      previous.summary === entry.summary &&
      previous.errorMessage === entry.errorMessage);
  });
}

function normalizeJsonContent(value: unknown): unknown {
  if (value === null || value === undefined) return {};
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return {};
    try {
      return JSON.parse(trimmed);
    } catch {
      return { text: value };
    }
  }
  return value;
}

function parsePromptVersion(value: unknown): string[] {
  if (!value) return [];
  const raw = String(value);
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (Array.isArray(parsed)) return parsed.map((v) => String(v)).filter(Boolean);
  } catch { /* plain string */ }
  return raw ? [raw] : [];
}

function parsePromptList(promptText: string, label: string): string[] {
  const line = promptText
    .split('\n')
    .find((entry) => entry.toLowerCase().startsWith(`${label.toLowerCase()}:`));
  if (!line) return [];
  const value = line.slice(line.indexOf(':') + 1).trim();
  if (!value || value === 'none') return [];
  return value.split(',').map((entry) => entry.trim()).filter(Boolean);
}

function readPromptUsage(auditRunId: string, promptVersion: unknown): PromptUsage {
  const liveDir = findLiveWorkspace(process.env.MW_AUDIT_WORKSPACE_ROOT, auditRunId);
  const archiveDir = findSessionDir(process.env.MW_AUDIT_SESSION_ARCHIVE_ROOT, auditRunId);
  const baseDir = liveDir ?? archiveDir;
  const promptVersions = parsePromptVersion(promptVersion);
  const fallbackNote = promptVersions.length > 0
    ? 'Decision metadata recorded prompt-pack versions, but the archived initial prompt was not found.'
    : 'No prompt provenance was recorded for this run.';

  if (!baseDir) {
    return {
      source: promptVersions.length > 0 ? 'decision-metadata' : 'unknown',
      promptPacks: promptVersions,
      customPrompts: [],
      note: fallbackNote,
    };
  }

  const promptPath = join(baseDir, 'output', 'initial-prompt.md');
  if (!existsSync(promptPath)) {
    return {
      source: promptVersions.length > 0 ? 'decision-metadata' : 'unknown',
      promptPacks: promptVersions,
      customPrompts: [],
      note: fallbackNote,
    };
  }

  const promptText = readFileSync(promptPath, 'utf-8');
  const promptPacks = [...new Set([
    ...promptVersions,
    ...parsePromptList(promptText, 'Core prompt packs'),
    ...parsePromptList(promptText, 'Pattern prompt packs'),
    ...parsePromptList(promptText, 'Escalation prompt packs'),
    ...parsePromptList(promptText, 'Applied prompt packs'),
  ])];
  const customPrompts = parsePromptList(promptText, 'Custom prompts');
  const source: PromptUsage['source'] = promptPacks.length > 0 || customPrompts.length > 0
    ? 'prompt-pack-instructions'
    : 'unknown';

  return {
    source,
    promptPacks,
    customPrompts,
    initialPromptHash: createHash('sha256').update(promptText).digest('hex'),
    initialPromptEvidenceName: 'initial-prompt.md',
    note: source === 'unknown'
      ? 'No configured prompt-pack provenance was recorded for this run. Current audit containers require prompt-pack instructions; this is likely an older or failed run.'
      : 'This run recorded prompt-pack provenance in its initial prompt or decision metadata.',
  };
}

function toStreamEntry(index: number, rawLine: string): AgentStreamEntry | null {
  try {
    const event = JSON.parse(rawLine) as Record<string, unknown>;
    const update = event.assistantMessageEvent && typeof event.assistantMessageEvent === 'object'
      ? event.assistantMessageEvent as Record<string, unknown>
      : null;
    const message = event.message && typeof event.message === 'object'
      ? event.message as Record<string, unknown>
      : null;
    const role = message?.role ? String(message.role) : undefined;
    const text = message ? compactContent(message.content) : '';
    const errorMessage = message?.errorMessage ?? event.error;
    const responseId = message?.responseId ? String(message.responseId) : undefined;
    const eventKind = update?.type ? String(update.type) : undefined;
    const summary = event.command ? `command: ${String(event.command)}`
      : eventKind?.startsWith('thinking') ? 'thinking'
        : eventKind?.startsWith('toolcall') ? 'drafting tool call'
          : undefined;

    if (String(event.type ?? '') === 'message_update' && !text && !errorMessage && !summary) {
      return null;
    }

    return {
      index,
      type: String(event.type ?? 'event'),
      ...(role ? { role } : {}),
      ...(text ? { text: redactStringValue(text).slice(0, 4000) } : {}),
      ...(message?.timestamp ? { timestamp: new Date(Number(message.timestamp)).toISOString() } : {}),
      ...(errorMessage ? { errorMessage: redactStringValue(String(errorMessage)).slice(0, 1000) } : {}),
      ...(summary ? { summary } : {}),
      ...(responseId ? { responseId } : {}),
      ...(eventKind ? { eventKind } : {}),
    };
  } catch {
    return {
      index,
      type: 'raw',
      text: redactStringValue(rawLine).slice(0, 4000),
    };
  }
}

function findSessionDir(root: string | undefined, auditRunId: string): string | null {
  if (!root || !existsSync(root)) return null;
  for (const name of readdirSync(root)) {
    const path = join(root, name);
    try {
      if (statSync(path).isDirectory() && name.startsWith(`${auditRunId}-`)) return path;
    } catch { /* ignore */ }
  }
  return null;
}

function findLiveWorkspace(root: string | undefined, auditRunId: string): string | null {
  if (!root || !existsSync(root)) return null;
  for (const name of readdirSync(root)) {
    const path = join(root, name);
    const configPath = join(path, 'run-config.json');
    try {
      if (!statSync(path).isDirectory() || !existsSync(configPath)) continue;
      const config = JSON.parse(readFileSync(configPath, 'utf-8')) as Record<string, unknown>;
      if (config.auditRunId === auditRunId) return path;
    } catch { /* ignore */ }
  }
  return null;
}

function readAgentStream(auditRunId: string): AgentStream {
  const liveDir = findLiveWorkspace(process.env.MW_AUDIT_WORKSPACE_ROOT, auditRunId);
  const archiveDir = findSessionDir(process.env.MW_AUDIT_SESSION_ARCHIVE_ROOT, auditRunId);
  const baseDir = liveDir ?? archiveDir;
  const source: AgentStream['source'] = liveDir ? 'live-workspace' : archiveDir ? 'session-archive' : 'none';
  if (!baseDir) {
    return { available: false, source, updatedAt: new Date().toISOString(), truncated: false, entries: [] };
  }

  const logPath = join(baseDir, 'output', 'pi-session.log');
  const errPath = join(baseDir, 'output', 'pi-session-error.log');
  if (!existsSync(logPath)) {
    return { available: false, source, updatedAt: new Date().toISOString(), truncated: false, entries: [] };
  }

  const raw = readFileSync(logPath, 'utf-8');
  const lines = raw.split('\n').filter(Boolean);
  const maxEntries = 80;
  const entries = coalesceStreamEntries(
    lines
      .map((line, index) => toStreamEntry(index, line))
      .filter((entry): entry is AgentStreamEntry => Boolean(entry))
  );
  const selected = entries.slice(-maxEntries);
  const stderrTail = existsSync(errPath)
    ? redactStringValue(readFileSync(errPath, 'utf-8').slice(-4000))
    : undefined;

  return {
    available: true,
    source,
    updatedAt: new Date().toISOString(),
    truncated: entries.length > maxEntries,
    entries: selected,
    ...(stderrTail ? { stderrTail } : {}),
  };
}

/**
 * Register dashboard admin API routes.
 */
export async function registerDashboardRoutes(app: FastifyInstance, retryAuditRun?: RetryAuditRun): Promise<void> {
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
    const queueNames = Object.values(JOB_TYPES);
    // S-7: Use aggregate ReviewJob counts by status for overall queue health.
    // Per-queue breakdown is approximated via auditContext prefix matching.
    const stats: QueueStats[] = [];

    // Get overall status counts first
    const overallCounts = await prisma.$queryRawUnsafe<Array<Record<string, bigint>>>(`
      SELECT
        "status",
        COUNT(*) as cnt
      FROM "ReviewJob"
      GROUP BY "status"
    `);
    const countByStatus = Object.fromEntries(
      (overallCounts ?? []).map((r) => [String(r.status), Number(r.cnt ?? 0n)])
    );

    for (const q of queueNames) {
      // Use prefix match instead of substring LIKE to avoid cross-queue contamination
      const prefix = `${q}:`;
      const queued = await prisma.reviewJob.count({
        where: { status: 'QUEUED', auditContext: { startsWith: prefix } },
      });
      const running = await prisma.reviewJob.count({
        where: { status: 'RUNNING', auditContext: { startsWith: prefix } },
      });
      const completed = await prisma.reviewJob.count({
        where: { status: 'COMPLETED', auditContext: { startsWith: prefix } },
      });
      const failed = await prisma.reviewJob.count({
        where: { status: 'FAILED', auditContext: { startsWith: prefix } },
      });

      // Fall back to overall counts if prefix match yields no results
      stats.push({
        queue: q,
        pending: queued || Number(countByStatus['QUEUED'] ?? 0),
        running: running || Number(countByStatus['RUNNING'] ?? 0),
        completed: completed || Number(countByStatus['COMPLETED'] ?? 0),
        failed: failed || Number(countByStatus['FAILED'] ?? 0),
        deadLettered: Number(countByStatus['DEAD_LETTER'] ?? 0),
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
      `, id);

      if (rows.length === 0) {
        return reply.status(404).send({ error: 'Audit run not found' });
      }

      const row = rows[0];
      if (!row) {
        return reply.status(404).send({ error: 'Audit run not found' });
      }
      const scoresRaw = row.scores ? String(row.scores) : '{}';

      const detail: PackageVersionDetail = {
        auditRunId: String(row.run_id ?? id),
        runStatus: String(row.run_status ?? ''),
        reviewJobId: String(row.job_id ?? ''),
        jobStatus: String(row.job_status ?? ''),
        canRetry: ['CRASHED', 'TIMED_OUT', 'CANCELLED'].includes(String(row.run_status ?? '')) ||
          ['FAILED', 'DEAD_LETTER'].includes(String(row.job_status ?? '')),
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
        promptUsage: readPromptUsage(id, row.promptVersion),
        evidenceArtifacts: [],
        scores: (() => { try { return JSON.parse(scoresRaw); } catch { return {}; } })(),
        decisionHistory: row.decision_id ? [{
          id: String(row.decision_id),
          verdict: String(row.verdict ?? ''),
          reasonSummary: String(row.reasonSummary ?? ''),
          actorType: String(row.actorType ?? ''),
          createdAt: String(row.decision_created ?? ''),
        }] : [],
        agentStream: readAgentStream(id),
      };

      // Fetch evidence artifacts
      const evidenceRows = await prisma.$queryRawUnsafe<Array<Record<string, unknown>>>(`
        SELECT "id", "artifactType", "name", "content", "filePath", "createdAt"
        FROM "EvidenceArtifact" WHERE "auditRunId" = $1 ORDER BY "createdAt" DESC
      `, id);
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

  // ── POST /admin/audit-run/:id/retry ──────────────────────────

  app.post<{ Params: { id: string } }>(
    '/admin/audit-run/:id/retry',
    async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
      if (!checkAdmin(request, reply)) return;
      if (!retryAuditRun) {
        return reply.status(503).send({ error: 'Retry queue is not available' });
      }

      const { id } = request.params;
      const prisma = getPrisma();
      const run = await prisma.auditRun.findUnique({
        where: { id },
        select: {
          id: true,
          status: true,
          reviewJob: {
            select: {
              id: true,
              auditContext: true,
              status: true,
              packageVersion: {
                select: {
                  packageName: true,
                  version: true,
                  tarballHash: true,
                  predecessor: { select: { tarballHash: true } },
                },
              },
            },
          },
        },
      });

      if (!run) return reply.status(404).send({ error: 'Audit run not found' });
      const retryable = ['CRASHED', 'TIMED_OUT', 'CANCELLED'].includes(run.status) ||
        ['FAILED', 'DEAD_LETTER'].includes(run.reviewJob.status);
      if (!retryable) {
        return reply.status(409).send({
          error: 'Audit run is not retryable',
          status: run.status,
          jobStatus: run.reviewJob.status,
        });
      }

      await prisma.reviewJob.update({
        where: { id: run.reviewJob.id },
        data: { status: 'QUEUED', failureReason: null },
      });

      const pv = run.reviewJob.packageVersion;
      const pgBossJobId = await retryAuditRun({
        reviewJobId: run.reviewJob.id,
        packageName: pv.packageName,
        packageVersion: pv.version,
        tarballHash: pv.tarballHash,
        predecessorHash: pv.predecessor?.tarballHash ?? null,
        auditContext: run.reviewJob.auditContext,
        retryOfAuditRunId: run.id,
      });

      if (!pgBossJobId) {
        await prisma.reviewJob.update({
          where: { id: run.reviewJob.id },
          data: {
            status: 'FAILED',
            failureReason: `${new Date().toISOString()}: retry enqueue failed`,
          },
        });
        return reply.status(500).send({ error: 'Retry enqueue failed' });
      }

      return reply.status(202).send({
        status: 'queued',
        retryOfAuditRunId: run.id,
        reviewJobId: run.reviewJob.id,
        pgBossJobId,
      });
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
      `, id);

      if (rows.length === 0) {
        return reply.status(404).send({ error: 'Evidence artifact not found' });
      }

      const row = rows[0];
      if (!row) {
        return reply.status(404).send({ error: 'Evidence artifact not found' });
      }
      const content = normalizeJsonContent(row.content);

      /**
       * Recursively redact sensitive data from evidence content.
       * Redacts:
       *  - Keys matching sensitive patterns (prompt, secret, token, api_key, password, credential)
       *  - String values matching credential patterns (Bearer tokens, base64 > 40 chars, JWT-like)
       *  - Nested objects and arrays are traversed recursively
       */
      function redactSensitive(value: unknown): unknown {
        if (Array.isArray(value)) {
          return value.map(redactSensitive);
        }
        if (value && typeof value === 'object') {
          const result: Record<string, unknown> = {};
          for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
            const keyLower = String(key).toLowerCase();
            const sensitiveKey = keyLower.includes('prompt') ||
              keyLower.includes('secret') ||
              keyLower.includes('token') ||
              keyLower.includes('api_key') ||
              keyLower.includes('api-key') ||
              keyLower.includes('password') ||
              keyLower.includes('credential') ||
              keyLower.includes('auth') ||
              keyLower.includes('authorization');

            if (sensitiveKey) {
              result[key] = '[REDACTED]';
            } else if (typeof val === 'string') {
              result[key] = redactStringValue(val);
            } else {
              result[key] = redactSensitive(val);
            }
          }
          return result;
        }
        if (typeof value === 'string') {
          return redactStringValue(value);
        }
        return value;
      }

      /**
       * Redact credential patterns from string values.
       */
      function redactStringValue(s: string): string {
        // Bearer tokens
        if (/Bearer\s+[A-Za-z0-9_\-.]{20,}/.test(s)) {
          return s.replace(/(Bearer\s+)([A-Za-z0-9_\-.]{8})[A-Za-z0-9_\-.]+/g, '$1$2...[REDACTED]');
        }
        // Base64-like strings > 40 chars (likely credentials)
        if (/^[A-Za-z0-9+/=]{40,}$/.test(s)) {
          return s.slice(0, 8) + '...[REDACTED]';
        }
        // JWT-like tokens
        if (/^[A-Za-z0-9_\-]+\.[A-Za-z0-9_\-]+\.[A-Za-z0-9_\-]+$/.test(s) && s.length > 60) {
          return s.slice(0, 16) + '...[REDACTED]';
        }
        // API keys (alphanumeric strings > 30 chars)
        if (/^[A-Za-z0-9_]{30,}$/.test(s)) {
          return s.slice(0, 8) + '...[REDACTED]';
        }
        return s;
      }

      const redacted = redactSensitive(content);

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
