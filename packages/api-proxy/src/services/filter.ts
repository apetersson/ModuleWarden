import type { NpmPackument, NpmPackageVersion, FilteredPackument } from '@modulewarden/shared/npm-types';

export interface VersionDecision {
  version: string;
  verdict: 'ALLOW' | 'BLOCK' | 'QUARANTINE';
  tarballHash: string;
}

/**
 * Filter an upstream packument to include ONLY currently allowed versions.
 * Blocked, quarantined, and unreviewed versions are OMITTED entirely so npm
 * clients cannot resolve them. Dist-tags are rewritten to point to the
 * newest approved version (C-1).
 *
 * If a blocked/quarantined version is requested by exact tarball URL,
 * the tarball route handles denial (403). For packument queries, npm
 * clients see only approved versions.
 */
export function filterToApproved(
  packument: NpmPackument,
  decisions: Map<string, VersionDecision>
): FilteredPackument {
  const allowedVersions: Record<string, NpmPackageVersion> = {};

  for (const [version, versionData] of Object.entries(packument.versions)) {
    const decision = getDecisionForPackumentVersion(version, versionData, decisions);

    if (decision?.verdict === 'ALLOW') {
      // Rewrite tarball URL to ModuleWarden-controlled download (C-2)
      // npm clients receive a URL pointing to ModuleWarden's tarball route
      // instead of the upstream registry, so they download the promoted artifact
      // from Verdaccio through ModuleWarden's proxy.
      const rewritten = { ...versionData };
      if (rewritten.dist?.tarball) {
        // The npm client should download from ModuleWarden's own tarball endpoint,
        // which proxies to Verdaccio for allowed versions.
        const unscopedName = packument.name.startsWith('@') ? packument.name.split('/')[1] : packument.name;
        const filename = `${unscopedName}-${version}.tgz`;
        const localUrl = `/${encodeURIComponent(packument.name)}/-/${encodeURIComponent(filename)}`;
        rewritten.dist = { ...rewritten.dist, tarball: localUrl };
      }
      allowedVersions[version] = rewritten;
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
  // Strip pre-release suffix, compare numeric parts (M-5)
  const cleanA = a.replace(/-.*$/, '');
  const cleanB = b.replace(/-.*$/, '');
  const pa = cleanA.split('.').map(Number);
  const pb = cleanB.split('.').map(Number);
  const maxLen = Math.max(pa.length, pb.length);
  for (let i = 0; i < maxLen; i++) {
    const diff = (pb[i] || 0) - (pa[i] || 0);
    if (diff !== 0) return diff;
  }
  return 0;
}
