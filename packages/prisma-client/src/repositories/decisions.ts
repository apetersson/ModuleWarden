import { getPrisma } from '../index.js';
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
  // Return the most recent active decision (not superseded by an override)
  return getPrisma().decision.findFirst({
    where: {
      packageVersionId,
      overrides: {
        none: { active: true },
      },
    },
    orderBy: { createdAt: 'desc' },
  });
}

export async function listAllowedVersionsForReAudit(
  projectId: string
): Promise<{ packageVersionId: string; decisionId: string }[]> {
  const decisions = await getPrisma().decision.findMany({
    where: {
      verdict: 'ALLOW',
      reviewJob: {
        packageVersion: {
          reviewJobs: {
            some: {
              packageVersion: {
                // Package versions that belong to subscribed packages in this project
                // This requires a join through subscriptions
              },
            },
          },
        },
      },
      overrides: {
        none: { active: true },
      },
    },
    select: {
      id: true,
      packageVersionId: true,
    },
    orderBy: { createdAt: 'desc' },
  });

  return decisions.map((d) => ({
    decisionId: d.id,
    packageVersionId: d.packageVersionId,
  }));
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
