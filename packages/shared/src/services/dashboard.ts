/**
 * Dashboard read model types for the admin visibility dashboard.
 *
 * These are derived from ModuleWarden API endpoints backed by Prisma
 * and pg-boss state — no direct DB or pg-boss access in the browser.
 */

// ── Kanban columns ────────────────────────────────────────

export type KanbanColumn =
  | 'submitted'
  | 'queued'
  | 'running'
  | 'needs-escalation'
  | 'quarantined'
  | 'blocked'
  | 'allowed'
  | 'promotion-pending'
  | 'promoted'
  | 'failed'
  | 'superseded';

// ── Audit run card ─────────────────────────────────────────

export interface AuditRunCard {
  /** Unique run ID */
  id: string;
  /** Package identity */
  packageName: string;
  packageVersion: string;
  tarballHash: string;
  /** Trigger source */
  triggerSource: 'tarball-fetch' | 'preflight' | 'subscription' | 're-audit' | 'admin' | 'evaluation';
  /** Current job state */
  jobState: string;
  /** Kanban column placement */
  column: KanbanColumn;
  /** Risk summary (safe for developer view — no prompts/secrets) */
  riskSummary: string | null;
  /** Timestamps */
  createdAt: string;
  updatedAt: string;
  /** Age in seconds */
  ageSeconds: number;
  /** Retry count */
  retryCount: number;
  /** Predecessor info */
  predecessorVersion: string | null;
  /** Model profile used */
  modelProfile: string | null;
  /** Prompt pack versions */
  promptPackVersions: string[];
  /** Whether this run needs human attention */
  needsAttention: boolean;
  /** Escalation status */
  escalationStatus: 'none' | 'recommended' | 'running' | 'completed';
  /** Final verdict (if any) */
  verdict: string | null;
  /** Decision ID (if any) */
  decisionId: string | null;
  /** Promotion status */
  promotionStatus: 'none' | 'pending' | 'promoted' | 'failed';
  /** Evidence count */
  evidenceCount: number;
}

// ── Dashboard state ───────────────────────────────────────

export interface DashboardState {
  /** Cards grouped by kanban column */
  columns: Record<KanbanColumn, AuditRunCard[]>;
  /** Summary counts */
  summary: {
    /** Total visible cards, including superseded history */
    total: number;
    /** Current workflow cards, excluding superseded history */
    currentTotal: number;
    queued: number;
    running: number;
    blocked: number;
    quarantined: number;
    allowed: number;
    promoted: number;
    failed: number;
    superseded: number;
    needsAttention: number;
  };
  /** Timestamp of this snapshot */
  refreshedAt: string;
}

// ── Queue stats ────────────────────────────────────────────

export interface QueueStats {
  queue: string;
  pending: number;
  retrying: number;
  running: number;
  completed: number;
  failed: number;
  deadLettered: number;
}

// ── Package version detail ─────────────────────────────────

export interface PackageVersionDetail {
  auditRunId?: string;
  runStatus?: string;
  reviewJobId?: string;
  jobStatus?: string;
  canRetry?: boolean;
  canPromote?: boolean;
  promotionStatus?: 'none' | 'pending' | 'promoted' | 'failed';
  packageName: string;
  version: string;
  tarballHash: string;
  predecessorVersion: string | null;
  predecessorHash: string | null;
  /** Effective decision */
  verdict: string | null;
  riskSummary: string | null;
  /** Capability deltas */
  capabilityDeltas: Array<{
    category: string;
    severity: string;
    description: string;
    isNew: boolean;
  }>;
  /** Dependency changes from predecessor */
  dependencyChanges: Record<string, string>;
  /** Lifecycle script changes */
  lifecycleScripts: Array<{ name: string; command: string }>;
  /** PI run metadata */
  piSessionId: string | null;
  piRunId: string | null;
  /** Model profile */
  modelProfile: string | null;
  /** Prompt pack versions (names only, not content) */
  promptPackVersions: string[];
  /** Prompt provenance for this audit run */
  promptUsage?: PromptUsage;
  /** Evidence artifacts */
  evidenceArtifacts: EvidenceArtifactSummary[];
  /** Scores */
  scores: Record<string, number>;
  /** Decision history */
  decisionHistory: DecisionHistoryEntry[];
  /** Redacted live/final PI conversation stream */
  agentStream?: AgentStream;
}

export interface PromptUsage {
  source: 'prompt-pack-instructions' | 'decision-metadata' | 'unknown';
  promptPacks: string[];
  customPrompts: string[];
  initialPromptHash?: string;
  initialPromptEvidenceName?: string;
  note: string;
}

export interface EvidenceArtifactSummary {
  id: string;
  type: string;
  name: string;
  description: string;
  createdAt: string;
  /** File paths (if stored) */
  filePath?: string;
  /** Whether content is viewable (redacted for secrets/prompts) */
  viewable: boolean;
}

export interface DecisionHistoryEntry {
  id: string;
  verdict: string;
  reasonSummary: string;
  actorType: string;
  createdAt: string;
  /** If this was superseded by another decision */
  supersededById?: string;
}

export interface AgentStreamEntry {
  index: number;
  type: string;
  role?: string;
  text?: string;
  timestamp?: string;
  summary?: string;
  errorMessage?: string;
  responseId?: string;
  eventKind?: string;
}

export interface AgentStream {
  available: boolean;
  source: 'live-workspace' | 'session-archive' | 'database-artifact' | 'none';
  updatedAt: string;
  truncated: boolean;
  entries: AgentStreamEntry[];
  stderrTail?: string;
}

// ── Evidence bundle detail ─────────────────────────────────

export interface EvidenceBundleDetail {
  id: string;
  auditRunId: string;
  type: string;
  name: string;
  /** Redacted content — safe for dashboard display */
  content: unknown;
  /** File path if stored */
  filePath?: string;
  createdAt: string;
  /** Evaluation labels */
  labels: Array<{
    type: string;
    value: string;
    description?: string;
    labeledBy: string;
  }>;
}
