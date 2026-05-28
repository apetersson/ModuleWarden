import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { getPrisma } from '@modulewarden/prisma-client';
import { fetchUpstreamPackument } from '@modulewarden/shared/services/upstream';
import { filterToApproved } from '../services/filter.js';
import { getDecisionsForVersions } from '../services/decisions.js';
import type { FilteredPackument, NpmPackageVersion, NpmPackument } from '@modulewarden/shared/npm-types';

interface PackumentParams {
  package: string;
}

function registryBaseUrl(request: FastifyRequest): string {
  const host = request.headers.host ?? 'localhost:8080';
  const forwardedProto = request.headers['x-forwarded-proto'];
  const proto = typeof forwardedProto === 'string' ? forwardedProto : request.protocol;
  return `${proto}://${host}`;
}

function localTarballUrl(packageName: string, version: string, baseUrl: string): string {
  const unscopedName = packageName.startsWith('@') ? (packageName.split('/')[1] ?? packageName) : packageName;
  const filename = `${unscopedName}-${version}.tgz`;
  return `${baseUrl}/${encodeURIComponent(packageName)}/-/${encodeURIComponent(filename)}`;
}

function toPendingResolutionPackument(packument: NpmPackument, reason: string, baseUrl: string): FilteredPackument {
  const versions: Record<string, NpmPackageVersion> = Object.fromEntries(
    Object.entries(packument.versions).map(([version, versionData]) => [
      version,
      {
        ...versionData,
        deprecated: reason,
        dist: {
          ...versionData.dist,
          tarball: localTarballUrl(packument.name, version, baseUrl),
        },
      },
    ])
  );

  return {
    name: packument.name,
    'dist-tags': {},
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
 * Register the packument endpoint.
 * GET /:package — Returns approved-only package metadata to npm clients.
 *
 * - Fetches upstream packument from public npm registry
 * - Looks up decisions for all upstream versions
 * - Filters to only currently allowed versions
 * - Rewrites dist-tags to newest approved versions
 */
export async function registerPackumentRoute(app: FastifyInstance): Promise<void> {
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

      // No project enabled — allow exact version resolution, but force the
      // install to hit ModuleWarden's tarball route where review is enqueued.
      if (!enabledProject) {
        return reply.send(toPendingResolutionPackument(
          upstream,
          `[PENDING] Package ${packageName} has not been reviewed by ModuleWarden yet. ` +
            `The tarball request will enqueue an audit and refuse installation.`,
          baseUrl
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
            `Run 'modulewarden status' to check progress.`,
          baseUrl
        ));
      }

      // Collect decisions for all upstream versions (keyed by version + exact hash).
      const upstreamVersions = Object.keys(upstream.versions);
      const decisions = await getDecisionsForVersions(packageName, upstreamVersions);

      // Filter to approved-only
      const filtered = filterToApproved(upstream, decisions, baseUrl);
      if (Object.keys(filtered.versions).length === 0) {
        return reply.send(toPendingResolutionPackument(
          upstream,
          `[PENDING] Package ${packageName} has no approved versions yet. ` +
            `The tarball request will enqueue an audit and refuse installation.`,
          baseUrl
        ));
      }
      return reply.send(filtered);
    }
  );
}
