import { getPrisma } from '../index.js';
import type { Override } from '@prisma/client';

export interface OverrideInput {
  decisionId: string;
  adminIdentity: string;
  scope: 'SPECIFIC_VERSION' | 'PACKAGE' | 'PROJECT' | 'GLOBAL';
  targetVerdict?: 'ALLOW' | 'BLOCK' | 'QUARANTINE';
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

export async function getBestActiveOverrideForPackageVersion(
  packageVersionId: string
): Promise<Override | null> {
  const prisma = getPrisma();
  const packageVersion = await prisma.packageVersion.findUnique({
    where: { id: packageVersionId },
    select: {
      packageName: true,
      importedByProjects: {
        select: { projectId: true },
      },
    },
  });
  if (!packageVersion) return null;

  const projectIds = [...new Set(packageVersion.importedByProjects.map((entry) => entry.projectId))];

  const specificOverride = await prisma.override.findFirst({
    where: {
      active: true,
      scope: 'SPECIFIC_VERSION',
      decision: {
        packageVersionId,
      },
    },
    orderBy: { createdAt: 'desc' },
  });
  if (specificOverride) return specificOverride;

  const packageOverride = await prisma.override.findFirst({
    where: {
      active: true,
      scope: 'PACKAGE',
      decision: {
        packageVersion: {
          packageName: packageVersion.packageName,
        },
      },
    },
    orderBy: { createdAt: 'desc' },
  });
  if (packageOverride) return packageOverride;

  if (projectIds.length > 0) {
    const projectOverride = await prisma.override.findFirst({
      where: {
        active: true,
        scope: 'PROJECT',
        decision: {
          packageVersion: {
            importedByProjects: {
              some: {
                projectId: {
                  in: projectIds,
                },
              },
            },
          },
        },
      },
      orderBy: { createdAt: 'desc' },
    });
    if (projectOverride) return projectOverride;
  }

  return prisma.override.findFirst({
    where: {
      active: true,
      scope: 'GLOBAL',
    },
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
  const activeOverride = await getBestActiveOverrideForPackageVersion(packageVersionId);

  if (activeOverride) {
    return activeOverride.targetVerdict;
  }

  // Otherwise return the most recent decision
  const latestDecision = await getPrisma().decision.findFirst({
    where: { packageVersionId },
    orderBy: { createdAt: 'desc' },
    select: { verdict: true },
  });

  return latestDecision?.verdict ?? null;
}
