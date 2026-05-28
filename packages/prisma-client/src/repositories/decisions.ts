import { getPrisma } from '../index.js';
import { getBestActiveOverrideForPackageVersion } from './overrides.js';
import type { Decision } from '@prisma/client';

export interface DecisionInput {
  reviewJobId: string;
  packageVersionId: string;
  verdict: 'ALLOW' | 'BLOCK' | 'QUARANTINE';
  reasonSummary: string;
  predecessorVersion?: string;
  predecessorHash?: string;
  promptVersion?: string;
  promptPackId?: string;
  modelProfileId?: string;
  scores?: Record<string, number>;
  actorType: 'AGENT' | 'ADMIN';
  piSessionId?: string;
  piRunId?: string;
}

export async function createDecision(input: DecisionInput): Promise<Decision> {
  return getPrisma().decision.create({
    data: {
      ...input,
      scores: input.scores ?? undefined,
    },
  });
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
    const effectiveVerdict = override?.targetVerdict ?? latestDecision.verdict;
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
