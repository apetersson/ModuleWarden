import { getPrisma } from '../index.js';
import type { Override } from '@prisma/client';

export interface OverrideInput {
  decisionId: string;
  adminIdentity: string;
  scope: 'SPECIFIC_VERSION' | 'PACKAGE' | 'PROJECT' | 'GLOBAL';
  reason: string;
  supersedesDecisionId?: string;
}

export async function createOverride(input: OverrideInput): Promise<Override> {
  return getPrisma().override.create({ data: input });
}

export async function getOverride(id: string): Promise<Override | null> {
  return getPrisma().override.findUnique({ where: { id } });
}

export async function listOverridesByDecision(decisionId: string): Promise<Override[]> {
  return getPrisma().override.findMany({
    where: { decisionId },
    orderBy: { createdAt: 'desc' },
  });
}

export async function listActiveOverrides(): Promise<Override[]> {
  return getPrisma().override.findMany({
    where: { active: true },
    include: { decision: true },
    orderBy: { createdAt: 'desc' },
  });
}

export async function deactivateOverride(id: string): Promise<Override> {
  return getPrisma().override.update({
    where: { id },
    data: { active: false },
  });
}

export async function getEffectiveVerdict(
  packageVersionId: string
): Promise<'ALLOW' | 'BLOCK' | 'QUARANTINE' | null> {
  // Check if there's an active override first
  const activeOverride = await getPrisma().override.findFirst({
    where: {
      decision: { packageVersionId },
      active: true,
    },
    include: { decision: true },
    orderBy: { createdAt: 'desc' },
  });

  if (activeOverride) {
    return activeOverride.decision.verdict;
  }

  // Otherwise return the most recent decision
  const latestDecision = await getPrisma().decision.findFirst({
    where: { packageVersionId },
    orderBy: { createdAt: 'desc' },
    select: { verdict: true },
  });

  return latestDecision?.verdict ?? null;
}
