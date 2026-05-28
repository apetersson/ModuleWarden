import { getPrisma } from '../index.js';
import { getBestActiveOverrideForPackageVersion } from './overrides.js';
import type { Decision, Verdict } from '@prisma/client';

export interface DecisionInput {
  reviewJobId: string;
  packageVersionId: string;
  verdict: 'ALLOW' | 'BLOCK' | 'QUARANTINE';
  reasonSummary: string;
  predecessorVersion?: string;
  predecessorHash?: string;
  promptVersion?: string | string[];
  promptPackId?: string;
  modelProfileId?: string;
  scores?: Record<string, number>;
  actorType: 'AGENT' | 'ADMIN';
  piSessionId?: string;
  piRunId?: string;
  evidenceArtifactIds?: string[];
  scoreEntries?: Array<{
    name: string;
    value: number;
    weight?: number;
    category?: string;
  }>;
  supersedesDecisionId?: string;
  onCreated?: (decision: Decision) => Promise<void> | void;
  onProjectReady?: (projectId: string, reason: string) => Promise<string | null> | void;
}

export async function createDecision(input: DecisionInput): Promise<Decision> {
  const {
    scores,
    evidenceArtifactIds,
    scoreEntries,
    promptVersion,
    onProjectReady,
    onCreated,
    ...decisionData
  } = input;

  const prisma = getPrisma();
  const parsedSupersedesDecisionId = decisionData.supersedesDecisionId
    || (await inferSupersededDecisionId(prisma, input.reviewJobId));
  const normalizedPromptVersion = Array.isArray(promptVersion)
    ? JSON.stringify(promptVersion)
    : promptVersion;

  const decision = await prisma.decision.create({
    data: {
      ...decisionData,
      supersedesDecisionId: parsedSupersedesDecisionId,
      promptVersion: normalizedPromptVersion,
      scores: scores ?? undefined,
      scoresData:
        scoreEntries?.length
        ? {
            create: scoreEntries.map((score) => ({
              name: score.name,
              value: score.value,
              weight: score.weight,
              category: score.category,
            })),
          }
          : undefined,
      evidenceArtifacts:
        evidenceArtifactIds && evidenceArtifactIds.length > 0
          ? ({
            connect: evidenceArtifactIds.map((id) => ({ id })),
          } as { connect: { id: string }[] })
          : undefined,
    },
    include: {
      scoresData: true,
      evidenceArtifacts: true,
    },
  });

  await Promise.resolve(onCreated?.(decision));

  if (input.packageVersionId) {
    await refreshProjectReadinessFromDecision(
      prisma,
      input.packageVersionId,
      input.onProjectReady
    );
  }

  return decision;
}

const RE_AUDIT_CONTEXT = /^re-audit:[^:]+:(.+)$/;

async function inferSupersededDecisionId(
  prisma: ReturnType<typeof getPrisma>,
  reviewJobId: string
): Promise<string | null> {
  if (!reviewJobId) {
    return null;
  }

  const reviewJob = await prisma.reviewJob.findUnique({
    where: { id: reviewJobId },
    select: { auditContext: true },
  });

  if (!reviewJob?.auditContext) {
    return null;
  }

  const match = RE_AUDIT_CONTEXT.exec(reviewJob.auditContext);
  return match?.[1] ?? null;
}

async function refreshProjectReadinessFromDecision(
  prisma: ReturnType<typeof getPrisma>,
  packageVersionId: string,
  projectReadyHook?: (projectId: string, reason: string) => Promise<string | null> | void
): Promise<void> {
  const projectLinks = await prisma.importedPackageVersion.findMany({
    where: { packageVersionId },
    select: { projectId: true },
  });

  if (projectLinks.length === 0) {
    return;
  }

  const uniqueProjectIds = [...new Set(projectLinks.map((link) => link.projectId))];

  for (const projectId of uniqueProjectIds) {
    const versions = await prisma.importedPackageVersion.findMany({
      where: { projectId },
      select: {
        packageVersion: {
          select: {
            predecessorDecisions: {
              take: 1,
              orderBy: { createdAt: 'desc' },
              select: { id: true },
            },
          },
        },
      },
    });

    if (versions.length === 0) {
      continue;
    }

    const undecided = versions.some((entry) => entry.packageVersion.predecessorDecisions.length === 0);
    if (undecided) {
      continue;
    }

    if (projectReadyHook) {
      await Promise.resolve(
        projectReadyHook(projectId, `Project ${projectId} is now ready for registry enablement`)
      );
      continue;
    }

    await prisma.project.update({
      where: { id: projectId },
      data: { graphState: 'READY', registryEnabled: true },
    });
  }
}

export async function getDecision(id: string): Promise<Decision | null> {
  return getPrisma().decision.findUnique({ where: { id } });
}

export async function listDecisionsForPackage(
  packageVersionId: string
): Promise<Decision[]> {
  return getPrisma().decision.findMany({
    where: { packageVersionId },
    orderBy: { createdAt: 'desc' },
    include: { overrides: true, evidenceArtifacts: true },
  });
}

export async function getEffectiveDecision(
  packageVersionId: string
): Promise<Decision | null> {
  const prisma = getPrisma();
  const activeOverride = await getBestActiveOverrideForPackageVersion(packageVersionId);
  if (activeOverride) {
    const decision = await prisma.decision.findFirst({
      where: { packageVersionId },
      orderBy: { createdAt: 'desc' },
    });
    return decision ? { ...decision, verdict: activeOverride.targetVerdict } : null;
  }

  return prisma.decision.findFirst({
    where: { packageVersionId },
    orderBy: { createdAt: 'desc' },
  });
}

export async function listAllowedVersionsForReAudit(
  projectId: string
): Promise<{ packageVersionId: string; decisionId: string }[]> {
  const prisma = getPrisma();
  const importedVersions = await prisma.importedPackageVersion.findMany({
    where: { projectId },
    select: {
      packageVersion: {
        select: {
          id: true,
          predecessorDecisions: {
            orderBy: { createdAt: 'desc' },
            select: { id: true, verdict: true },
          },
        },
      },
    },
  });

  const allowed: { packageVersionId: string; decisionId: string }[] = [];

  for (const entry of importedVersions) {
    const latestDecision = entry.packageVersion.predecessorDecisions[0];
    if (!latestDecision) continue;

    const override = await getBestActiveOverrideForPackageVersion(entry.packageVersion.id);
    const effectiveVerdict = override
      ? (override.targetVerdict as Verdict)
      : latestDecision.verdict;
    if (effectiveVerdict === 'ALLOW') {
      allowed.push({
        packageVersionId: entry.packageVersion.id,
        decisionId: latestDecision.id,
      });
    }
  }

  return allowed;
}

export async function addScoreToDecision(
  decisionId: string,
  name: string,
  value: number,
  weight?: number,
  category?: string
): Promise<void> {
  await getPrisma().score.create({
    data: { decisionId, name, value, weight, category },
  });
}
