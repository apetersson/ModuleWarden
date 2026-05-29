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
 * Callback signature for enqueuing an audit-pipeline-schedule job.
 * The worker resolves the full DAG and audits packages in topological order.
 */
type EnqueuePipeline = (data: {
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
 * Enqueue an audit-pipeline-schedule job. The worker will resolve the full
 * dependency DAG and audit packages in topological order (leaf deps first).
 * Runs in the background so the HTTP response is not delayed.
 */
async function enqueuePipeline(
  packageName: string,
  enqueuePipelineJob: (data: {
    packageName: string;
    packageVersion: string;
    tarballHash: string;
    auditContext: string;
  }) => Promise<string | null>,
  upstream: NpmPackument,
): Promise<void> {
  const allVersions = Object.keys(upstream.versions);
  const stableVersions = allVersions.filter((v) => !v.includes('-') && !v.includes('rc') && !v.includes('alpha') && !v.includes('beta'));
  const latestTag = upstream['dist-tags']?.latest;
  const latestVersion = latestTag && upstream.versions[latestTag]
    ? latestTag
    : stableVersions.sort(semverSortDesc)[0] ?? allVersions.sort(semverSortDesc)[0];

  if (!latestVersion) return;
  const versionData = upstream.versions[latestVersion];
  if (!versionData) return;

  const tarballHash = versionData.dist?.integrity ?? versionData.dist?.shasum;
  if (!tarballHash) {
    logger.warn('Cannot enqueue pipeline: no tarball hash for root package', { packageName, version: latestVersion });
    return;
  }

  const auditContext = `preflight:packument:pipeline:${packageName}@${latestVersion}`;
  try {
    await enqueuePipelineJob({
      packageName,
      packageVersion: latestVersion,
      tarballHash,
      auditContext,
    });
  } catch (err) {
    logger.warn('Failed to enqueue audit pipeline', {
      packageName,
      version: latestVersion,
      error: err instanceof Error ? err.message : String(err),
    });
  }
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
  enqueuePipelineJob?: EnqueuePipeline
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
        // Enqueue an audit pipeline that resolves the full dependency DAG
        // and audits packages in topological order (leaf deps first).
        if (enqueuePipelineJob) {
          enqueuePipeline(packageName, enqueuePipelineJob, upstream).catch(
            (err) => logger.warn('Pipeline enqueue failed', { packageName, error: String(err) })
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
        // Enqueue an audit pipeline that resolves the full dependency DAG
        if (enqueuePipelineJob) {
          enqueuePipeline(packageName, enqueuePipelineJob, upstream).catch(
            (err) => logger.warn('Pipeline enqueue failed', { packageName, error: String(err) })
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
