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
        const unscopedName = packument.name.startsWith('@') ? (packument.name.split('/')[1] ?? packument.name) : packument.name;
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
      approvedDistTags[tag] = sortedAllowed[0]!;
    }
    // If no allowed versions, omit the tag
  }

  return {
    name: packument.name,
    'dist-tags': approvedDistTags,
    versions: allowedVersions,
    ...(packument.description !== undefined ? { description: packument.description } : {}),
    ...(packument.license !== undefined ? { license: packument.license } : {}),
    ...(packument.homepage !== undefined ? { homepage: packument.homepage } : {}),
    ...(packument.repository
      ? { repository: { type: packument.repository.type, url: packument.repository.url } }
      : {}),
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
 * Parse a semver string into numeric parts and pre-release (L-4).
 */
function parseSemver(v: string): { major: number; minor: number; patch: number; preRelease: string | null } {
  const cleaned = v.replace(/^[vV]/, '');
  const preReleaseMatch = cleaned.match(/-([a-zA-Z0-9.]+)/);
  const preRelease = preReleaseMatch?.[1] ?? null;
  const matchIdx = preReleaseMatch?.index;
  const numeric = preRelease != null && matchIdx != null ? cleaned.slice(0, matchIdx) : cleaned;
  const parts = numeric.split('.').map(Number);
  while (parts.length < 3) parts.push(0);
  return { major: parts[0] ?? 0, minor: parts[1] ?? 0, patch: parts[2] ?? 0, preRelease };
}

/**
 * Proper semver sort (descending) that handles pre-release suffixes (L-4).
 */
function semverSortDesc(a: string, b: string): number {
  const pa = parseSemver(a);
  const pb = parseSemver(b);

  if (pa.major !== pb.major) return pb.major - pa.major;
  if (pa.minor !== pb.minor) return pb.minor - pa.minor;
  if (pa.patch !== pb.patch) return pb.patch - pa.patch;

  // Same numeric version — release > pre-release, compare pre-release strings
  if (pa.preRelease && !pb.preRelease) return -1; // b (release) sorts before a (pre-release)
  if (!pa.preRelease && pb.preRelease) return 1;   // a (release) sorts before b (pre-release)
  if (pa.preRelease && pb.preRelease) {
    // Simple string comparison for pre-release identifiers
    return pb.preRelease.localeCompare(pa.preRelease);
  }
  return 0;
}
