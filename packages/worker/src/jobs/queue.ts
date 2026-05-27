import PgBoss from 'pg-boss';
import { buildIdempotencyKey } from '@modulewarden/shared/constants';
import type { JobType, JobPayloads } from '@modulewarden/shared/types';

export type JobHandler<T extends JobType> = (job: { id: string; data: JobPayloads[T] }) => Promise<void>;

export interface QueueOptions {
  connectionString: string;
  schema?: string;
  maxRetries?: number;
  backoffDelayMs?: number;
  timeoutMs?: number;
  concurrency?: Record<string, number>;
}

const DEFAULT_OPTIONS: Required<Pick<QueueOptions, 'maxRetries' | 'backoffDelayMs' | 'timeoutMs'>> = {
  maxRetries: 3,
  backoffDelayMs: 30_000,
  timeoutMs: 600_000,
};

/**
 * ModuleWarden pg-boss queue wrapper.
 *
 * Provides typed job submission, worker registration, scheduling, and
 * configuration for all ModuleWarden job types. Postgres is the only
 * backing store; no Redis or separate queue broker is used.
 */
export class JobQueue {
  private boss: PgBoss;
  private started = false;
  private options: Required<Pick<QueueOptions, 'maxRetries' | 'backoffDelayMs' | 'timeoutMs'>>;
  private concurrency: Record<string, number>;

  constructor(opts: QueueOptions) {
    this.boss = new PgBoss({
      connectionString: opts.connectionString,
      schema: opts.schema ?? 'pgboss',
    });

    this.options = {
      ...DEFAULT_OPTIONS,
      maxRetries: opts.maxRetries ?? DEFAULT_OPTIONS.maxRetries,
      backoffDelayMs: opts.backoffDelayMs ?? DEFAULT_OPTIONS.backoffDelayMs,
      timeoutMs: opts.timeoutMs ?? DEFAULT_OPTIONS.timeoutMs,
    };

    this.concurrency = opts.concurrency ?? {};
  }

  // ── Lifecycle ─────────────────────────────────────────────────

  /** Start the pg-boss instance and apply migrations. */
  async start(): Promise<void> {
    await this.boss.start();
    this.started = true;
  }

  /** Stop the pg-boss instance gracefully. */
  async stop(): Promise<void> {
    await this.boss.stop();
    this.started = false;
  }

  get isStarted(): boolean {
    return this.started;
  }

  // ── Job Submission ─────────────────────────────────────────────

  private buildSendOptions(
    singletonKey?: string,
    extra?: Partial<PgBoss.SendOptions>
  ): PgBoss.SendOptions {
    const options: PgBoss.SendOptions = {
      retryLimit: this.options.maxRetries,
      retryBackoff: true,
      retryDelay: this.options.backoffDelayMs,
      expireInSeconds: Math.ceil(this.options.timeoutMs / 1000),
      priority: 0,
      ...extra,
    };
    if (singletonKey) {
      options.singletonKey = singletonKey;
      options.singletonSeconds = 86400; // Dedup within 24h
    }
    return options;
  }

  /**
   * Enqueue a job with retry, timeout, and optional deduplication.
   */
  async send<T extends JobType>(
    name: T,
    data: JobPayloads[T],
    singletonKey?: string
  ): Promise<string | null> {
    await this.ensureQueue(name);
    return this.boss.send(name, data as Record<string, unknown>, this.buildSendOptions(singletonKey));
  }

  /**
   * Schedule a job to run after a delay (in seconds).
   */
  async sendAfter<T extends JobType>(
    name: T,
    data: JobPayloads[T],
    delaySeconds: number,
    singletonKey?: string
  ): Promise<string | null> {
    await this.ensureQueue(name);
    return this.boss.send(
      name,
      data as Record<string, unknown>,
      this.buildSendOptions(singletonKey, { startAfter: delaySeconds })
    );
  }

  /**
   * Enqueue a package review job with deterministic idempotency key.
   */
  async enqueuePackageReview(
    packageName: string,
    packageVersion: string,
    tarballHash: string,
    auditContext: string
  ): Promise<string | null> {
    const idempotencyKey = buildIdempotencyKey(
      'package-review',
      packageName,
      packageVersion,
      tarballHash,
      auditContext
    );
    return this.send('package-review', {
      packageName,
      packageVersion,
      tarballHash,
      auditContext,
      idempotencyKey,
    }, idempotencyKey);
  }

  /**
   * Enqueue an audit container execution job.
   */
  async enqueueAuditContainerExec(
    reviewJobId: string,
    packageName: string,
    packageVersion: string,
    tarballHash: string,
    predecessorHash: string | null,
    auditContext: string
  ): Promise<string | null> {
    const data: JobPayloads['audit-container-exec'] = {
      reviewJobId,
      packageName,
      packageVersion,
      tarballHash,
      predecessorHash,
      auditContext,
    };
    return this.send('audit-container-exec', data, `mw:container:${reviewJobId}`);
  }

  /**
   * Enqueue a model escalation job.
   */
  async enqueueModelEscalation(reviewJobId: string, evidenceBundleId: string): Promise<string | null> {
    return this.send('model-escalation', { reviewJobId, evidenceBundleId }, `mw:escalation:${reviewJobId}`);
  }

  /**
   * Enqueue a Verdaccio promotion job.
   */
  async enqueueVerdaccioPromotion(
    decisionId: string,
    packageName: string,
    packageVersion: string,
    tarballHash: string
  ): Promise<string | null> {
    return this.send('verdaccio-promotion', { decisionId, packageName, packageVersion, tarballHash }, `mw:promotion:${decisionId}`);
  }

  /**
   * Enqueue an evidence post-processing job.
   */
  async enqueueEvidencePostProcess(auditRunId: string, evidenceBundleId: string): Promise<string | null> {
    return this.send('evidence-post-process', { auditRunId, evidenceBundleId }, `mw:evidence:${auditRunId}:${evidenceBundleId}`);
  }

  /**
   * Enqueue a re-audit campaign job.
   */
  async enqueueReAuditCampaign(campaignId: string, reason: string): Promise<string | null> {
    return this.send('re-audit-campaign', { campaignId, reason }, `mw:reaudit:${campaignId}`);
  }

  /**
   * Enqueue an upstream subscription poll job.
   */
  async enqueueUpstreamPoll(packageName: string): Promise<string | null> {
    return this.send('upstream-subscription-poll', { packageName }, `mw:poll:${packageName}`);
  }

  // ── Worker Registration ───────────────────────────────────────

  /**
   * Register a worker for a job type with configurable concurrency.
   */
  async work<T extends JobType>(
    name: T,
    handler: JobHandler<T>,
    concurrency?: number
  ): Promise<string> {
    await this.ensureQueue(name);
    const maxConcurrency = concurrency ?? this.concurrency[name as string] ?? 1;
    const options: PgBoss.WorkOptions = { batchSize: maxConcurrency };

    const workerId = await this.boss.work<JobPayloads[T]>(name, options, async (jobs) => {
      await Promise.all(
        jobs.map(async (job) => {
          try {
            await handler({ id: job.id, data: job.data });
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            await this.boss.fail(name, job.id, { error: message });
            throw err;
          }
        })
      );
    });
    return workerId;
  }

  // ── Scheduling ────────────────────────────────────────────────

  /**
   * Schedule a recurring job via cron expression.
   */
  async schedule(
    name: string,
    cron: string,
    data?: Record<string, unknown>,
    options?: Partial<PgBoss.ScheduleOptions>
  ): Promise<void> {
    await this.boss.schedule(name, cron, data, {
      retryLimit: this.options.maxRetries,
      retryBackoff: true,
      retryDelay: this.options.backoffDelayMs,
      expireInSeconds: Math.ceil(this.options.timeoutMs / 1000),
      ...options,
    });
  }

  /** Remove a scheduled job. */
  async unschedule(name: string): Promise<void> {
    await this.boss.unschedule(name);
  }

  // ── Queue Management ──────────────────────────────────────────

  private readonly createdQueues = new Set<string>();

  /**
   * Ensure a queue exists before sending jobs.
   * Auto-creates if not already created in this session.
   */
  private async ensureQueue(name: string): Promise<void> {
    if (!this.createdQueues.has(name)) {
      await this.boss.createQueue(name);
      this.createdQueues.add(name);
    }
  }

  /** Create a queue with specific options. */
  async createQueue(
    name: string,
    options?: Partial<PgBoss.QueueOptions>
  ): Promise<void> {
    await this.boss.createQueue(name, options);
    this.createdQueues.add(name);
  }

  /** Get statistics for a queue. */
  async getQueueStats(name: string): Promise<PgBoss.QueueResult> {
    return this.boss.getQueueStats(name);
  }

  // ── Monitoring ────────────────────────────────────────────────

  /** Get the count of pending jobs for a queue. */
  async getPendingCount(name: string): Promise<number> {
    await this.ensureQueue(name);
    const stats = await this.boss.getQueueStats(name);
    return stats.queuedCount;
  }

  /** Check if a queue has any pending or active jobs. */
  async hasActiveJobs(name: string): Promise<boolean> {
    await this.ensureQueue(name);
    const stats = await this.boss.getQueueStats(name);
    return stats.queuedCount + stats.activeCount > 0;
  }
}
