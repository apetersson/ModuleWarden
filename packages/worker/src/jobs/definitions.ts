import type { JobType, WorkerConfig } from '@modulewarden/shared/types';

/**
 * All ModuleWarden job types with documentation.
 */
export const JOB_TYPES: Record<string, JobType> = {
  /** Review a new package version against its predecessor. */
  PACKAGE_REVIEW: 'package-review' as JobType,

  /** Poll upstream registry for new versions of subscribed packages. */
  UPSTREAM_SUBSCRIPTION_POLL: 'upstream-subscription-poll' as JobType,

  /** Execute a PI audit inside an isolated Docker container. */
  AUDIT_CONTAINER_EXEC: 'audit-container-exec' as JobType,

  /** Escalate a first-pass audit to a more capable model pass. */
  MODEL_ESCALATION: 'model-escalation' as JobType,

  /** Re-audit currently allowed versions after prompt/model/pattern changes. */
  RE_AUDIT_CAMPAIGN: 're-audit-campaign' as JobType,

  /** Post-process evidence artifacts after an audit run completes. */
  EVIDENCE_POST_PROCESS: 'evidence-post-process' as JobType,

  /** Promote an allowed package tarball into Verdaccio. */
  VERDACCIO_PROMOTION: 'verdaccio-promotion' as JobType,
  /** Evaluate whether a project is fully reviewed and enable registry access. */
  PROJECT_READY: 'project-ready' as JobType,
} as const;

/**
 * Default worker configuration for each job type.
 *
 * Concurrency limits are deliberately conservative for expensive
 * PI/container/model workloads (audit-container-exec, model-escalation)
 * and more generous for quick operations (evidence-post-process, verdaccio-promotion).
 */
export const DEFAULT_WORKER_CONFIG: WorkerConfig = {
  concurrency: {
    'package-review': 4,
    'upstream-subscription-poll': 2,
    'audit-container-exec': 2,
    'model-escalation': 1,
    're-audit-campaign': 1,
    'evidence-post-process': 4,
    'verdaccio-promotion': 4,
    'project-ready': 1,
  },
  retryPolicy: {
    maxRetries: 3,
    backoffMs: 30_000,
    timeoutMs: 600_000,
  },
};

/**
 * Scheduled job definitions for recurring tasks.
 */
export const SCHEDULED_JOBS: Array<{
  name: string;
  cron: string;
  queue: JobType;
  description: string;
}> = [
  {
    name: 'poll-upstream-subscriptions',
    cron: '*/15 * * * *',   // Every 15 minutes
    queue: 'upstream-subscription-poll' as JobType,
    description: 'Poll upstream npm registry for new versions of subscribed packages',
  },
  {
    name: 're-audit-prompt-changes',
    cron: '0 2 * * *',      // Daily at 2am
    queue: 're-audit-campaign' as JobType,
    description: 'Check for prompt/model/pattern changes and enqueue re-audit campaigns',
  },
];

/**
 * Retry and timeout configuration per job type.
 */
export const JOB_RETRY_CONFIG: Record<
  JobType,
  { maxRetries: number; timeoutMs: number; backoffMs: number; singletonSeconds?: number }
> = {
  'package-review': {
    maxRetries: 3,
    timeoutMs: 600_000,  // 10 min
    backoffMs: 30_000,
    singletonSeconds: 60 * 60 * 24 * 365, // 1 year dedupe window by job key
  },
  'upstream-subscription-poll': {
    maxRetries: 2,
    timeoutMs: 120_000,  // 2 min
    backoffMs: 15_000,
  },
  'audit-container-exec': {
    maxRetries: 2,
    timeoutMs: 900_000,  // 15 min (container + PI run)
    backoffMs: 60_000,
  },
  'model-escalation': {
    maxRetries: 2,
    timeoutMs: 600_000,  // 10 min
    backoffMs: 60_000,
  },
  're-audit-campaign': {
    maxRetries: 1,
    timeoutMs: 3_600_000, // 1 hour (campaign may have many packages)
    backoffMs: 120_000,
  },
  'evidence-post-process': {
    maxRetries: 3,
    timeoutMs: 120_000,  // 2 min
    backoffMs: 10_000,
  },
  'verdaccio-promotion': {
    maxRetries: 3,
    timeoutMs: 120_000,  // 2 min
    backoffMs: 15_000,
  },
  'project-ready': {
    maxRetries: 5,
    timeoutMs: 30_000,  // 30 sec
    backoffMs: 5_000,
  },
};

/**
 * Build a human-readable description for a job failure.
 */
export function formatJobFailure(jobType: JobType, jobId: string, error: Error): string {
  const config = JOB_RETRY_CONFIG[jobType];
  return [
    `[${jobType}] Job ${jobId} failed: ${error.message}`,
    `  Retries: ${config.maxRetries} max, Backoff: ${config.backoffMs}ms`,
    `  Timeout: ${config.timeoutMs}ms`,
  ].join('\n');
}

/**
 * Check if a job failure should be dead-lettered (no more retries).
 */
export function shouldDeadLetter(jobType: JobType, attempts: number): boolean {
  const config = JOB_RETRY_CONFIG[jobType];
  return attempts >= config.maxRetries;
}
