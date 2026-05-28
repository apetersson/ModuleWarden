import {
  getBestActiveOverrideForPackageVersion,
  getPrisma,
} from '@modulewarden/prisma-client';
import type { VersionDecision } from './filter.js';

/**
 * Collect all decisions for a list of package versions.
 * Returns a map keyed by `version::hash` so same version with different tarball
 * hashes are tracked independently.
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
      id: true,
      version: true,
      tarballHash: true,
      predecessorDecisions: {
        orderBy: { createdAt: 'desc' },
        select: { id: true, verdict: true },
      },
    },
  });

  for (const pv of packageVersions) {
    const latestDecision = pv.predecessorDecisions[0];
    if (!latestDecision) continue;

    const activeOverride = await getBestActiveOverrideForPackageVersion(pv.id);
    const verdict = activeOverride?.targetVerdict ?? latestDecision.verdict;
    const value: VersionDecision = {
      version: pv.version,
      verdict: verdict as 'ALLOW' | 'BLOCK' | 'QUARANTINE',
      tarballHash: pv.tarballHash,
    };
    decisions.set(decisionKey(pv.version, pv.tarballHash), value);
    // fallback key by version remains for compatibility with code paths that do not
    // yet pass the exact hash through.
    if (!decisions.has(pv.version)) {
      decisions.set(pv.version, value);
    }
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
      id: true,
      predecessorDecisions: {
        orderBy: { createdAt: 'desc' },
        select: { verdict: true },
      },
    },
  });

  if (!pv || pv.predecessorDecisions.length === 0) return null;

  const latestDecision = pv.predecessorDecisions[0];
  const activeOverride = await getBestActiveOverrideForPackageVersion(pv.id);
  return (activeOverride?.targetVerdict ?? latestDecision.verdict) as
    | 'ALLOW'
    | 'BLOCK'
    | 'QUARANTINE'
    | null;
}

function decisionKey(version: string, tarballHash: string): string {
  return `${version}::${tarballHash}`;
}
