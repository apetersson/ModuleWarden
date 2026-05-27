import { getPrisma } from '@modulewarden/prisma-client';
import type { VersionDecision } from './filter.js';

/**
 * Collect all decisions for a list of package versions.
 * Returns a Map of version -> effective decision (respecting active overrides).
 */
export async function getDecisionsForVersions(
  packageName: string,
  upstreamVersions: string[]
): Promise<Map<string, VersionDecision>> {
  const decisions = new Map<string, VersionDecision>();
  if (upstreamVersions.length === 0) return decisions;

  const prisma = getPrisma();

  const packageVersions = await prisma.packageVersion.findMany({
    where: {
      packageName,
      version: { in: upstreamVersions },
    },
    select: {
      version: true,
      tarballHash: true,
      predecessorDecisions: {
        orderBy: { createdAt: 'desc' },
        take: 1,
        select: {
          verdict: true,
          overrides: {
            where: { active: true },
            take: 1,
            select: { id: true },
          },
        },
      },
    },
  });

  for (const pv of packageVersions) {
    const latestDecision = pv.predecessorDecisions[0];
    if (!latestDecision) continue;

    // If there's an active override, the decision is superseded.
    // An overridden decision means the admin changed the verdict.
    // For now, an active override means the original decision is suspended.
    const hasActiveOverride = latestDecision.overrides.length > 0;

    if (hasActiveOverride) {
      // Decision is overridden — to determine the effective verdict,
      // look for the most recent override-linked decision or treat the
      // override as blocking the original verdict.
      // v1 simplifies: if overridden, we check if there's a follow-up
      // decision that the admin created. Otherwise the effective verdict
      // is what the admin set in the override's associated decision.
      // For now, skip overridden decisions (they'll be handled separately)
      continue;
    }

    decisions.set(pv.version, {
      version: pv.version,
      verdict: latestDecision.verdict as 'ALLOW' | 'BLOCK' | 'QUARANTINE',
      tarballHash: pv.tarballHash,
    });
  }

  return decisions;
}

/**
 * Get the effective verdict for a single package version by its tarball hash.
 */
export async function getEffectiveVerdictByHash(
  packageName: string,
  version: string,
  tarballHash: string
): Promise<'ALLOW' | 'BLOCK' | 'QUARANTINE' | null> {
  const prisma = getPrisma();

  const pv = await prisma.packageVersion.findUnique({
    where: {
      packageName_version_registrySource_tarballHash: {
        packageName,
        version,
        registrySource: 'npm',
        tarballHash,
      },
    },
    select: {
      predecessorDecisions: {
        orderBy: { createdAt: 'desc' },
        take: 1,
        select: {
          verdict: true,
          overrides: {
            where: { active: true },
            take: 1,
            select: { id: true },
          },
        },
      },
    },
  });

  if (!pv || pv.predecessorDecisions.length === 0) return null;

  const latest = pv.predecessorDecisions[0];
  if (latest.overrides.length > 0) return null; // Overridden — needs admin re-check

  return latest.verdict as 'ALLOW' | 'BLOCK' | 'QUARANTINE';
}
