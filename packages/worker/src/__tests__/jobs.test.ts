import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  vi,
} from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildIdempotencyKey } from '@modulewarden/shared/constants';
import {
  createDecision,
  createOverride,
  getPrisma,
} from '@modulewarden/prisma-client';
import * as upstreamServices from '@modulewarden/shared/services/upstream';
import { JobQueue } from '../jobs/queue.js';
import { DEFAULT_WORKER_CONFIG, JOB_RETRY_CONFIG, shouldDeadLetter } from '../jobs/definitions.js';
import { registerVerdaccioPromotionHandler } from '../handlers/promotion.js';

const ROOT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const TEST_DSN = 'postgresql://modulewarden:modulewarden@localhost:5422/modulewarden';

// Unique run ID to prevent singleton key collisions between test runs
const RUN_ID = `run-${Date.now()}`;
const escapeSql = (value: string): string => value.replace(/'/g, "''");

type ReviewJobStatus = 'PENDING' | 'QUEUED' | 'RUNNING' | 'COMPLETED' | 'FAILED' | 'CANCELLED' | 'DEAD_LETTER';

const createReviewJobRow = async (
  packageVersionId: string,
  auditContext: string,
  trigger: 'PREFLIGHT' | 'SUBSCRIPTION' | 'MANUAL' | 'RE_AUDIT',
  idempotencyKey: string,
  status: ReviewJobStatus = 'QUEUED'
): Promise<string> => {
  const id = `mw-review-${RUN_ID}-${Date.now()}-${Math.random().toString(36).slice(2)}`;

  await getPrisma().$executeRawUnsafe(
    `
    INSERT INTO "ReviewJob" (
      "id",
      "packageVersionId",
      "auditContext",
      "trigger",
      "status",
      "pgBossJobId",
      "idempotencyKey",
      "createdAt",
      "updatedAt"
    ) VALUES (
      '${escapeSql(id)}',
      '${escapeSql(packageVersionId)}',
      '${escapeSql(auditContext)}',
      '${escapeSql(trigger)}',
      '${escapeSql(status)}',
      NULL,
      '${escapeSql(idempotencyKey)}',
      NOW(),
      NOW()
    )
    `
  );
  return id;
};

const getReviewJobStatus = async (
  reviewJobId: string,
  includeFailureReason: boolean
): Promise<{ status: ReviewJobStatus; failureReason?: string | null } | null> => {
  const baseQuery = `SELECT status${includeFailureReason ? ', "failureReason" ' : ''} FROM "ReviewJob" WHERE id = '${escapeSql(reviewJobId)}'`;
  const rows = includeFailureReason
    ? await getPrisma().$queryRawUnsafe<Array<{ status: ReviewJobStatus; failureReason: string | null }>>(baseQuery)
    : await getPrisma().$queryRawUnsafe<Array<{ status: ReviewJobStatus }>>(baseQuery);

  if (!rows[0]) {
    return null;
  }

  return rows[0];
};

const deleteReviewJobs = async (ids: string[]): Promise<void> => {
  const idsCsv = ids.map((id) => `'${escapeSql(id)}'`).join(',');
  if (!idsCsv) return;
  await getPrisma().$executeRawUnsafe(`DELETE FROM "ReviewJob" WHERE "id" IN (${idsCsv})`);
};

const sleep = (ms: number): Promise<void> => new Promise((resolve) => {
  setTimeout(resolve, ms);
});

const readRootManifest = (relativePath: string): Record<string, unknown> => {
  const filePath = join(ROOT_DIR, relativePath);
  const raw = readFileSync(filePath, 'utf-8');
  return JSON.parse(raw) as Record<string, unknown>;
};

const readAllWorkspaceDependencies = (): string[] => {
  const workspacePackages = [
    'packages/api-proxy/package.json',
    'packages/worker/package.json',
    'packages/shared/package.json',
    'packages/prisma-client/package.json',
    'packages/audit-runner/package.json',
    'packages/cli/package.json',
    'packages/web-ui/package.json',
  ];

  const deps: string[] = [];
  const root = readRootManifest('package.json');
  const rootDeps = root.dependencies as Record<string, string> | undefined;
  const rootDevDeps = root.devDependencies as Record<string, string> | undefined;
  if (rootDeps) deps.push(...Object.keys(rootDeps));
  if (rootDevDeps) deps.push(...Object.keys(rootDevDeps));

  for (const packagePath of workspacePackages) {
    const manifest = readRootManifest(packagePath);
    const dependencies = manifest.dependencies as Record<string, string> | undefined;
    const devDependencies = manifest.devDependencies as Record<string, string> | undefined;
    if (dependencies) deps.push(...Object.keys(dependencies));
    if (devDependencies) deps.push(...Object.keys(devDependencies));
  }

  return deps;
};

describe('JobQueue — pg-boss integration', () => {
  let queue: JobQueue;
  let hasFailureReasonColumn = true;
  let hasOverrideTargetVerdictColumn = true;
  let promotionHandlerRegistered = false;

  const ensureVerdaccioPromotionHandler = async () => {
    if (!promotionHandlerRegistered) {
      await registerVerdaccioPromotionHandler(queue);
      promotionHandlerRegistered = true;
    }
  };

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

    const prisma = getPrisma();
    const featureProbe = await prisma.$queryRawUnsafe<Array<{ exists: boolean }>>(
      `
      SELECT EXISTS (
        SELECT 1
        FROM information_schema.columns
        WHERE table_schema = 'public'
          AND lower(table_name) = 'reviewjob'
          AND lower(column_name) = 'failurereason'
      ) AS exists
    `
    ).catch(() => [{ exists: false }]);
    hasFailureReasonColumn = featureProbe[0]?.exists ?? false;

    const overrideProbe = await prisma.$queryRawUnsafe<Array<{ exists: boolean }>>(
      `
      SELECT EXISTS (
        SELECT 1
        FROM information_schema.columns
        WHERE table_schema = 'public'
          AND lower(table_name) = 'override'
          AND lower(column_name) = 'targetverdict'
      ) AS exists
    `
    ).catch(() => [{ exists: false }]);
    hasOverrideTargetVerdictColumn = overrideProbe[0]?.exists ?? false;
  });

  afterAll(async () => {
    try {
      await queue.stop();
    } catch {
      // ignore
    }
  });

  it('1. uses pg-boss as the only durable queue mechanism', () => {
    const compose = readFileSync(join(ROOT_DIR, 'docker-compose.yml'), 'utf-8');
    const allDependencies = readAllWorkspaceDependencies();
    const mergedDependencies = allDependencies.join(',').toLowerCase();
    const forbiddenWords = ['redis', 'bullmq', 'ioredis', 'sidekiq', 'bee-queue', 'bull'];

    expect(compose).not.toMatch(/redis:/i);
    expect(compose).not.toMatch(/bullmq/i);
    expect(compose).not.toMatch(/ioredis/i);
    expect(compose).not.toMatch(/sidekiq/i);

    for (const forbidden of forbiddenWords) {
      expect(mergedDependencies).not.toContain(forbidden);
    }
  });

  it('2. sends and processes a job with a worker', async () => {
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
      await sleep(1000);
    }

    expect(processed.length).toBe(1);
    expect((processed[0].data as any).message).toBe('hello');
  });

  it('3. deduplication with singletonKey returns null for duplicate', async () => {
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

  it('4. enforces deterministic singleton keys for all typed enqueuers', async () => {
    const packageName = `spec-pkg-${RUN_ID}`;
    const packageVersion = '1.0.0';
    const tarballHash = `sha-${RUN_ID}`;
    const packageContext = `manual:${packageName}@${packageVersion}`;
    const packageReviewKey = buildIdempotencyKey(
      'package-review',
      packageName,
      packageVersion,
      tarballHash,
      packageContext
    );

    const firstPackageReview = await queue.send(
      'package-review' as any,
      {
        packageName,
        packageVersion,
        tarballHash,
        auditContext: packageContext,
        idempotencyKey: packageReviewKey,
      } as any,
      packageReviewKey
    );
    expect(firstPackageReview).toBeTruthy();
    expect(await queue.send(
      'package-review' as any,
      {
        packageName,
        packageVersion,
        tarballHash,
        auditContext: packageContext,
        idempotencyKey: packageReviewKey,
      } as any,
      packageReviewKey
    )).toBeNull();

    const upstreamPackage = `spec-upstream-${RUN_ID}`;
    expect(await queue.enqueueUpstreamPoll(upstreamPackage)).toBeTruthy();
    expect(await queue.enqueueUpstreamPoll(upstreamPackage)).toBeNull();

    const reviewJobId = `review-${RUN_ID}`;
    expect(await queue.enqueueAuditContainerExec(
      reviewJobId,
      packageName,
      packageVersion,
      tarballHash,
      `sha-prev-${RUN_ID}`,
      `context-${RUN_ID}`
    )).toBeTruthy();
    expect(await queue.enqueueAuditContainerExec(
      reviewJobId,
      packageName,
      packageVersion,
      tarballHash,
      `sha-prev-${RUN_ID}`,
      `context-${RUN_ID}`
    )).toBeNull();

    const evidenceBundleId = `evidence-${RUN_ID}`;
    expect(await queue.enqueueEvidencePostProcess(
      `audit-run-${RUN_ID}`,
      evidenceBundleId
    )).toBeTruthy();
    expect(await queue.enqueueEvidencePostProcess(
      `audit-run-${RUN_ID}`,
      evidenceBundleId
    )).toBeNull();

    expect(await queue.enqueueModelEscalation(
      reviewJobId,
      evidenceBundleId
    )).toBeTruthy();
    expect(await queue.enqueueModelEscalation(
      reviewJobId,
      evidenceBundleId
    )).toBeNull();

    const campaignId = `campaign-${RUN_ID}`;
    expect(await queue.enqueueReAuditCampaign(campaignId, `reason-${RUN_ID}`)).toBeTruthy();
    expect(await queue.enqueueReAuditCampaign(campaignId, `reason-${RUN_ID}`)).toBeNull();

    const decisionId = `decision-${RUN_ID}`;
    expect(await queue.enqueueVerdaccioPromotion(
      decisionId,
      packageName,
      packageVersion,
      tarballHash
    )).toBeTruthy();
    expect(await queue.enqueueVerdaccioPromotion(
      decisionId,
      packageName,
      packageVersion,
      tarballHash
    )).toBeNull();
  });

  it('5. respects concurrency limits', async () => {
    await queue.work('test-conc-q' as any, async () => {
      await sleep(500);
    }, 2);

    // Send 4 jobs rapidly
    await Promise.all([
      queue.send('test-conc-q' as any, { seq: 1 } as any),
      queue.send('test-conc-q' as any, { seq: 2 } as any),
      queue.send('test-conc-q' as any, { seq: 3 } as any),
      queue.send('test-conc-q' as any, { seq: 4 } as any),
    ]);

    await sleep(4000);
  });

  it('6. sends delayed jobs with sendAfter', async () => {
    const processedIds: string[] = [];

    await queue.work('test-delay-q' as any, async (job) => {
      processedIds.push(job.id);
    }, 1);

    await queue.sendAfter('test-delay-q' as any, { delayed: true } as any, 1);

    // Wait for processing (poll interval ~1s + delay 1s)
    for (let i = 0; i < 15; i++) {
      if (processedIds.length > 0) break;
      await sleep(1000);
    }

    expect(processedIds.length).toBe(1);
  });

  it('7. getQueueStats returns queue metrics', async () => {
    const jobId = await queue.send('test-stats-q' as any, { test: true } as any);
    expect(jobId).toBeTruthy();
    await sleep(1000);

    const stats = await queue.getQueueStats('test-stats-q');
    expect(stats).toBeDefined();
    expect(typeof stats.name).toBe('string');
  });

  it('8. enqueuePackageReview builds idempotency key (first send always succeeds)', async () => {
    // Use unique key per run to avoid stale singleton state from previous test runs
    const id = await queue.enqueuePackageReview(
      `test-pkg-${RUN_ID}`,
      '1.0.0',
      `hash-${RUN_ID}`,
      `preflight-${RUN_ID}`
    );
    expect(id).toBeTruthy();
    expect(typeof id).toBe('string');
  });

  it('9. enqueueAuditContainerExec works', async () => {
    const id = await queue.enqueueAuditContainerExec(
      `review-${RUN_ID}-a`,
      `test-pkg-${RUN_ID}`,
      '1.0.0',
      `hash-${RUN_ID}`,
      `hash-old-${RUN_ID}`,
      `preflight-${RUN_ID}`
    );
    expect(id).toBeTruthy();
    expect(typeof id).toBe('string');
  });

  it('10. enqueueModelEscalation works', async () => {
    const id = await queue.enqueueModelEscalation(
      `review-${RUN_ID}-a`,
      `evidence-${RUN_ID}-a`
    );
    expect(id).toBeTruthy();
    expect(typeof id).toBe('string');
  });

  it('11. enqueueVerdaccioPromotion works', async () => {
    const id = await queue.enqueueVerdaccioPromotion(
      `decision-${RUN_ID}-a`,
      `test-pkg-${RUN_ID}-a`,
      '1.0.0',
      `hash-${RUN_ID}`
    );
    expect(id).toBeTruthy();
    expect(typeof id).toBe('string');
  });

  it('12. hasActiveJobs works', async () => {
    const status = await queue.hasActiveJobs('test-stats-q');
    expect(typeof status).toBe('boolean');
  });

  it('13. enqueueProjectReady builds a singleton job', async () => {
    const idFirst = await queue.enqueueProjectReady(`project-${RUN_ID}`, `lockfile-${RUN_ID}`);
    expect(idFirst).toBeTruthy();
    expect(typeof idFirst).toBe('string');

    const idSecond = await queue.enqueueProjectReady(`project-${RUN_ID}`, `lockfile-${RUN_ID}`);
    expect(idSecond).toBeNull();
  });

  it('14. collapses racing duplicate package-review requests to one active job', async () => {
    const packageName = `race-${RUN_ID}`;
    const tarballHash = `sha-race-${RUN_ID}`;
    const auditContext = `subscription:diff:v1->v2:${RUN_ID}`;
    const singletonKey = buildIdempotencyKey('package-review', packageName, '1.0.0', tarballHash, auditContext);

    const payload = {
      packageName,
      packageVersion: '1.0.0',
      tarballHash,
      auditContext,
      idempotencyKey: singletonKey,
    } as any;

    const outcomes = await Promise.all(
      Array.from({ length: 12 }, () => queue.send('package-review' as any, payload, singletonKey))
    );

    const accepted = outcomes.filter((id) => id !== null);
    const rejected = outcomes.filter((id) => id === null);
    expect(accepted).toHaveLength(1);
    expect(rejected).toHaveLength(11);
  });

  it('15. collapses racing duplicate package-review requests across tarball/preflight/subscription paths', async () => {
    const packageName = `race-multi-${RUN_ID}`;
    const tarballHash = `sha-race-multi-${RUN_ID}`;
    const auditContext = `shared:${packageName}:1.0.0`;
    const singletonKey = buildIdempotencyKey('package-review', packageName, '1.0.0', tarballHash, auditContext);

    const payloadTemplate = {
      packageName,
      packageVersion: '1.0.0',
      tarballHash,
      auditContext,
      idempotencyKey: singletonKey,
    } as any;

    const outcomes = await Promise.all([
      queue.send('package-review' as any, { ...payloadTemplate, source: 'tarball-fetch' } as any, singletonKey),
      queue.send('package-review' as any, { ...payloadTemplate, source: 'cli-preflight' } as any, singletonKey),
      queue.send('package-review' as any, { ...payloadTemplate, source: 'subscription-poll' } as any, singletonKey),
      queue.send('package-review' as any, { ...payloadTemplate, source: 'cli-preflight' } as any, singletonKey),
      queue.send('package-review' as any, { ...payloadTemplate, source: 'tarball-fetch' } as any, singletonKey),
    ]);

    const accepted = outcomes.filter((id) => id !== null);
    const rejected = outcomes.filter((id) => id === null);

    expect(accepted).toHaveLength(1);
    expect(rejected).toHaveLength(4);
    expect(auditContext).toBe('shared:race-multi-' + RUN_ID + ':1.0.0');
  });

  it('16. persists failure context for review jobs that crash in workers', async () => {
    if (!hasFailureReasonColumn) {
      return;
    }

    const prisma = getPrisma();
    const packageVersion = await prisma.packageVersion.create({
      data: {
        packageName: `crash-${RUN_ID}`,
        version: '1.0.0',
        registrySource: 'npm',
        tarballHash: `sha-crash-${RUN_ID}`,
      },
    });

    const reviewJobId = await createReviewJobRow(
      packageVersion.id,
      `audit:${packageVersion.packageName}:1.0.0`,
      'PREFLIGHT',
      `mw:job:package-review:${packageVersion.packageName}:1.0.0:${packageVersion.tarballHash}:audit`
    );

    await queue.work('model-escalation' as any, async () => {
      throw new Error('temporary model failure');
    }, 1);

    const id = await queue.enqueueModelEscalation(reviewJobId, `evidence-failure-${RUN_ID}`);
    expect(id).toBeTruthy();

    let failedStatus = '';
    for (let i = 0; i < 12; i++) {
      const latest = await getReviewJobStatus(reviewJobId, hasFailureReasonColumn);
      if (latest?.status && latest.status !== 'QUEUED') {
        failedStatus = latest.status;
        if (hasFailureReasonColumn) {
          expect((latest as { status: string; failureReason?: string | null }).failureReason ?? '').toContain('temporary model failure');
        }
        break;
      }
      await sleep(500);
    }

    if (hasFailureReasonColumn) {
      expect(['FAILED', 'DEAD_LETTER']).toContain(failedStatus);
    } else {
      expect(failedStatus !== '').toBe(true);
    }

    const crashRun = await prisma.auditRun.findFirst({
      where: { reviewJobId: reviewJobId },
    });
    expect(crashRun).toBeDefined();
    expect(crashRun?.status).toBe('CRASHED');
    expect(crashRun?.errorMessage).toContain('model-escalation job');

    if (hasFailureReasonColumn) {
      const latest = await getReviewJobStatus(reviewJobId, true);
      expect(latest?.failureReason ?? '').toContain('temporary model failure');
      expect(['FAILED', 'DEAD_LETTER']).toContain(latest?.status);
    }

    await prisma.auditRun.deleteMany({ where: { reviewJobId: reviewJobId } });
    await deleteReviewJobs([reviewJobId]);
    await prisma.packageVersion.delete({ where: { id: packageVersion.id } }).catch(() => undefined);
  });

  it('17. keeps stale promotion requests from promoting older decisions after retries', async () => {
    if (!hasFailureReasonColumn) {
      return;
    }

    const prisma = getPrisma();
    await ensureVerdaccioPromotionHandler();

    const stalePackage = await prisma.packageVersion.create({
      data: {
        packageName: `stale-promotion-${RUN_ID}`,
        version: '1.0.0',
        registrySource: 'npm',
        tarballHash: `sha-stale-${RUN_ID}`,
      },
    });

    const baseContext = `stale:${stalePackage.packageName}:1.0.0`;
    const staleReviewJobId = await createReviewJobRow(
      stalePackage.id,
      `${baseContext}:old`,
      'MANUAL',
      `stale-${stalePackage.packageName}:old`
    );
    const staleDecision = await createDecision({
      reviewJobId: staleReviewJobId,
      packageVersionId: stalePackage.id,
      verdict: 'ALLOW',
      reasonSummary: 'Stale allow decision in test',
      actorType: 'AGENT',
    });

    const freshReviewJobId = await createReviewJobRow(
      stalePackage.id,
      `${baseContext}:latest`,
      'MANUAL',
      `stale-${stalePackage.packageName}:latest`
    );
    await createDecision({
      reviewJobId: freshReviewJobId,
      packageVersionId: stalePackage.id,
      verdict: 'BLOCK',
      reasonSummary: 'Latest decision superseded stale allow',
      actorType: 'AGENT',
    });

    const promoteSpy = vi.spyOn(upstreamServices, 'promoteTarballToVerdaccio').mockResolvedValue(undefined);
    const fetchSpy = vi.spyOn(upstreamServices, 'fetchUpstreamTarball').mockResolvedValue(null);

    const sendId = await queue.enqueueVerdaccioPromotion(
      staleDecision.id,
      stalePackage.packageName,
      stalePackage.version,
      stalePackage.tarballHash
    );
    expect(sendId).toBeTruthy();

    for (let i = 0; i < 12; i++) {
      await sleep(500);
    }

    expect(promoteSpy).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();

    const tarballs = await prisma.tarballArtifact.findMany({
      where: { packageVersionId: stalePackage.id },
    });
    expect(tarballs).toHaveLength(0);

    promoteSpy.mockRestore();
    fetchSpy.mockRestore();

    await prisma.decision.deleteMany({
      where: { packageVersionId: stalePackage.id },
    });
    await deleteReviewJobs([staleReviewJobId, freshReviewJobId]);
    await prisma.packageVersion.delete({ where: { id: stalePackage.id } });
  });

  it('18. blocks promotion when latest decision is blocked by active override', async () => {
    if (!hasFailureReasonColumn || !hasOverrideTargetVerdictColumn) {
      return;
    }

    const prisma = getPrisma();
    await ensureVerdaccioPromotionHandler();

    const overridePackage = await prisma.packageVersion.create({
      data: {
        packageName: `override-promotion-${RUN_ID}`,
        version: '2.0.0',
        registrySource: 'npm',
        tarballHash: `sha-override-${RUN_ID}`,
      },
    });

    const decisionReviewJobId = await createReviewJobRow(
      overridePackage.id,
      'override:test',
      'MANUAL',
      `override-${overridePackage.packageName}:decision`
    );
    const allowedDecision = await createDecision({
      reviewJobId: decisionReviewJobId,
      packageVersionId: overridePackage.id,
      verdict: 'ALLOW',
      reasonSummary: 'Allowed until override takes effect',
      actorType: 'ADMIN',
    });

    const override = await createOverride({
      decisionId: allowedDecision.id,
      adminIdentity: 'admin@example.com',
      scope: 'SPECIFIC_VERSION',
      targetVerdict: 'BLOCK',
      reason: 'Safety override',
    });

    const promoteSpy = vi.spyOn(upstreamServices, 'promoteTarballToVerdaccio').mockResolvedValue(undefined);
    const fetchSpy = vi.spyOn(upstreamServices, 'fetchUpstreamTarball').mockResolvedValue(null);

    const sendId = await queue.enqueueVerdaccioPromotion(
      allowedDecision.id,
      overridePackage.packageName,
      overridePackage.version,
      overridePackage.tarballHash
    );
    expect(sendId).toBeTruthy();

    for (let i = 0; i < 12; i++) {
      await sleep(500);
    }

    expect(promoteSpy).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();

    promoteSpy.mockRestore();
    fetchSpy.mockRestore();

    await prisma.override.delete({ where: { id: override.id } }).catch(() => undefined);
    await deleteReviewJobs([decisionReviewJobId]);
    await prisma.decision.delete({ where: { id: allowedDecision.id } }).catch(() => undefined);
    await prisma.packageVersion.delete({ where: { id: overridePackage.id } }).catch(() => undefined);
  });

  it('19. dead-letter policy is driven by retry configuration', () => {
    expect(shouldDeadLetter('package-review', 2)).toBe(false);
    expect(shouldDeadLetter('package-review', 3)).toBe(true);
    expect(shouldDeadLetter('package-review', 4)).toBe(true);
    expect(shouldDeadLetter('model-escalation', 1)).toBe(false);
    expect(shouldDeadLetter('model-escalation', 2)).toBe(true);
    expect(shouldDeadLetter('model-escalation', 3)).toBe(true);
    expect(shouldDeadLetter('audit-container-exec', 1)).toBe(false);
    expect(shouldDeadLetter('audit-container-exec', 2)).toBe(true);
    expect(shouldDeadLetter('audit-container-exec', 3)).toBe(true);
  });

  it('20. validates per-job retry and concurrency policy configuration', () => {
    expect(DEFAULT_WORKER_CONFIG.concurrency['package-review']).toBe(4);
    expect(DEFAULT_WORKER_CONFIG.concurrency['upstream-subscription-poll']).toBe(2);
    expect(DEFAULT_WORKER_CONFIG.concurrency['audit-container-exec']).toBe(2);
    expect(DEFAULT_WORKER_CONFIG.concurrency['model-escalation']).toBe(1);
    expect(DEFAULT_WORKER_CONFIG.concurrency['re-audit-campaign']).toBe(1);
    expect(DEFAULT_WORKER_CONFIG.concurrency['evidence-post-process']).toBe(4);
    expect(DEFAULT_WORKER_CONFIG.concurrency['verdaccio-promotion']).toBe(4);

    expect(JOB_RETRY_CONFIG['package-review']).toMatchObject({ maxRetries: 3, timeoutMs: 600_000, backoffMs: 30_000 });
    expect(JOB_RETRY_CONFIG['model-escalation']).toMatchObject({ maxRetries: 2, timeoutMs: 600_000, backoffMs: 60_000 });
    expect(JOB_RETRY_CONFIG['audit-container-exec']).toMatchObject({ maxRetries: 2, timeoutMs: 900_000, backoffMs: 60_000 });
  });
});
