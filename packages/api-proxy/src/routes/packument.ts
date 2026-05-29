import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { getPrisma } from '@modulewarden/prisma-client';
import { fetchUpstreamPackument } from '@modulewarden/shared/services/upstream';
import { filterToApproved } from '../services/filter.js';
import { getDecisionsForVersions } from '../services/decisions.js';
import { logger } from '@modulewarden/shared/services/logger';
import type { VersionDecision } from '../services/filter.js';
import type { FilteredPackument, NpmPackageVersion, NpmPackument } from '@modulewarden/shared/npm-types';

interface PackumentParams {
  package: string;
}

/**
 * Callback signature for enqueuing a package review.
 * Returns the pg-boss job ID or null if enqueue failed.
 */
type EnqueuePackageReview = (data: {
  packageName: string;
  packageVersion: string;
  tarballHash: string;
  auditContext: string;
}) => Promise<string | null>;

function registryBaseUrl(request: FastifyRequest): string {
  const host = request.headers.host ?? 'localhost:8080';
  const forwardedProto = request.headers['x-forwarded-proto'];
  const proto = typeof forwardedProto === 'string' ? forwardedProto : request.protocol;
  return `${proto}://${host}`;
}

/**
 * Build the publicly visible queue-status URL for a package.
 * Users can visit this to watch audit progress.
 */
function queuePublicUrl(baseUrl: string, packageName: string): string {
  return `${baseUrl}/queue/${encodeURIComponent(packageName)}`;
}

function localTarballUrl(packageName: string, version: string, baseUrl: string): string {
  const unscopedName = packageName.startsWith('@') ? (packageName.split('/')[1] ?? packageName) : packageName;
  const filename = `${unscopedName}-${version}.tgz`;
  return `${baseUrl}/${encodeURIComponent(packageName)}/-/${encodeURIComponent(filename)}`;
}

function decisionForVersion(
  version: string,
  versionData: NpmPackageVersion,
  decisions: Map<string, VersionDecision>
): VersionDecision | undefined {
  const upstreamHash = versionData.dist?.integrity ?? versionData.dist?.shasum;
  if (upstreamHash) {
    const exact = decisions.get(`${version}::${upstreamHash}`);
    if (exact) return exact;
  }
  return decisions.get(version);
}

function warningForVersion(
  packageName: string,
  version: string,
  versionData: NpmPackageVersion,
  decisions: Map<string, VersionDecision>,
  fallbackReason: string
): string {
  const decision = decisionForVersion(version, versionData, decisions);
  if (decision?.verdict === 'BLOCK') {
    return `[BLOCKED] ModuleWarden blocked ${packageName}@${version}. ` +
      `This package version is not available for installation.`;
  }
  if (decision?.verdict === 'QUARANTINE') {
    return `[QUARANTINED] ModuleWarden quarantined ${packageName}@${version}. ` +
      `Human review is required before installation.`;
  }
  return fallbackReason;
}

/**
 * Return a packument with original dist-tags preserved (so npm/pnpm can resolve
 * 'latest' and other tags) but all versions marked with a deprecation warning.
 * The deprecated message includes a publicly visible queue-status URL where the
 * user can watch audit progress before retrying the install.
 */
function toPendingResolutionPackument(
  packument: NpmPackument,
  reason: string,
  baseUrl: string,
  decisions: Map<string, VersionDecision> = new Map()
): FilteredPackument {
  const statusUrl = queuePublicUrl(baseUrl, packument.name);
  const versions: Record<string, NpmPackageVersion> = Object.fromEntries(
    Object.entries(packument.versions).map(([version, versionData]) => [
      version,
      {
        ...versionData,
        deprecated: warningForVersion(packument.name, version, versionData, decisions, reason) +
          ` Check audit progress at: ${statusUrl} — ` +
          `retry the install after audit completes.`,
        dist: {
          ...versionData.dist,
          tarball: localTarballUrl(packument.name, version, baseUrl),
        },
      },
    ])
  );

  return {
    name: packument.name,
    // PRESERVE original dist-tags so npm/pnpm can resolve 'latest', 'next', etc.
    // Without this, pnpm shows: 'The latest release of X is "undefined".'
    'dist-tags': { ...packument['dist-tags'] },
    versions,
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
 * Enqueue a package and its direct dependencies for high-priority review.
 *
 * Fetches the upstream packument for each direct dependency to resolve the
 * 'latest' version and its tarball hash before enqueuing. Runs in the
 * background (not awaited) so the HTTP response is not delayed.
 */
async function enqueuePackageAndDeps(
  packageName: string,
  enqueueReview: (data: {
    packageName: string;
    packageVersion: string;
    tarballHash: string;
    auditContext: string;
  }) => Promise<string | null>,
  upstream: NpmPackument,
  upstreamFetch: (name: string) => Promise<NpmPackument | null> = fetchUpstreamPackument,
): Promise<void> {
  // Collect all (depName, depVersionRange) pairs from the latest version's
  // dependencies, devDependencies, and peerDependencies.
  const allVersions = Object.keys(upstream.versions);
  // Pick the latest stable (non-prerelease) version
  const stableVersions = allVersions.filter((v) => !v.includes('-') && !v.includes('rc') && !v.includes('alpha') && !v.includes('beta'));
  const latestTag = upstream['dist-tags']?.latest;
  const fallbackVersion = stableVersions.sort(semverSortDesc)[0] ?? allVersions.sort(semverSortDesc)[0];
  const latestVersion = latestTag && upstream.versions[latestTag]
    ? latestTag
    : fallbackVersion;

  if (!latestVersion) return;
  const versionData = upstream.versions[latestVersion];
  if (!versionData) return;

  const tarballHash = versionData.dist?.integrity ?? versionData.dist?.shasum;
  if (!tarballHash) return;

  // 1. Enqueue the root package itself
  const rootAuditContext = 'preflight:packument:discovery';
  try {
    await enqueueReview({
      packageName,
      packageVersion: latestVersion,
      tarballHash,
      auditContext: rootAuditContext,
    });
  } catch (err) {
    logger.warn('Failed to enqueue root package review', {
      packageName,
      version: latestVersion,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  // 2. Collect all dependency names from the latest version
  const depEntries: Array<{ name: string; range: string }> = [];
  for (const depType of ['dependencies', 'devDependencies', 'peerDependencies'] as const) {
    const deps = versionData[depType] as Record<string, string> | undefined;
    if (deps) {
      for (const [depName, depRange] of Object.entries(deps)) {
        if (!depName.startsWith('@modulewarden/') && !depName.startsWith('@types/')) {
          depEntries.push({ name: depName, range: depRange });
        }
      }
    }
  }

  if (depEntries.length === 0) return;

  // 3. For each dependency, fetch its upstream packument and enqueue the latest version
  const depContext = 'preflight:packument:dep-of:' + packageName;
  await Promise.allSettled(
    depEntries.map(async (dep) => {
      try {
        const depUpstream = await upstreamFetch(dep.name);
        if (!depUpstream) return;

        const depStableVersions = Object.keys(depUpstream.versions)
          .filter((v) => !v.includes('-') && !v.includes('rc') && !v.includes('alpha') && !v.includes('beta'));
        const depLatestTag = depUpstream['dist-tags']?.latest;
        const depLatestVersion = depLatestTag && depUpstream.versions[depLatestTag]
          ? depLatestTag
          : depStableVersions.sort(semverSortDesc)[0] ?? Object.keys(depUpstream.versions).sort(semverSortDesc)[0];

        if (!depLatestVersion) return;
        const depVersionData = depUpstream.versions[depLatestVersion];
        const depHash = depVersionData?.dist?.integrity ?? depVersionData?.dist?.shasum;
        if (!depHash) return;

        await enqueueReview({
          packageName: dep.name,
          packageVersion: depLatestVersion,
          tarballHash: depHash,
          auditContext: depContext,
        });
      } catch (err) {
        logger.warn('Failed to enqueue dependency review', {
          dependency: dep.name,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    })
  );
}

/**
 * Parse a semver string into numeric parts (L-4).
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

  if (pa.preRelease && !pb.preRelease) return -1;
  if (!pa.preRelease && pb.preRelease) return 1;
  if (pa.preRelease && pb.preRelease) {
    return pb.preRelease.localeCompare(pa.preRelease);
  }
  return 0;
}

/**
 * Register the packument endpoint.
 * GET /:package — Returns package metadata to npm clients.
 *
 * - Fetches upstream packument from public npm registry
 * - Looks up decisions for all upstream versions
 * - Filters to only currently allowed versions
 * - Rewrites dist-tags to newest approved versions
 * - If no versions are approved, preserves original dist-tags so npm/pnpm can
 *   resolve 'latest', but marks all versions as deprecated with a pointer to
 *   the public queue-status URL, and enqueues the package + its transitive
 *   dependencies for high-priority review.
 */
export async function registerPackumentRoute(
  app: FastifyInstance,
  enqueuePackageReview?: EnqueuePackageReview
): Promise<void> {
  app.get<{ Params: PackumentParams }>(
    '/:package',
    async (request: FastifyRequest<{ Params: PackumentParams }>, reply: FastifyReply) => {
      const packageName = request.params.package;

      // Skip internal packages
      if (packageName.startsWith('@modulewarden/')) {
        return reply.status(404).send({ error: 'Not found' });
      }

      const prisma = getPrisma();
      const baseUrl = registryBaseUrl(request);
      reply.header('Cache-Control', 'no-store');

      // Check project registry readiness
      const enabledProject = await prisma.project.findFirst({
        where: { registryEnabled: true },
        select: { id: true, graphState: true },
      });

      // Fetch upstream packument
      const upstream = await fetchUpstreamPackument(packageName);
      if (!upstream) {
        return reply.status(404).send({ error: `${packageName} not found` });
      }

      const upstreamVersions = Object.keys(upstream.versions);
      const decisions = await getDecisionsForVersions(packageName, upstreamVersions);
      const filtered = filterToApproved(upstream, decisions, baseUrl);

      const statusUrl = queuePublicUrl(baseUrl, packageName);

      // No project enabled — allow exact version resolution, but force the
      // install to hit ModuleWarden's tarball route where review is enqueued.
      // If versions have already been approved/promoted in a project-less
      // local demo, serve the approved metadata without stale warning text.
      if (!enabledProject) {
        if (Object.keys(filtered.versions).length > 0) {
          return reply.send(filtered);
        }
        // Enqueue the package + its dependencies if no versions are approved
        if (enqueuePackageReview) {
          enqueuePackageAndDeps(packageName, enqueuePackageReview, upstream).catch(
            (err) => logger.warn('Background dep enqueue failed', { packageName, error: String(err) })
          );
        }
        return reply.send(toPendingResolutionPackument(
          upstream,
          `[PENDING] Package ${packageName} has not been reviewed yet. ` +
            `Visit ${statusUrl} to track audit progress and retry once complete.`,
          baseUrl,
          decisions
        ));
      }

      // Check project graph readiness
      // If the project's dependency graph is still being audited, mark all
      // versions as deprecated to prevent npm from installing unvetted code,
      // but still show the package exists so failures are deterministic.
      if (enabledProject.graphState !== 'READY') {
        return reply.send(toPendingResolutionPackument(
          upstream,
          `[AUDITING] Package ${packageName} is still being audited. ` +
            `Visit ${statusUrl} to track progress and retry once complete.`,
          baseUrl,
          decisions
        ));
      }

      // Filter to approved-only
      if (Object.keys(filtered.versions).length === 0) {
        // Enqueue the package + its dependencies if no versions are approved
        if (enqueuePackageReview) {
          enqueuePackageAndDeps(packageName, enqueuePackageReview, upstream).catch(
            (err) => logger.warn('Background dep enqueue failed', { packageName, error: String(err) })
          );
        }
        return reply.send(toPendingResolutionPackument(
          upstream,
          `[PENDING] Package ${packageName} has no approved versions yet. ` +
            `Visit ${statusUrl} to track audit progress and retry once complete.`,
          baseUrl,
          decisions
        ));
      }
      return reply.send(filtered);
    }
  );
}
