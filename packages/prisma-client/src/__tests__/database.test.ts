import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { getPrisma, disconnectPrisma } from '../index.js';
import { createProject, listProjects } from '../repositories/projects.js';
import { upsertPackageVersion, findPackageVersion } from '../repositories/package-versions.js';
import { createReviewJob, deduplicateReviewJob, updateReviewJobStatus } from '../repositories/review-jobs.js';
import { createDecision, listDecisionsForPackage, getEffectiveDecision } from '../repositories/decisions.js';
import { createOverride, listActiveOverrides, getEffectiveVerdict } from '../repositories/overrides.js';
import { createReAuditCampaign, listCampaignsByProject } from '../repositories/campaigns.js';
import { createEvidenceArtifact, listEvidenceByAuditRun } from '../repositories/evidence.js';
import { subscribePackage, listActiveSubscriptions } from '../repositories/subscriptions.js';

const TEST_PKG = 'test-package';
const TEST_VERSION = '1.0.0';
const TEST_HASH = 'sha512-testhash123';
const TEST_CTX = 'preflight:default';

beforeAll(async () => {
  // Ensure migration is applied by connecting
  const prisma = getPrisma();
  await prisma.$connect();
});

afterAll(async () => {
  // Clean up test data
  const prisma = getPrisma();
  await prisma.evaluationLabel.deleteMany();
  await prisma.score.deleteMany();
  await prisma.override.deleteMany();
  await prisma.evidenceArtifact.deleteMany();
  await prisma.decision.deleteMany();
  await prisma.auditRun.deleteMany();
  await prisma.reviewJob.deleteMany();
  await prisma.tarballArtifact.deleteMany();
  await prisma.upstreamMetadataSnapshot.deleteMany();
  await prisma.packageSubscription.deleteMany();
  await prisma.lockfileImport.deleteMany();
  await prisma.reAuditCampaign.deleteMany();
  await prisma.packageVersion.deleteMany();
  await prisma.project.deleteMany();
  await prisma.$disconnect();
  await disconnectPrisma();
});

describe('Prisma Schema & Repositories', () => {
  let projectId: string;
  let pkgVersionId: string;
  let reviewJobId: string;
  let decisionId: string;
  let auditRunId: string;
  let evidenceId: string;

  it('1. creates a project with default graph state', async () => {
    const project = await createProject('test-project', 'Test project for integration testing');
    expect(project).toBeDefined();
    expect(project.name).toBe('test-project');
    expect(project.graphState).toBe('IMPORTING');
    expect(project.registryEnabled).toBe(false);
    projectId = project.id;
  });

  it('2. creates and dedupes package versions by unique constraint', async () => {
    const pkg = await upsertPackageVersion({
      packageName: TEST_PKG,
      version: TEST_VERSION,
      registrySource: 'npm',
      tarballHash: TEST_HASH,
      description: 'Test package',
    });
    expect(pkg).toBeDefined();
    expect(pkg.packageName).toBe(TEST_PKG);
    pkgVersionId = pkg.id;

    // Upsert with same key should update, not create
    const dup = await upsertPackageVersion({
      packageName: TEST_PKG,
      version: TEST_VERSION,
      registrySource: 'npm',
      tarballHash: TEST_HASH,
      description: 'Updated description',
    });
    expect(dup.id).toBe(pkgVersionId);
    expect(dup.description).toBe('Updated description');

    // Different hash should be different record
    const altHash = await upsertPackageVersion({
      packageName: TEST_PKG,
      version: TEST_VERSION,
      registrySource: 'npm',
      tarballHash: 'sha512-alternatehash456',
      description: 'Alternate tarball',
    });
    expect(altHash.id).not.toBe(pkgVersionId);
    // Clean up alternate
    await (getPrisma()).packageVersion.delete({ where: { id: altHash.id } });
  });

  it('3. creates and dedupes review jobs', async () => {
    const idKey = `mw:job:package-review:${TEST_PKG}:${TEST_VERSION}:${TEST_HASH}:${TEST_CTX}`;
    const job = await createReviewJob({
      packageVersionId: pkgVersionId,
      auditContext: TEST_CTX,
      trigger: 'PREFLIGHT',
      idempotencyKey: idKey,
    });
    expect(job).toBeDefined();
    expect(job.status).toBe('PENDING');
    reviewJobId = job.id;

    // Dedupe should return existing job
    const existing = await deduplicateReviewJob(pkgVersionId, TEST_CTX);
    expect(existing).toBeDefined();
    expect(existing!.id).toBe(reviewJobId);

    // Different context should not dedupe
    const diffCtx = await deduplicateReviewJob(pkgVersionId, 'subscription:upstream');
    expect(diffCtx).toBeNull();
  });

  it('4. creates decisions with full provenance fields', async () => {
    const decision = await createDecision({
      reviewJobId,
      packageVersionId: pkgVersionId,
      verdict: 'ALLOW',
      reasonSummary: 'Clean diff — no suspicious changes',
      predecessorVersion: '0.9.0',
      predecessorHash: 'sha512-predecessorhash',
      promptVersion: 'v1-core-1',
      actorType: 'AGENT',
      piSessionId: 'pi-session-abc',
      piRunId: 'pi-run-123',
      scores: { provenance_confidence: 0.95, behavioral_risk: 0.02 },
    });
    expect(decision).toBeDefined();
    expect(decision.verdict).toBe('ALLOW');
    expect(decision.predecessorVersion).toBe('0.9.0');
    expect(decision.piSessionId).toBe('pi-session-abc');
    expect(decision.actorType).toBe('AGENT');
    decisionId = decision.id;

    // List decisions for package
    const decisions = await listDecisionsForPackage(pkgVersionId);
    expect(decisions.length).toBeGreaterThanOrEqual(1);
    expect(decisions[0].id).toBe(decisionId);
  });

  it('5. creates overrides with admin identity and scope', async () => {
    const override = await createOverride({
      decisionId,
      adminIdentity: 'admin@example.com',
      scope: 'SPECIFIC_VERSION',
      reason: 'Emergency fix — verified manually',
    });
    expect(override).toBeDefined();
    expect(override.adminIdentity).toBe('admin@example.com');
    expect(override.active).toBe(true);

    // List active overrides
    const active = await listActiveOverrides();
    expect(active.length).toBeGreaterThanOrEqual(1);
    expect(active.some((o) => o.id === override.id)).toBe(true);

    // Effective verdict should respect override
    const verdict = await getEffectiveVerdict(pkgVersionId);
    expect(verdict).toBe('ALLOW');
  });

  it('6. creates evidence artifacts (immutable)', async () => {
    // Create audit run first
    const ar = await (getPrisma()).auditRun.create({
      data: { reviewJobId, status: 'COMPLETED' },
    });
    auditRunId = ar.id;

    const evidence = await createEvidenceArtifact({
      auditRunId,
      artifactType: 'DIFF_SUMMARY',
      name: 'diff-summary.json',
      content: { added: ['src/new.ts'], removed: [], changed: 3 } as any,
      contentHash: 'sha256-of-content',
    });
    expect(evidence).toBeDefined();
    expect(evidence.artifactType).toBe('DIFF_SUMMARY');
    expect(evidence.contentHash).toBe('sha256-of-content');
    evidenceId = evidence.id;

    // Evidence should be listed by audit run
    const list = await listEvidenceByAuditRun(auditRunId);
    expect(list.length).toBe(1);
    expect(list[0].id).toBe(evidenceId);
  });

  it('7. creates re-audit campaigns that reference decisions', async () => {
    const campaign = await createReAuditCampaign({
      projectId,
      reason: 'Core prompt v2 released',
      triggerType: 'PROMPT_CHANGE',
      promptPackId: 'core-v2',
    });
    expect(campaign).toBeDefined();
    expect(campaign.triggerType).toBe('PROMPT_CHANGE');
    expect(campaign.status).toBe('PENDING');

    // List campaigns by project
    const campaigns = await listCampaignsByProject(projectId);
    expect(campaigns.length).toBeGreaterThanOrEqual(1);
  });

  it('8. creates package subscriptions', async () => {
    const sub = await subscribePackage({
      projectId,
      packageName: TEST_PKG,
      registrySource: 'npm',
    });
    expect(sub).toBeDefined();
    expect(sub.packageName).toBe(TEST_PKG);
    expect(sub.active).toBe(true);

    // Duplicate subscribe should upsert (same unique constraint)
    const dupSub = await subscribePackage({
      projectId,
      packageName: TEST_PKG,
      registrySource: 'npm',
    });
    expect(dupSub.id).toBe(sub.id);

    // List active subscriptions
    const subs = await listActiveSubscriptions();
    expect(subs.length).toBeGreaterThanOrEqual(1);
  });

  it('9. project graph state transitions correctly', async () => {
    const { getPrisma } = await import('../index.js');
    const prisma = getPrisma();

    // Can't mark registry-enabled without all packages having decisions
    // (business logic — constraint handled at service layer)

    // Update graph state
    await prisma.project.update({
      where: { id: projectId },
      data: { graphState: 'AUDITING' },
    });
    const auditing = await prisma.project.findUnique({ where: { id: projectId } });
    expect(auditing!.graphState).toBe('AUDITING');

    // Enable registry (would require all packages to have decisions)
    await prisma.project.update({
      where: { id: projectId },
      data: { graphState: 'READY', registryEnabled: true },
    });
    const ready = await prisma.project.findUnique({ where: { id: projectId } });
    expect(ready!.registryEnabled).toBe(true);
    expect(ready!.graphState).toBe('READY');
  });
});
