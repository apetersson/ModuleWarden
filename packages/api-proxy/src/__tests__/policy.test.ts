import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { getPrisma, disconnectPrisma } from '@modulewarden/prisma-client';
import {
  getEffectiveDecision,
  getStatusInfo,
  type StatusInfo,
} from '../services/policy.js';

const RUN_ID = `run-${Date.now()}`;

describe('Policy service — effective decision resolution', () => {
  beforeAll(async () => {
    const prisma = getPrisma();
    await prisma.$connect();
  });

  afterAll(async () => {
    await disconnectPrisma();
  });

  it('returns null for unknown package version', async () => {
    const result = await getEffectiveDecision('nonexistent-pkg', '9.9.9', 'sha512-nope');
    expect(result).toBeNull();
  });

  it('resolves ALLOW based on agent decision', async () => {
    const prisma = getPrisma();
    // Create a package version with an ALLOW decision
    const pv = await prisma.packageVersion.create({
      data: {
        packageName: 'policy-test-allow',
        version: '1.0.0',
        registrySource: 'npm',
        tarballHash: 'sha512-policy-test-allow',
      },
    });
    const job = await prisma.reviewJob.create({
      data: {
        packageVersionId: pv.id,
        auditContext: 'policy:test:allow',
        trigger: 'MANUAL',
        idempotencyKey: `policy:allow:${pv.id}`,
        status: 'COMPLETED',
        decisions: {
          create: {
            packageVersionId: pv.id,
            verdict: 'ALLOW',
            reasonSummary: 'Policy test — allowed',
            actorType: 'AGENT',
          },
        },
      },
    });

    const result = await getEffectiveDecision('policy-test-allow', '1.0.0', 'sha512-policy-test-allow');
    expect(result).not.toBeNull();
    expect(result!.verdict).toBe('ALLOW');
    expect(result!.source).toBe('agent');
    expect(result!.overridden).toBe(false);
    expect(result!.packageName).toBe('policy-test-allow');
    expect(result!.tarballHash).toBe('sha512-policy-test-allow');

    // Cleanup
    await prisma.evaluationLabel.deleteMany({ where: { decision: { reviewJobId: job.id } } });
    await prisma.score.deleteMany({ where: { decision: { reviewJobId: job.id } } });
    await prisma.override.deleteMany({ where: { decision: { reviewJobId: job.id } } });
    await prisma.decision.deleteMany({ where: { reviewJobId: job.id } });
    await prisma.reviewJob.delete({ where: { id: job.id } });
    await prisma.packageVersion.delete({ where: { id: pv.id } });
  });

  it('resolves BLOCK based on agent decision', async () => {
    const prisma = getPrisma();
    const pv = await prisma.packageVersion.create({
      data: {
        packageName: 'policy-test-block',
        version: '2.0.0',
        registrySource: 'npm',
        tarballHash: 'sha512-policy-test-block',
      },
    });
    const job = await prisma.reviewJob.create({
      data: {
        packageVersionId: pv.id,
        auditContext: 'policy:test:block',
        trigger: 'MANUAL',
        idempotencyKey: `policy:block:${pv.id}`,
        status: 'COMPLETED',
        decisions: {
          create: {
            packageVersionId: pv.id,
            verdict: 'BLOCK',
            reasonSummary: 'Policy test — blocked',
            actorType: 'AGENT',
          },
        },
      },
    });

    const result = await getEffectiveDecision('policy-test-block', '2.0.0', 'sha512-policy-test-block');
    expect(result).not.toBeNull();
    expect(result!.verdict).toBe('BLOCK');
    expect(result!.source).toBe('agent');

    // Cleanup
    await prisma.evaluationLabel.deleteMany({ where: { decision: { reviewJobId: job.id } } });
    await prisma.score.deleteMany({ where: { decision: { reviewJobId: job.id } } });
    await prisma.override.deleteMany({ where: { decision: { reviewJobId: job.id } } });
    await prisma.decision.deleteMany({ where: { reviewJobId: job.id } });
    await prisma.reviewJob.delete({ where: { id: job.id } });
    await prisma.packageVersion.delete({ where: { id: pv.id } });
  });

  it('resolves QUARANTINE based on agent decision', async () => {
    const prisma = getPrisma();
    const pv = await prisma.packageVersion.create({
      data: {
        packageName: 'policy-test-quarantine',
        version: '1.5.0',
        registrySource: 'npm',
        tarballHash: 'sha512-policy-test-quarantine',
      },
    });
    const job = await prisma.reviewJob.create({
      data: {
        packageVersionId: pv.id,
        auditContext: 'policy:test:quarantine',
        trigger: 'MANUAL',
        idempotencyKey: `policy:quarantine:${pv.id}`,
        status: 'COMPLETED',
        decisions: {
          create: {
            packageVersionId: pv.id,
            verdict: 'QUARANTINE',
            reasonSummary: 'Policy test — quarantined',
            actorType: 'AGENT',
          },
        },
      },
    });

    const result = await getEffectiveDecision('policy-test-quarantine', '1.5.0', 'sha512-policy-test-quarantine');
    expect(result).not.toBeNull();
    expect(result!.verdict).toBe('QUARANTINE');
    expect(result!.source).toBe('agent');

    // Cleanup
    await prisma.evaluationLabel.deleteMany({ where: { decision: { reviewJobId: job.id } } });
    await prisma.score.deleteMany({ where: { decision: { reviewJobId: job.id } } });
    await prisma.override.deleteMany({ where: { decision: { reviewJobId: job.id } } });
    await prisma.decision.deleteMany({ where: { reviewJobId: job.id } });
    await prisma.reviewJob.delete({ where: { id: job.id } });
    await prisma.packageVersion.delete({ where: { id: pv.id } });
  });

  it('admin override takes precedence over agent decision', async () => {
    const prisma = getPrisma();
    // Create a blocked version
    const pv = await prisma.packageVersion.create({
      data: {
        packageName: 'policy-test-override',
        version: '3.0.0',
        registrySource: 'npm',
        tarballHash: 'sha512-policy-test-override',
      },
    });
    const job = await prisma.reviewJob.create({
      data: {
        packageVersionId: pv.id,
        auditContext: 'policy:test:override',
        trigger: 'MANUAL',
        idempotencyKey: `policy:override:${pv.id}`,
        status: 'COMPLETED',
        decisions: {
          create: {
            packageVersionId: pv.id,
            verdict: 'BLOCK',
            reasonSummary: 'Originally blocked',
            actorType: 'AGENT',
          },
        },
      },
    });

    // Fetch the latest decision
    const latestDecision = await prisma.decision.findFirst({
      where: { packageVersionId: pv.id },
      orderBy: { createdAt: 'desc' },
    });

    // Create an admin override ALLOWing it
    const override = await prisma.override.create({
      data: {
        decisionId: latestDecision!.id,
        adminIdentity: 'admin-test',
        scope: 'SPECIFIC_VERSION',
        targetVerdict: 'ALLOW',
        reason: 'Admin override test — allowed by admin',
      },
    });

    const result = await getEffectiveDecision('policy-test-override', '3.0.0', 'sha512-policy-test-override');
    expect(result).not.toBeNull();
    expect(result!.verdict).toBe('ALLOW');
    expect(result!.source).toBe('admin-override');
    expect(result!.overridden).toBe(true);

    // Cleanup
    await prisma.override.delete({ where: { id: override.id } });
    await prisma.evaluationLabel.deleteMany({ where: { decision: { reviewJobId: job.id } } });
    await prisma.score.deleteMany({ where: { decision: { reviewJobId: job.id } } });
    await prisma.decision.deleteMany({ where: { reviewJobId: job.id } });
    await prisma.reviewJob.delete({ where: { id: job.id } });
    await prisma.packageVersion.delete({ where: { id: pv.id } });
  });
});

describe('Policy service — developer-safe status info', () => {
  beforeAll(async () => {
    const prisma = getPrisma();
    await prisma.$connect();
  });

  afterAll(async () => {
    const prisma = getPrisma();
    // Clean up in FK order: scores -> overrides -> decisions -> review jobs -> versions
    await prisma.score.deleteMany({
      where: { decision: { reviewJob: { packageVersion: { packageName: { startsWith: 'status-test-' } } } } },
    });
    await prisma.override.deleteMany({
      where: { decision: { reviewJob: { packageVersion: { packageName: { startsWith: 'status-test-' } } } } },
    });
    await prisma.evaluationLabel.deleteMany({
      where: { decision: { reviewJob: { packageVersion: { packageName: { startsWith: 'status-test-' } } } } },
    });
    await prisma.decision.deleteMany({
      where: { reviewJob: { packageVersion: { packageName: { startsWith: 'status-test-' } } } },
    });
    await prisma.reviewJob.deleteMany({
      where: { packageVersion: { packageName: { startsWith: 'status-test-' } } },
    });
    await prisma.packageVersion.deleteMany({
      where: { packageName: { startsWith: 'status-test-' } },
    });
    await disconnectPrisma();
  });

  it('returns NOT_FOUND for unknown package', async () => {
    const info = await getStatusInfo('unknown-status-pkg', '0.0.0');
    expect(info.effectiveVerdict).toBe('NOT_FOUND');
    expect(info.source).toBe('none');
    expect(info.explanation).toContain('has not been seen');
    // Must not contain prompts, secrets, or internal details
    expect(info.explanation).not.toContain('prompt');
    expect(info.explanation).not.toContain('secret');
    expect(info.explanation).not.toContain('override');
  });

  it('returns ALLOW status for allowed package', async () => {
    const prisma = getPrisma();
    const pv = await prisma.packageVersion.create({
      data: {
        packageName: `status-test-allow-${RUN_ID}`,
        version: '1.0.0',
        registrySource: 'npm',
        tarballHash: `sha512-status-test-allow-${RUN_ID}`,
      },
    });
    const job = await prisma.reviewJob.create({
      data: {
        packageVersionId: pv.id,
        auditContext: 'status:test:allow',
        trigger: 'MANUAL',
        idempotencyKey: `status:allow:${pv.id}`,
        status: 'COMPLETED',
        decisions: {
          create: {
            packageVersionId: pv.id,
            verdict: 'ALLOW',
            reasonSummary: 'Safe package',
            actorType: 'AGENT',
          },
        },
      },
    });

    const info = await getStatusInfo(`status-test-allow-${RUN_ID}`, '1.0.0');
    expect(info.effectiveVerdict).toBe('ALLOW');
    expect(info.source).toBe('agent');
    // Must not leak internal details
    expect(info.explanation).not.toContain('prompt');
    expect(info.explanation).not.toContain('secret');
    expect(info.explanation).not.toContain('AGENT');

    // Cleanup
    await prisma.evaluationLabel.deleteMany({ where: { decision: { reviewJobId: job.id } } });
    await prisma.score.deleteMany({ where: { decision: { reviewJobId: job.id } } });
    await prisma.override.deleteMany({ where: { decision: { reviewJobId: job.id } } });
    await prisma.decision.deleteMany({ where: { reviewJobId: job.id } });
    await prisma.reviewJob.delete({ where: { id: job.id } });
    await prisma.packageVersion.delete({ where: { id: pv.id } });
  });

  it('returns BLOCK status with explanation', async () => {
    const prisma = getPrisma();
    const pv = await prisma.packageVersion.create({
      data: {
        packageName: `status-test-block-${RUN_ID}`,
        version: '1.0.0',
        registrySource: 'npm',
        tarballHash: `sha512-status-test-block-${RUN_ID}`,
      },
    });
    const job = await prisma.reviewJob.create({
      data: {
        packageVersionId: pv.id,
        auditContext: 'status:test:block',
        trigger: 'MANUAL',
        idempotencyKey: `status:block:${pv.id}`,
        status: 'COMPLETED',
        decisions: {
          create: {
            packageVersionId: pv.id,
            verdict: 'BLOCK',
            reasonSummary: 'Contains malicious code',
            actorType: 'AGENT',
          },
        },
      },
    });

    const info = await getStatusInfo(`status-test-block-${RUN_ID}`, '1.0.0');
    expect(info.effectiveVerdict).toBe('BLOCK');
    expect(info.explanation).toContain('blocked');
    // Next action should guide the developer
    expect(info.nextAction).toContain('admin');
  });

  it('returns UNREVIEWED for package with no decisions', async () => {
    const prisma = getPrisma();
    const pv = await prisma.packageVersion.create({
      data: {
        packageName: `status-test-unreviewed-${RUN_ID}`,
        version: '1.0.0',
        registrySource: 'npm',
        tarballHash: `sha512-status-test-unreviewed-${RUN_ID}`,
      },
    });

    const info = await getStatusInfo(`status-test-unreviewed-${RUN_ID}`, '1.0.0');
    expect(info.effectiveVerdict).toBe('UNREVIEWED');
    expect(info.explanation).toContain('not been reviewed');
    expect(info.nextAction).toContain('modulewarden preflight');

    await prisma.packageVersion.delete({ where: { id: pv.id } });
  });
});

describe('Policy service — exact hash binding (AC #1)', () => {
  beforeAll(async () => {
    await getPrisma().$connect();
  });

  afterAll(async () => {
    await disconnectPrisma();
  });

  it('different hash for same version returns null (not allowed)', async () => {
    const prisma = getPrisma();
    // Create an allowed version with hash A
    const pv = await prisma.packageVersion.create({
      data: {
        packageName: 'hash-test-pkg',
        version: '1.0.0',
        registrySource: 'npm',
        tarballHash: 'sha512-hash-A',
      },
    });
    const job = await prisma.reviewJob.create({
      data: {
        packageVersionId: pv.id,
        auditContext: 'hash:test',
        trigger: 'MANUAL',
        idempotencyKey: `hash:${pv.id}`,
        status: 'COMPLETED',
        decisions: {
          create: {
            packageVersionId: pv.id,
            verdict: 'ALLOW',
            reasonSummary: 'Hash A allowed',
            actorType: 'AGENT',
          },
        },
      },
    });

    // Try with a different hash for the same version — should NOT find the decision
    const result = await getEffectiveDecision('hash-test-pkg', '1.0.0', 'sha512-hash-B');
    expect(result).toBeNull();

    // Cleanup
    await prisma.evaluationLabel.deleteMany({ where: { decision: { reviewJobId: job.id } } });
    await prisma.score.deleteMany({ where: { decision: { reviewJobId: job.id } } });
    await prisma.override.deleteMany({ where: { decision: { reviewJobId: job.id } } });
    await prisma.decision.deleteMany({ where: { reviewJobId: job.id } });
    await prisma.reviewJob.delete({ where: { id: job.id } });
    await prisma.packageVersion.delete({ where: { id: pv.id } });
  });
});
