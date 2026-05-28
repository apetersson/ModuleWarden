import { getPrisma, getBestActiveOverrideForPackageVersion } from '@modulewarden/prisma-client';

export interface EffectiveDecision {
  packageVersionId: string;
  packageName: string;
  version: string;
  tarballHash: string;
  verdict: 'ALLOW' | 'BLOCK' | 'QUARANTINE';
  source: 'agent' | 'admin-override';
  overridden: boolean;
  reasonSummary: string;
  statusUrl: string;
  cliCommand: string;
}

export interface StatusInfo {
  packageName: string;
  version: string;
  tarballHash: string;
  effectiveVerdict: 'ALLOW' | 'BLOCK' | 'QUARANTINE' | 'UNREVIEWED' | 'NOT_FOUND';
  source: 'agent' | 'admin-override' | 'none';
  reasonSummary?: string;
  explanation: string;
  nextAction: string;
}

/**
 * Resolve the effective decision for a package version.
 *
 * Priority:
 * 1. Active security-admin override (highest scope wins)
 * 2. Latest agent decision
 * 3. No decision → unreviewed
 */
export async function getEffectiveDecision(
  packageName: string,
  version: string,
  tarballHash: string
): Promise<EffectiveDecision | null> {
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
      packageName: true,
      version: true,
      tarballHash: true,
      predecessorDecisions: {
        orderBy: { createdAt: 'desc' },
        take: 1,
        select: { verdict: true, reasonSummary: true },
      },
    },
  });

  if (!pv) return null;

  const baseDecision = pv.predecessorDecisions[0];
  const activeOverride = await getBestActiveOverrideForPackageVersion(pv.id);

  if (activeOverride) {
    return {
      packageVersionId: pv.id,
      packageName: pv.packageName,
      version: pv.version,
      tarballHash: pv.tarballHash,
      verdict: activeOverride.targetVerdict,
      source: 'admin-override',
      overridden: true,
      reasonSummary: activeOverride.reason,
      statusUrl: `/status/${encodeURIComponent(pv.packageName)}/${pv.version}`,
      cliCommand: 'modulewarden status',
    };
  }

  if (baseDecision) {
    return {
      packageVersionId: pv.id,
      packageName: pv.packageName,
      version: pv.version,
      tarballHash: pv.tarballHash,
      verdict: baseDecision.verdict,
      source: 'agent',
      overridden: false,
      reasonSummary: baseDecision.reasonSummary,
      statusUrl: `/status/${encodeURIComponent(pv.packageName)}/${pv.version}`,
      cliCommand: 'modulewarden status',
    };
  }

  return null;
}

/**
 * Get developer-friendly status info for a package version.
 * Safe for public consumption — no secrets, prompts, or internal details.
 */
export async function getStatusInfo(
  packageName: string,
  version: string
): Promise<StatusInfo> {
  const prisma = getPrisma();

  const pv = await prisma.packageVersion.findFirst({
    where: { packageName, version },
    orderBy: { createdAt: 'desc' },
    select: { id: true, tarballHash: true, predecessorDecisions: { take: 1, select: { verdict: true, reasonSummary: true } } },
  });

  if (!pv) {
    return {
      packageName,
      version,
      tarballHash: '',
      effectiveVerdict: 'NOT_FOUND',
      source: 'none',
      explanation: `Package ${packageName}@${version} has not been seen by ModuleWarden yet.`,
      nextAction: `Run 'modulewarden preflight ${packageName}@${version}' to request a review.`,
    };
  }

  const activeOverride = await getBestActiveOverrideForPackageVersion(pv.id);

  let verdict: 'ALLOW' | 'BLOCK' | 'QUARANTINE' | 'UNREVIEWED';
  let source: 'agent' | 'admin-override' | 'none';
  let reasonSummary: string | undefined;
  let explanation: string;
  let nextAction: string;

  if (activeOverride) {
    verdict = activeOverride.targetVerdict;
    source = 'admin-override';
    reasonSummary = activeOverride.reason;
    explanation = buildExplanation(packageName, version, verdict, true);
    nextAction = verdict === 'ALLOW'
      ? 'This version is available for installation.'
      : `Contact your security admin for more information.`;
  } else if (pv.predecessorDecisions[0]) {
    const decision = pv.predecessorDecisions[0];
    verdict = decision.verdict;
    source = 'agent';
    reasonSummary = decision.reasonSummary ?? undefined;
    explanation = buildExplanation(packageName, version, verdict, false);
    nextAction = buildNextAction(verdict);
  } else {
    verdict = 'UNREVIEWED';
    source = 'none';
    explanation = `Package ${packageName}@${version} has not been reviewed yet. It is currently blocked until a review completes.`;
    nextAction = `Run 'modulewarden preflight ${packageName}@${version}' to request a review.`;
  }

  return {
    packageName,
    version,
    tarballHash: pv.tarballHash,
    effectiveVerdict: verdict,
    source,
    ...(reasonSummary !== undefined ? { reasonSummary } : {}),
    explanation,
    nextAction,
  };
}

function buildExplanation(pkg: string, ver: string, verdict: string, overridden: boolean): string {
  const prefix = overridden ? '[Admin Override] ' : '';
  switch (verdict) {
    case 'ALLOW':
      return `${prefix}Package ${pkg}@${ver} is approved for use.`;
    case 'BLOCK':
      return `${prefix}Package ${pkg}@${ver} is blocked by security policy.`;
    case 'QUARANTINE':
      return `${prefix}Package ${pkg}@${ver} is quarantined pending further review.`;
    default:
      return `${prefix}Package ${pkg}@${ver} status: ${verdict}.`;
  }
}

function buildNextAction(verdict: string): string {
  switch (verdict) {
    case 'ALLOW':
      return 'This version is available for installation through the registry.';
    case 'BLOCK':
      return 'Contact your security admin if you believe this is a false positive.';
    case 'QUARANTINE':
      return 'A re-review will occur automatically. Contact your security admin if urgent.';
    default:
      return 'Run modulewarden preflight to request review.';
  }
}
