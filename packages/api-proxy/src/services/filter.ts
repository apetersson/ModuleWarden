import type { NpmPackument, NpmPackageVersion, FilteredPackument, NpmDistTag } from '@modulewarden/shared/npm-types';

export interface VersionDecision {
  version: string;
  verdict: 'ALLOW' | 'BLOCK' | 'QUARANTINE';
  tarballHash: string;
}

/**
 * Filter an upstream packument to only include currently allowed versions.
 * Rewrites dist-tags to point to the newest approved version.
 *
 * @param packument - The full upstream packument
 * @param decisions - Map of version -> decision for all known versions
 * @returns A filtered packument with only approved versions
 */
export function filterToApproved(
  packument: NpmPackument,
  decisions: Map<string, VersionDecision>
): FilteredPackument {
  const allowedVersions: Record<string, NpmPackageVersion> = {};
  const approvedDistTags: NpmDistTag = {};

  // Filter versions to only those with ALLOW verdict
  for (const [version, versionData] of Object.entries(packument.versions)) {
    const decision = decisions.get(version);
    if (decision?.verdict === 'ALLOW') {
      allowedVersions[version] = versionData;
    }
  }

  // Rewrite dist-tags to newest allowed version per tag
  for (const [tag, taggedVersion] of Object.entries(packument['dist-tags'])) {
    const decision = decisions.get(taggedVersion);

    if (decision?.verdict === 'ALLOW') {
      // Tag points to an allowed version — keep it
      approvedDistTags[tag] = taggedVersion;
    } else {
      // Tag points to a non-allowed version — find the newest allowed
      // version that matches the same semver range, or leave the tag empty
      const sortedAllowed = Object.keys(allowedVersions).sort(semverSortDesc);
      if (sortedAllowed.length > 0) {
        // For 'latest' and other major tags, use the highest allowed version
        approvedDistTags[tag] = sortedAllowed[0];
      }
      // If no allowed versions exist, the tag is omitted
    }
  }

  const repo = packument.repository as { type?: string; url?: string } | undefined;
  return {
    name: packument.name,
    'dist-tags': approvedDistTags,
    versions: allowedVersions,
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
