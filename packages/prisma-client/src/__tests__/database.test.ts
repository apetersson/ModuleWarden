import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { getPrisma, disconnectPrisma } from '../index.js';
import { createProject, listProjects } from '../repositories/projects.js';
import { upsertPackageVersion, findPackageVersion } from '../repositories/package-versions.js';
import { createReviewJob, deduplicateReviewJob, updateReviewJobStatus } from '../repositories/review-jobs.js';
import { createDecision, listDecisionsForPackage, getEffectiveDecision, listAllowedVersionsForReAudit } from '../repositories/decisions.js';
import { createOverride, deactivateOverride, listActiveOverrides, getEffectiveVerdict } from '../repositories/overrides.js';
import { createReAuditCampaign, listCampaignsByProject } from '../repositories/campaigns.js';
import { createEvidenceArtifact, listEvidenceByAuditRun, supersedeEvidenceArtifact } from '../repositories/evidence.js';
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
  await prisma.importedPackageVersion.deleteMany();
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

  it('10. preserves evidence immutability and prompt lineage', async () => {
    const superseding = await supersedeEvidenceArtifact(evidenceId, {
      auditRunId,
      artifactType: 'DIFF_SUMMARY',
      name: 'diff-summary-v2.json',
      content: { added: ['src/newer.ts'], removed: [], changed: 4 } as any,
      contentHash: 'sha256-of-content-v2',
      status: 'SUPERSEDED',
    });

    const evidenceSet = await listEvidenceByAuditRun(auditRunId);
    const original = evidenceSet.find((artifact) => artifact.id === evidenceId);
    expect(superseding.supersedesEvidenceArtifactId).toBe(evidenceId);
    expect(superseding.status).toBe('SUPERSEDED');
    expect(original?.status).toBe('ACTIVE');

    const lineage = await createDecision({
      reviewJobId,
      packageVersionId: pkgVersionId,
      verdict: 'BLOCK',
      reasonSummary: 'Policy drift requires additional checks',
      actorType: 'AGENT',
      promptVersion: ['v1-core-1', 'v2-core-6'],
    });

    expect(lineage.promptVersion).toBe(JSON.stringify(['v1-core-1', 'v2-core-6']));
  });

  it('11. applies active overrides to re-audit candidate selection', async () => {
    const prisma = getPrisma();
    const overrideProject = await createProject(`override-${Date.now()}`, 'Override-aware re-audit check');

    const overridePkg = await upsertPackageVersion({
      packageName: `override-check-${Date.now()}`,
      version: '2.0.0',
      registrySource: 'npm',
      tarballHash: `sha-override-${Date.now()}`,
      description: 'Override candidate',
    });

    const importedLink = await prisma.importedPackageVersion.create({
      data: {
        projectId: overrideProject.id,
        packageVersionId: overridePkg.id,
      },
    });

    const importedReviewJob = await createReviewJob({
      packageVersionId: overridePkg.id,
      auditContext: 'preflight:override-check',
      trigger: 'MANUAL',
      idempotencyKey: `mw:job:package-review:override-check-${Date.now()}:2.0.0:${overridePkg.tarballHash}:preflight:override-check`,
    });

    const decision = await createDecision({
      reviewJobId: importedReviewJob.id,
      packageVersionId: overridePkg.id,
      verdict: 'ALLOW',
      reasonSummary: 'Allowed for re-audit lineage test',
      actorType: 'AGENT',
    });

    const override = await createOverride({
      decisionId: decision.id,
      adminIdentity: 'security-admin@example.com',
      scope: 'SPECIFIC_VERSION',
      targetVerdict: 'BLOCK',
      reason: 'Policy hold',
      supersedesDecisionId: decision.id,
    });

    const blocked = await listAllowedVersionsForReAudit(overrideProject.id);
    expect(blocked).toHaveLength(0);

    await deactivateOverride(override.id);

    const allowed = await listAllowedVersionsForReAudit(overrideProject.id);
    expect(allowed).toHaveLength(1);
    expect(allowed[0].packageVersionId).toBe(overridePkg.id);
    expect(allowed[0].decisionId).toBe(decision.id);

    await prisma.override.delete({ where: { id: override.id } });
    await prisma.decision.delete({ where: { id: decision.id } });
    await prisma.importedPackageVersion.delete({ where: { id: importedLink.id } });
    await prisma.reviewJob.delete({ where: { id: importedReviewJob.id } });
    await prisma.packageVersion.delete({ where: { id: overridePkg.id } });
    await prisma.project.delete({ where: { id: overrideProject.id } });
  });

  it('12. invokes createDecision hooks for post-write side effects', async () => {
    const prisma = getPrisma();
    const project = await prisma.project.create({
      data: {
        name: `decision-hook-${Date.now()}`,
        graphState: 'AUDITING',
      },
    });

    const packageEntry = await prisma.packageVersion.create({
      data: {
        packageName: `hook-${Date.now()}`,
        version: '1.0.0',
        registrySource: 'npm',
        tarballHash: `sha-hook-${Date.now()}`,
      },
    });

    await prisma.importedPackageVersion.create({
      data: {
        projectId: project.id,
        packageVersionId: packageEntry.id,
      },
    });

    const reviewJob = await prisma.reviewJob.create({
      data: {
        packageVersionId: packageEntry.id,
        auditContext: `preflight:hook:${packageEntry.packageName}`,
        trigger: 'PREFLIGHT',
        status: 'COMPLETED',
        idempotencyKey: `hook-${Date.now()}`,
      },
    });

    const decisions: string[] = [];
    const createdDecision = await createDecision({
      reviewJobId: reviewJob.id,
      packageVersionId: packageEntry.id,
      verdict: 'ALLOW',
      reasonSummary: 'Decision hook test path',
      actorType: 'AGENT',
      onCreated: async (decision) => {
        decisions.push(decision.id);
      },
    });

    expect(decisions).toEqual([createdDecision.id]);

    await prisma.decision.delete({ where: { id: createdDecision.id } });
    await prisma.reviewJob.delete({ where: { id: reviewJob.id } });
    await prisma.importedPackageVersion.delete({
      where: {
        projectId_packageVersionId: {
          projectId: project.id,
          packageVersionId: packageEntry.id,
        },
      },
    });
    await prisma.packageVersion.delete({ where: { id: packageEntry.id } });
    await prisma.project.delete({ where: { id: project.id } });
  });

  it('13. stores re-audit lineage by linking superseded decisions', async () => {
    const prisma = getPrisma();
    const project = await prisma.project.create({
      data: {
        name: `reaudit-lineage-${Date.now()}`,
        graphState: 'READY',
        registryEnabled: true,
      },
    });

    const packageEntry = await prisma.packageVersion.create({
      data: {
        packageName: `lineage-${Date.now()}`,
        version: '2.0.0',
        registrySource: 'npm',
        tarballHash: `sha-lineage-${Date.now()}`,
      },
    });

    await prisma.importedPackageVersion.create({
      data: {
        projectId: project.id,
        packageVersionId: packageEntry.id,
      },
    });

    const baseReviewJob = await prisma.reviewJob.create({
      data: {
        packageVersionId: packageEntry.id,
        auditContext: `preflight:${packageEntry.packageName}:2.0.0`,
        trigger: 'MANUAL',
        status: 'COMPLETED',
        idempotencyKey: `lineage-base-${Date.now()}`,
      },
    });

    const baseDecision = await createDecision({
      reviewJobId: baseReviewJob.id,
      packageVersionId: packageEntry.id,
      verdict: 'ALLOW',
      reasonSummary: 'Original allow for lineage baseline',
      actorType: 'AGENT',
    });

    const reAuditReviewJob = await prisma.reviewJob.create({
      data: {
        packageVersionId: packageEntry.id,
        auditContext: `re-audit:campaign-${Date.now()}:${baseDecision.id}`,
        trigger: 'RE_AUDIT',
        status: 'PENDING',
        idempotencyKey: `lineage-reaudit-${Date.now()}`,
      },
    });

    const reAuditDecision = await createDecision({
      reviewJobId: reAuditReviewJob.id,
      packageVersionId: packageEntry.id,
      verdict: 'BLOCK',
      reasonSummary: 'Re-audit supersedes baseline decision',
      actorType: 'AGENT',
    });

    expect(reAuditDecision.supersedesDecisionId).toBe(baseDecision.id);

    await prisma.decision.delete({ where: { id: reAuditDecision.id } });
    await prisma.decision.delete({ where: { id: baseDecision.id } });
    await prisma.reviewJob.delete({ where: { id: reAuditReviewJob.id } });
    await prisma.reviewJob.delete({ where: { id: baseReviewJob.id } });
    await prisma.importedPackageVersion.delete({
      where: {
        projectId_packageVersionId: {
          projectId: project.id,
          packageVersionId: packageEntry.id,
        },
      },
    });
    await prisma.packageVersion.delete({ where: { id: packageEntry.id } });
    await prisma.project.delete({ where: { id: project.id } });
  });

  it('14. triggers project-ready callback only after all imported versions are decided', async () => {
    const prisma = getPrisma();
    const readinessProject = await prisma.project.create({
      data: { name: `decision-ready-${Date.now()}`, graphState: 'AUDITING', registryEnabled: false },
    });

    const pkgA = await prisma.packageVersion.create({
      data: {
        packageName: `decision-ready-a-${Date.now()}`,
        version: '1.0.0',
        registrySource: 'npm',
        tarballHash: `sha-decision-ready-a-${Date.now()}`,
      },
    });

    const pkgB = await prisma.packageVersion.create({
      data: {
        packageName: `decision-ready-b-${Date.now()}`,
        version: '1.0.0',
        registrySource: 'npm',
        tarballHash: `sha-decision-ready-b-${Date.now()}`,
      },
    });

    await prisma.importedPackageVersion.createMany({
      data: [
        { projectId: readinessProject.id, packageVersionId: pkgA.id },
        { projectId: readinessProject.id, packageVersionId: pkgB.id },
      ],
    });

    const jobA = await prisma.reviewJob.create({
      data: {
        packageVersionId: pkgA.id,
        auditContext: `preflight:${pkgA.packageName}`,
        trigger: 'PREFLIGHT',
        status: 'COMPLETED',
        idempotencyKey: `decision-ready-a-${Date.now()}`,
      },
    });

    const jobB = await prisma.reviewJob.create({
      data: {
        packageVersionId: pkgB.id,
        auditContext: `preflight:${pkgB.packageName}`,
        trigger: 'PREFLIGHT',
        status: 'COMPLETED',
        idempotencyKey: `decision-ready-b-${Date.now()}`,
      },
    });

    const callbacks: Array<{ projectId: string; reason: string }> = [];

    await createDecision({
      reviewJobId: jobA.id,
      packageVersionId: pkgA.id,
      verdict: 'ALLOW',
      reasonSummary: 'Decision ready partial',
      actorType: 'AGENT',
      onProjectReady: async (projectId, reason) => {
        callbacks.push({ projectId, reason });
        return `project-ready-${projectId}`;
      },
    });

    expect(callbacks).toEqual([]);

    await createDecision({
      reviewJobId: jobB.id,
      packageVersionId: pkgB.id,
      verdict: 'BLOCK',
      reasonSummary: 'Decision ready complete',
      actorType: 'AGENT',
      onProjectReady: async (projectId, reason) => {
        callbacks.push({ projectId, reason });
        return `project-ready-${projectId}`;
      },
    });

    expect(callbacks).toEqual([
      {
        projectId: readinessProject.id,
        reason: `Project ${readinessProject.id} is now ready for registry enablement`,
      },
    ]);

    await prisma.decision.deleteMany({
      where: {
        packageVersionId: {
          in: [pkgA.id, pkgB.id],
        },
      },
    });
    await prisma.reviewJob.deleteMany({
      where: {
        id: {
          in: [jobA.id, jobB.id],
        },
      },
    });
    await prisma.importedPackageVersion.deleteMany({
      where: {
        projectId: readinessProject.id,
        packageVersionId: { in: [pkgA.id, pkgB.id] },
      },
    });
    await prisma.project.delete({ where: { id: readinessProject.id } });
    await prisma.packageVersion.deleteMany({
      where: {
        id: {
          in: [pkgA.id, pkgB.id],
        },
      },
    });
  });

  it('15. ignores project-ready callback failures while still persisting decision records', async () => {
    const prisma = getPrisma();
    const ignoreProject = await prisma.project.create({
      data: { name: `decision-ready-fallback-${Date.now()}`, graphState: 'AUDITING' },
    });

    const pkg = await prisma.packageVersion.create({
      data: {
        packageName: `decision-fallback-${Date.now()}`,
        version: '1.0.0',
        registrySource: 'npm',
        tarballHash: `sha-decision-fallback-${Date.now()}`,
      },
    });

    await prisma.importedPackageVersion.create({
      data: {
        projectId: ignoreProject.id,
        packageVersionId: pkg.id,
      },
    });

    const reviewJob = await prisma.reviewJob.create({
      data: {
        packageVersionId: pkg.id,
        auditContext: `preflight:${pkg.packageName}`,
        trigger: 'PREFLIGHT',
        status: 'COMPLETED',
        idempotencyKey: `decision-fallback-${Date.now()}`,
      },
    });

    await createDecision({
      reviewJobId: reviewJob.id,
      packageVersionId: pkg.id,
      verdict: 'ALLOW',
      reasonSummary: 'Decision with failing callback',
      actorType: 'AGENT',
      onProjectReady: async () => {
        throw new Error('callback transport unavailable');
      },
    });

    const created = await getPrisma().decision.findFirst({
      where: { packageVersionId: pkg.id },
    });
    expect(created).toBeDefined();
    expect(created?.verdict).toBe('ALLOW');

    await prisma.decision.deleteMany({
      where: { packageVersionId: pkg.id },
    });
    await prisma.reviewJob.delete({ where: { id: reviewJob.id } });
    await prisma.importedPackageVersion.delete({
      where: {
        projectId_packageVersionId: {
          projectId: ignoreProject.id,
          packageVersionId: pkg.id,
        },
      },
    });
    await prisma.project.delete({ where: { id: ignoreProject.id } });
    await prisma.packageVersion.delete({ where: { id: pkg.id } });
  });
});
