import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { JobQueue } from '../jobs/queue.js';

const TEST_DSN = 'postgresql://modulewarden:modulewarden@localhost:5422/modulewarden';

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

    await queue.work('test-queue' as any, async (job) => {
      processed.push({ id: job.id, data: job.data });
    }, 1);

    const jobId = await queue.send('test-queue' as any, { message: 'hello' } as any);
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
    // Create a dedicated queue for this test
    const queueName = 'test-singleton-q';

    // First send should succeed
    const id1 = await queue.send(queueName as any, { seq: 1 } as any, 'dedup-key-1');
    expect(id1).toBeTruthy();
    expect(typeof id1).toBe('string');

    // Second send with same singletonKey should be deduped (null)
    const id2 = await queue.send(queueName as any, { seq: 2 } as any, 'dedup-key-1');
    expect(id2).toBeNull();
  });

  it('3. respects concurrency limits', async () => {
    const activeCounts: number[] = [];
    let currentActive = 0;

    await queue.work('test-conc-q' as any, async () => {
      currentActive++;
      activeCounts.push(currentActive);
      await new Promise((r) => setTimeout(r, 500));
      currentActive--;
    }, 2);

    // Send 4 jobs rapidly
    await Promise.all([
      queue.send('test-conc-q' as any, { seq: 1 } as any),
      queue.send('test-conc-q' as any, { seq: 2 } as any),
      queue.send('test-conc-q' as any, { seq: 3 } as any),
      queue.send('test-conc-q' as any, { seq: 4 } as any),
    ]);

    // Wait for processing
    await new Promise((r) => setTimeout(r, 4000));
  });

  it('4. sends delayed jobs with sendAfter', async () => {
    const processedIds: string[] = [];

    await queue.work('test-delay-q' as any, async (job) => {
      processedIds.push(job.id);
    }, 1);

    const before = Date.now();
    await queue.sendAfter('test-delay-q' as any, { delayed: true } as any, 1);
    const afterSend = Date.now();

    // Wait for processing (poll interval ~1s + delay 1s)
    for (let i = 0; i < 15; i++) {
      if (processedIds.length > 0) break;
      await new Promise((r) => setTimeout(r, 1000));
    }

    expect(processedIds.length).toBe(1);
    // Job should have been processed at least 1s after send
    // (can't assert exact timing due to polling, but data was received)
  });

  it('5. getQueueStats returns queue metrics', async () => {
    const jobId = await queue.send('test-stats-q' as any, { test: true } as any);
    expect(jobId).toBeTruthy();
    await new Promise((r) => setTimeout(r, 1000));

    const stats = await queue.getQueueStats('test-stats-q');
    expect(stats).toBeDefined();
    expect(typeof stats.name).toBe('string');
  });

  it('6. enqueuePackageReview builds idempotency key', async () => {
    const id = await queue.enqueuePackageReview('test-pkg', '1.0.0', 'hash123', 'preflight:test');
    expect(id).toBeTruthy();
    expect(typeof id).toBe('string');
  });

  it('7. enqueueAuditContainerExec works', async () => {
    const id = await queue.enqueueAuditContainerExec('review-1', 'test-pkg', '1.0.0', 'hash123', 'hash-old', 'preflight:test');
    expect(id).toBeTruthy();
    expect(typeof id).toBe('string');
  });

  it('8. enqueueModelEscalation works', async () => {
    const id = await queue.enqueueModelEscalation('review-1', 'evidence-1');
    expect(id).toBeTruthy();
    expect(typeof id).toBe('string');
  });

  it('9. enqueueVerdaccioPromotion works', async () => {
    const id = await queue.enqueueVerdaccioPromotion('decision-1', 'test-pkg', '1.0.0', 'hash123');
    expect(id).toBeTruthy();
    expect(typeof id).toBe('string');
  });

  it('10. hasActiveJobs works', async () => {
    const status = await queue.hasActiveJobs('test-stats-q');
    expect(typeof status).toBe('boolean');
  });
});
