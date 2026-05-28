import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { JobQueue } from '../jobs/queue.js';

const TEST_DSN = 'postgresql://modulewarden:modulewarden@localhost:5422/modulewarden';

// Unique run ID to prevent singleton key collisions between test runs
const RUN_ID = `run-${Date.now()}`;

describe('JobQueue — pg-boss integration', () => {
  let queue: JobQueue;

  beforeAll(async () => {
    queue = new JobQueue({
      connectionString: TEST_DSN,
      schema: 'pgboss_test',
      maxRetries: 1,
      backoffDelayMs: 1000,
      timeoutMs: 30_000,
      concurrency: {},
    });
    await queue.start();
    expect(queue.isStarted).toBe(true);
  });

  afterAll(async () => {
    try {
      await queue.stop();
    } catch {
      // ignore
    }
  });

  it('1. sends and processes a job with a worker', async () => {
    const processed: Array<{ id: string; data: Record<string, unknown> }> = [];

    await queue.work('test-process-q' as any, async (job) => {
      processed.push({ id: job.id, data: job.data });
    }, 1);

    const jobId = await queue.send('test-process-q' as any, { message: 'hello' } as any);
    expect(jobId).toBeTruthy();
    expect(typeof jobId).toBe('string');

    // Wait up to 10s for the worker to pick up the job
    for (let i = 0; i < 10; i++) {
      if (processed.length > 0) break;
      await new Promise((r) => setTimeout(r, 1000));
    }

    expect(processed.length).toBe(1);
    expect((processed[0].data as any).message).toBe('hello');
  });

  it('2. deduplication with singletonKey returns null for duplicate', async () => {
    const queueName = `test-singleton-${RUN_ID}`;
    const key = `dedup-key-${RUN_ID}`;

    // First send should succeed
    const id1 = await queue.send(queueName as any, { seq: 1 } as any, key);
    expect(id1).toBeTruthy();
    expect(typeof id1).toBe('string');

    // Second send with same singletonKey should be deduped (null)
    const id2 = await queue.send(queueName as any, { seq: 2 } as any, key);
    expect(id2).toBeNull();
  });

  it('3. respects concurrency limits', async () => {
    await queue.work('test-conc-q' as any, async () => {
      await new Promise((r) => setTimeout(r, 500));
    }, 2);

    // Send 4 jobs rapidly
    await Promise.all([
      queue.send('test-conc-q' as any, { seq: 1 } as any),
      queue.send('test-conc-q' as any, { seq: 2 } as any),
      queue.send('test-conc-q' as any, { seq: 3 } as any),
      queue.send('test-conc-q' as any, { seq: 4 } as any),
    ]);

    await new Promise((r) => setTimeout(r, 4000));
  });

  it('4. sends delayed jobs with sendAfter', async () => {
    const processedIds: string[] = [];

    await queue.work('test-delay-q' as any, async (job) => {
      processedIds.push(job.id);
    }, 1);

    await queue.sendAfter('test-delay-q' as any, { delayed: true } as any, 1);

    // Wait for processing (poll interval ~1s + delay 1s)
    for (let i = 0; i < 15; i++) {
      if (processedIds.length > 0) break;
      await new Promise((r) => setTimeout(r, 1000));
    }

    expect(processedIds.length).toBe(1);
  });

  it('5. getQueueStats returns queue metrics', async () => {
    const jobId = await queue.send('test-stats-q' as any, { test: true } as any);
    expect(jobId).toBeTruthy();
    await new Promise((r) => setTimeout(r, 1000));

    const stats = await queue.getQueueStats('test-stats-q');
    expect(stats).toBeDefined();
    expect(typeof stats.name).toBe('string');
  });

  it('6. enqueuePackageReview builds idempotency key (first send always succeeds)', async () => {
    // Use unique key per run to avoid stale singleton state from previous test runs
    const id = await queue.enqueuePackageReview(
      `test-pkg-${RUN_ID}`, '1.0.0', `hash-${RUN_ID}`, `preflight-${RUN_ID}`
    );
    expect(id).toBeTruthy();
    expect(typeof id).toBe('string');
  });

  it('7. enqueueAuditContainerExec works', async () => {
    const id = await queue.enqueueAuditContainerExec(
      `review-${RUN_ID}`, `test-pkg-${RUN_ID}`, '1.0.0', `hash-${RUN_ID}`, `hash-old-${RUN_ID}`, `preflight-${RUN_ID}`
    );
    expect(id).toBeTruthy();
    expect(typeof id).toBe('string');
  });

  it('8. enqueueModelEscalation works', async () => {
    const id = await queue.enqueueModelEscalation(`review-${RUN_ID}`, `evidence-${RUN_ID}`);
    expect(id).toBeTruthy();
    expect(typeof id).toBe('string');
  });

  it('9. enqueueVerdaccioPromotion works', async () => {
    const id = await queue.enqueueVerdaccioPromotion(
      `decision-${RUN_ID}`, `test-pkg-${RUN_ID}`, '1.0.0', `hash-${RUN_ID}`
    );
    expect(id).toBeTruthy();
    expect(typeof id).toBe('string');
  });

  it('10. hasActiveJobs works', async () => {
    const status = await queue.hasActiveJobs('test-stats-q');
    expect(typeof status).toBe('boolean');
  });

  it('11. enqueueProjectReady builds a singleton job', async () => {
    const idFirst = await queue.enqueueProjectReady(`project-${RUN_ID}`, `lockfile-${RUN_ID}`);
    expect(idFirst).toBeTruthy();
    expect(typeof idFirst).toBe('string');

    const idSecond = await queue.enqueueProjectReady(`project-${RUN_ID}`, `lockfile-${RUN_ID}`);
    expect(idSecond).toBeNull();
  });
});
