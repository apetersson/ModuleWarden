import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { getPrisma } from '@modulewarden/prisma-client';
import { getEffectiveVerdictByHash } from '../services/decisions.js';
import { fetchUpstreamTarball } from '@modulewarden/shared/services/upstream';
import type { RegistryError } from '@modulewarden/shared/npm-types';

interface TarballParams {
  package: string;
  filename: string;
}

/**
 * Parse the version from a tarball filename.
 * Format: package-name-1.0.0.tgz, or @scope/package-name-1.0.0.tgz
 */
function parseVersionFromFilename(packageName: string, filename: string): string | null {
  // Remove .tgz extension
  const withoutExt = filename.replace(/\.tgz$/, '');

  // For scoped packages: @scope/name-1.0.0 -> extract version from suffix
  // For unscoped: package-name-1.0.0 -> extract version from suffix
  // The pattern is: the version comes after the last occurrence of `-` that
  // starts with a digit after the package name prefix.

  // Simple heuristic: split on `-` and find the version-like part
  const parts = withoutExt.split('-');
  // Try to find the version part (starts with digit) from the end
  for (let i = parts.length - 1; i >= 0; i--) {
    if (/^\d+\.\d+\.\d+/.test(parts[i])) {
      return parts.slice(i).join('-');
    }
  }
  return null;
}

/**
 * Register the tarball endpoint.
 * GET /:package/-/:filename — Serve or enqueue review for package tarballs.
 *
 * - If the version has an ALLOW decision: proxy from Verdaccio
 * - If BLOCK/QUARANTINE: return 403 with status info
 * - If unreviewed: enqueue review via pg-boss, return 404 with guidance
 */
export async function registerTarballRoute(
  app: FastifyInstance,
  verdaccioUrl: string,
  pgBossSend?: (queue: string, data: Record<string, unknown>) => Promise<string | null>
): Promise<void> {
  app.get<{ Params: TarballParams }>(
    '/:package/-/:filename',
    async (request: FastifyRequest<{ Params: TarballParams }>, reply: FastifyReply) => {
      const { package: packageName, filename } = request.params;
      const version = parseVersionFromFilename(packageName, filename);

      if (!version) {
        return reply.status(400).send({
          error: 'Invalid tarball filename',
          reason: `Could not parse version from ${filename}`,
          package: packageName,
        } satisfies RegistryError);
      }

      const prisma = getPrisma();

      // Check project readiness (same logic as packument route)
      const enabledProject = await prisma.project.findFirst({
        where: { registryEnabled: true },
        select: { id: true, graphState: true },
      });

      // No enabled project — no tarballs available
      if (!enabledProject || enabledProject.graphState !== 'READY') {
        return reply.status(503).send({
          error: 'Registry not ready',
          reason: enabledProject
            ? `Project graph is still being audited. Run 'modulewarden preflight' or 'modulewarden status'.`
            : `ModuleWarden registry is not yet configured. Run 'modulewarden preflight' to start.`,
          package: packageName,
          requestedVersion: version,
          cliCommand: 'modulewarden status',
        } satisfies RegistryError);
      }

      // Find the package version in our database by name + version
      const pv = await prisma.packageVersion.findFirst({
        where: { packageName, version },
        orderBy: { createdAt: 'desc' },
      });

      if (pv) {
        // We know about this version — check its effective verdict
        const verdict = await getEffectiveVerdictByHash(packageName, version, pv.tarballHash);

        if (verdict === 'ALLOW') {
          // Proxy tarball from Verdaccio
          const tarballResponse = await fetch(`${verdaccioUrl}/${encodeURIComponent(packageName)}/-/${encodeURIComponent(filename)}`);
          if (!tarballResponse.ok) {
            return reply.status(502).send({
              error: 'Backend unavailable',
              reason: 'Tarball not found in backing registry',
              package: packageName,
              requestedVersion: version,
            } satisfies RegistryError);
          }
          return reply
            .headers(Object.fromEntries(tarballResponse.headers.entries()))
            .send(tarballResponse.body);
        }

        if (verdict === 'BLOCK' || verdict === 'QUARANTINE') {
          return reply.status(403).send({
            error: 'Version blocked',
            reason: verdict === 'BLOCK'
              ? `Package ${packageName}@${version} is blocked by security policy`
              : `Package ${packageName}@${version} is under review (quarantined)`,
            package: packageName,
            requestedVersion: version,
            cliCommand: 'modulewarden status',
          } satisfies RegistryError);
        }
      }

      // Version not found or no decision — enqueue review
      if (pgBossSend) {
        await pgBossSend('package-review', {
          packageName,
          packageVersion: version,
          tarballHash: pv?.tarballHash ?? 'unknown',
          auditContext: `preflight:tarball:${packageName}@${version}`,
          idempotencyKey: `tarball:${packageName}:${version}`,
        }).catch(() => {
          // Fire-and-forget: queueing failure shouldn't crash the proxy
        });
      }

      return reply.status(404).send({
        error: 'Version not yet reviewed',
        reason: `${packageName}@${version} has not been reviewed yet. A review has been enqueued.`,
        package: packageName,
        requestedVersion: version,
        cliCommand: 'modulewarden status',
      } satisfies RegistryError);
    }
  );
}
