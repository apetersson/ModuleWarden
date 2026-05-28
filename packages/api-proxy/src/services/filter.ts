import type { NpmPackument, NpmPackageVersion, FilteredPackument } from '@modulewarden/shared/npm-types';

export interface VersionDecision {
  version: string;
  verdict: 'ALLOW' | 'BLOCK' | 'QUARANTINE';
  tarballHash: string;
}

/**
 * Filter an upstream packument to include only currently allowed versions,
 * while surfacing non-allowed versions as deprecated with a helpful message.
 * Rewrites dist-tags to point to the newest approved version.
 *
 * Non-allowed versions are included as deprecated so npm clients can show
 * a meaningful error message rather than a cryptic "not found".
 */
export function filterToApproved(
  packument: NpmPackument,
  decisions: Map<string, VersionDecision>
): FilteredPackument {
  const allowedVersions: Record<string, NpmPackageVersion> = {};
  const versions: Record<string, NpmPackageVersion> = {};

  for (const [version, versionData] of Object.entries(packument.versions)) {
    const decision = getDecisionForPackumentVersion(version, versionData, decisions);

    if (decision?.verdict === 'ALLOW') {
      allowedVersions[version] = versionData;
      versions[version] = versionData;
    } else if (decision?.verdict === 'BLOCK') {
      // Include blocked versions as deprecated with explanation
      versions[version] = {
        ...versionData,
        deprecated: `[BLOCKED] Package ${packument.name}@${version} is blocked by security policy. Run 'modulewarden status' for details.`,
      };
    } else if (decision?.verdict === 'QUARANTINE') {
      versions[version] = {
        ...versionData,
        deprecated: `[QUARANTINED] Package ${packument.name}@${version} is under review. Run 'modulewarden status' for details.`,
      };
    } else {
      // Unreviewed version — include with deprecation message
      versions[version] = {
        ...versionData,
        deprecated: `[UNREVIEWED] Package ${packument.name}@${version} has not been reviewed yet. Run 'modulewarden preflight' to request a review.`,
      };
    }
  }

  // Rewrite dist-tags to newest allowed version per tag
  const approvedDistTags: Record<string, string> = {};
  const sortedAllowed = Object.keys(allowedVersions).sort(semverSortDesc);

  for (const [tag, taggedVersion] of Object.entries(packument['dist-tags'])) {
    const taggedData = packument.versions[taggedVersion];
    const decision = taggedData
      ? getDecisionForPackumentVersion(taggedVersion, taggedData, decisions)
      : null;

    if (decision?.verdict === 'ALLOW') {
      approvedDistTags[tag] = taggedVersion;
    } else if (sortedAllowed.length > 0) {
      // Fall back to the highest allowed version
      approvedDistTags[tag] = sortedAllowed[0];
    }
    // If no allowed versions, omit the tag
  }

  const repo = packument.repository as { type?: string; url?: string } | undefined;
  return {
    name: packument.name,
    'dist-tags': approvedDistTags,
    versions,
    description: packument.description,
    license: packument.license,
    homepage: packument.homepage,
    repository: repo ? { type: repo.type ?? '', url: repo.url ?? '' } : undefined,
    modified: new Date().toISOString(),
  };
}

/**
 * Check if a specific version has an effective allow decision.
 */
export function isVersionAllowed(
  version: string,
  decisions: Map<string, VersionDecision>
): boolean {
  const decision = decisions.get(version);
  return decision?.verdict === 'ALLOW';
}

/**
 * Check if a specific version has an effective block or quarantine decision.
 */
export function isVersionDenied(
  version: string,
  decisions: Map<string, VersionDecision>
): boolean {
  const decision = decisions.get(version);
  return decision?.verdict === 'BLOCK' || decision?.verdict === 'QUARANTINE';
}

function getDecisionForPackumentVersion(
  version: string,
  versionData: NpmPackageVersion,
  decisions: Map<string, VersionDecision>
): VersionDecision | undefined {
  const upstreamHash = versionData.dist?.integrity ?? versionData.dist?.shasum;
  if (upstreamHash) {
    const exact = decisions.get(decisionKey(version, upstreamHash));
    if (exact) return exact;
  }

  return decisions.get(version);
}

function decisionKey(version: string, tarballHash: string): string {
  return `${version}::${tarballHash}`;
}

/**
 * Simple semver sort (descending) for finding the highest version.
 */
function semverSortDesc(a: string, b: string): number {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    const diff = (pb[i] || 0) - (pa[i] || 0);
    if (diff !== 0) return diff;
  }
  return 0;
}
