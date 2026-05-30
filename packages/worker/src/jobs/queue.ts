import PgBoss from 'pg-boss';
import { getPrisma } from '@modulewarden/prisma-client';
import { buildIdempotencyKey, canonicalReviewAuditContext } from '@modulewarden/shared/constants';
import type { JobType, JobPayloads } from '@modulewarden/shared/types';
import { JOB_RETRY_CONFIG, shouldDeadLetter } from './definitions.js';

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
    this.boss.on('error', (err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      const stack = err instanceof Error ? err.stack : undefined;
      console.error(JSON.stringify({
        level: 'error',
        time: new Date().toISOString(),
        msg: 'pg-boss emitted an error',
        error: message,
        stack,
      }));
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
    jobType?: JobType,
    extra?: Partial<PgBoss.SendOptions>
  ): PgBoss.SendOptions {
    const policy = jobType ? JOB_RETRY_CONFIG[jobType] : null;
    const options: PgBoss.SendOptions = {
      retryLimit: policy?.maxRetries ?? this.options.maxRetries,
      retryBackoff: true,
      // Convert backoff from milliseconds to seconds (pg-boss uses seconds)
      retryDelay: Math.ceil((policy?.backoffMs ?? this.options.backoffDelayMs) / 1000),
      expireInSeconds: Math.ceil((policy?.timeoutMs ?? this.options.timeoutMs) / 1000),
      priority: 0,
      ...extra,
    };
    if (singletonKey) {
      options.singletonKey = singletonKey;
      options.singletonSeconds = policy?.singletonSeconds ?? 300;
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
    return this.boss.send(name, data as Record<string, unknown>, this.buildSendOptions(singletonKey, name));
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
      this.buildSendOptions(singletonKey, name, { startAfter: delaySeconds })
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
    const normalizedAuditContext = canonicalReviewAuditContext(auditContext);
    const idempotencyKey = buildIdempotencyKey(
      'package-review',
      packageName,
      packageVersion,
      tarballHash,
      normalizedAuditContext
    );
    return this.send('package-review', {
      packageName,
      packageVersion,
      tarballHash,
      auditContext: normalizedAuditContext,
      rawAuditContext: auditContext,
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
    auditContext: string,
    singletonKey?: string
  ): Promise<string | null> {
    const data: JobPayloads['audit-container-exec'] = {
      reviewJobId,
      packageName,
      packageVersion,
      tarballHash,
      predecessorHash,
      auditContext,
    };
    return this.send('audit-container-exec', data, singletonKey ?? `mw:container:${reviewJobId}`);
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
   * Enqueue a project-ready evaluation job.
   */
  async enqueueProjectReady(projectId: string, reason: string): Promise<string | null> {
    return this.send('project-ready', { projectId, reason }, `mw:project-ready:${projectId}`);
  }

  /**
   * Enqueue an evidence post-processing job.
   */
  async enqueueEvidencePostProcess(
    auditRunId: string,
    evidenceBundleId: string,
    decisionId?: string
  ): Promise<string | null> {
    const key = decisionId
      ? `mw:evidence:${auditRunId}:${decisionId}`
      : `mw:evidence:${auditRunId}:${evidenceBundleId}`;
    return this.send(
      'evidence-post-process',
      { auditRunId, evidenceBundleId, ...(decisionId !== undefined ? { decisionId } : {}) },
      key
    );
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
  async enqueueUpstreamPoll(packageName?: string): Promise<string | null> {
    return this.send(
      'upstream-subscription-poll',
      packageName ? { packageName } : {},
      packageName ? `mw:poll:${packageName}` : 'mw:poll:all'
    );
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
            await this.failSingleJob(name, job, err);
          }
        })
      );
    });
    return workerId;
  }

  private async failSingleJob<T extends JobType>(
    name: T,
    job: PgBoss.Job<JobPayloads[T]>,
    err: unknown
  ): Promise<void> {
    const message = err instanceof Error ? err.message : String(err);
    const payload = job.data as {
      reviewJobId?: string;
      packageName?: string;
      packageVersion?: string;
      auditContext?: string;
    };
    const reviewJobId = payload?.reviewJobId;
    const retryCount = typeof (job as { retryCount?: number }).retryCount === 'number'
      ? (job as { retryCount?: number }).retryCount!
      : 0;
    const willDeadLetter = typeof JOB_RETRY_CONFIG[name] !== 'undefined'
      ? shouldDeadLetter(name, retryCount + 1)
      : false;

    try {
      if (reviewJobId) {
        await this.markReviewJobFailed(reviewJobId, message, willDeadLetter);
      }

      await this.persistFailureContext({
        reviewJobId,
        name,
        jobId: job.id,
        error: message,
      });

      await this.boss.fail(name, job.id, { error: message });
    } catch (failErr) {
      const failMessage = failErr instanceof Error ? failErr.message : String(failErr);
      console.error(JSON.stringify({
        level: 'error',
        time: new Date().toISOString(),
        msg: 'Failed to persist job failure state',
        queue: name,
        jobId: job.id,
        originalError: message,
        error: failMessage,
      }));
      throw failErr;
    }
  }

  private async markReviewJobFailed(
    reviewJobId: string,
    failureReason: string,
    deadLetter: boolean
  ): Promise<void> {
    const status = deadLetter ? 'DEAD_LETTER' : 'FAILED';

    if (deadLetter) {
      // OBS-03: Log dead-lettered jobs at error level for alerting/monitoring
      console.error(
        JSON.stringify({
          level: 'error',
          time: new Date().toISOString(),
          msg: `Job dead-lettered`,
          reviewJobId,
          status,
          failureReason,
        })
      );
    }

    await this.updateReviewJobFailureState(reviewJobId, status, failureReason);
  }

  /**
   * Cancel a queued/active job and persist cancellation context on the review row.
   */
  async cancelJob<T extends JobType>(name: T, jobId: string): Promise<boolean> {
    const job = await this.boss.getJobById(name, jobId);
    if (!job) {
      return false;
    }

    const payload = job.data as { reviewJobId?: string };
    const reviewJobId = payload?.reviewJobId;

    await this.boss.cancel(name, jobId);

    if (reviewJobId) {
      await this.updateReviewJobFailureState(reviewJobId, 'CANCELLED', 'Job cancelled before completion');
      await this.persistFailureContext({
        reviewJobId,
        name,
        jobId,
        error: 'job cancelled before completion',
      });
    }

    return true;
  }

  private async updateReviewJobFailureState(
    reviewJobId: string,
    status: 'FAILED' | 'DEAD_LETTER' | 'CANCELLED',
    failureReason: string
  ): Promise<void> {
    const prisma = getPrisma();

    const existing = await prisma.reviewJob.findUnique({
      where: { id: reviewJobId },
      select: { id: true },
    }).catch(() => null);
    if (!existing) {
      return;
    }

    await prisma.reviewJob.update({
      where: { id: reviewJobId },
      data: {
        status,
        // Keep a compact failure summary for forensic correlation.
        failureReason: `${new Date().toISOString()}: ${failureReason}` as any,
      },
    });
  }

  private async persistFailureContext(payload: {
    reviewJobId: string | undefined;
    name: string;
    jobId: string;
    error: string;
  }): Promise<void> {
    const prisma = getPrisma();
    const reviewJobId = payload.reviewJobId;
    if (!reviewJobId) {
      return;
    }

    const existing = await prisma.reviewJob.findUnique({
      where: { id: reviewJobId },
      select: { id: true },
    }).catch(() => null);
    if (!existing) {
      return;
    }

    const now = new Date();
    const existingRuns = await prisma.auditRun.findMany({
      where: { reviewJobId },
      orderBy: { createdAt: 'desc' },
      take: 1,
    });

    if (existingRuns.length === 0) {
      await prisma.auditRun.create({
        data: {
          reviewJobId,
          status: 'CRASHED',
          completedAt: now,
          errorMessage: `${payload.name} job ${payload.jobId} failed: ${payload.error}`,
        },
      }).catch(() => {
        // Ignore failures when auditRun cannot be recorded yet.
      });
      return;
    }

    const latestRun = existingRuns[0];
    if (!latestRun) {
      return;
    }

    await prisma.auditRun.update({
      where: { id: latestRun.id },
      data: {
        status: 'CRASHED',
        completedAt: now,
        errorMessage: `${payload.name} job ${payload.jobId} failed: ${payload.error}`,
      },
    }).catch(() => {
      // Ignore persistence failures; pg-boss still handles retry/dead-letter state.
    });
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
    const typedName = name as JobType;
    const policy = typedName in JOB_RETRY_CONFIG ? JOB_RETRY_CONFIG[typedName] : null;

    await this.boss.schedule(name, cron, data, {
      retryLimit: policy?.maxRetries ?? this.options.maxRetries,
      retryBackoff: true,
      retryDelay: policy?.backoffMs ?? this.options.backoffDelayMs,
      expireInSeconds: Math.ceil((policy?.timeoutMs ?? this.options.timeoutMs) / 1000),
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
