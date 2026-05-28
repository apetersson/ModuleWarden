import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { getPrisma } from '@modulewarden/prisma-client';
import { logger } from '@modulewarden/shared/services/logger';
import { getEffectiveVerdictByHash } from '../services/decisions.js';
import { fetchUpstreamPackument } from '@modulewarden/shared/services/upstream';
import { buildIdempotencyKey } from '@modulewarden/shared/constants';
import type { RegistryError, NpmPackument } from '@modulewarden/shared/npm-types';

interface TarballParams {
  package: string;
  filename: string;
}

/**
 * Parse the version from a tarball filename.
 * Format: package-name-1.0.0.tgz, or @scope/package-name-1.0.0.tgz
 */
function parseVersionFromFilename(_packageName: string, filename: string): string | null {
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
    const part = parts[i];
    if (part && /^\d+\.\d+\.\d+/.test(part)) {
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
  pgBossSend?: (data: Record<string, unknown>) => Promise<string | null>
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

      // Fetch upstream packument
      let upstream: NpmPackument | null;
      try {
        upstream = await fetchUpstreamPackument(packageName);
      } catch {
        return reply.status(502).send({
          error: 'Backend unavailable',
          reason: 'Could not fetch upstream package metadata',
          package: packageName,
          requestedVersion: version,
        } satisfies RegistryError);
      }

      // Check project readiness (same logic as packument route)
      const enabledProject = await prisma.project.findFirst({
        where: { registryEnabled: true },
        select: { id: true, graphState: true },
      });

      // No enabled project — no tarballs available
      if (enabledProject?.graphState !== 'READY') {
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

      const versionData = upstream?.versions?.[version];
      const resolvedHash = versionData?.dist?.integrity ?? versionData?.dist?.shasum;

      let pv: { id: string; tarballHash: string } | null = await prisma.packageVersion.findFirst({
        where: {
          packageName,
          version,
          registrySource: 'npm',
          ...(resolvedHash ? { tarballHash: resolvedHash } : {}),
        },
        orderBy: { createdAt: 'desc' },
        select: {
          id: true,
          tarballHash: true,
        },
      });

      if (!pv && resolvedHash) {
        // Preserve exact version/hash identity for this incoming request.
        pv = await prisma.packageVersion.upsert({
          where: {
            packageName_version_registrySource_tarballHash: {
              packageName,
              version,
              registrySource: 'npm',
              tarballHash: resolvedHash,
            },
          },
          create: {
            packageName,
            version,
            registrySource: 'npm',
            tarballHash: resolvedHash,
            hasLifecycleScript: typeof versionData?.scripts === 'object' &&
              ['preinstall', 'install', 'postinstall', 'prepare'].some(
                (hook) => (versionData.scripts as Record<string, string> | undefined)?.[hook]
              ),
          },
          update: {},
          select: {
            id: true,
            tarballHash: true,
          },
        });
      }

      const effectiveHash = pv?.tarballHash ?? resolvedHash ?? '';
      if (pv || resolvedHash) {
        // We know about this version — check its effective verdict
        const verdict = await getEffectiveVerdictByHash(packageName, version, effectiveHash);

        if (verdict === 'ALLOW') {
          // Proxy tarball from Verdaccio
          let tarballResponse: Response;
          try {
            tarballResponse = await fetch(`${verdaccioUrl}/${encodeURIComponent(packageName)}/-/${encodeURIComponent(filename)}`);
          } catch {
            return reply.status(502).send({
              error: 'Backend unavailable',
              reason: 'Could not fetch tarball from backing registry',
              package: packageName,
              requestedVersion: version,
            } satisfies RegistryError);
          }
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

      // Version not found or no decision — reject if hash is unresolvable
      if (!effectiveHash) {
        return reply.status(502).send({
          error: 'Backend unavailable',
          reason: `Could not resolve integrity hash for ${packageName}@${version}. The upstream registry did not provide a valid integrity hash.`,
          package: packageName,
          requestedVersion: version,
        } satisfies RegistryError);
      }

      // Enqueue review if hash was resolved
      let enqueued = false;
      if (pgBossSend) {
        const auditContext = `preflight:tarball:${packageName}@${version}`;
        const tarballHash = effectiveHash;
        try {
          const jobId = await pgBossSend({
            packageName,
            packageVersion: version,
            tarballHash,
            auditContext,
            idempotencyKey: buildIdempotencyKey('package-review', packageName, version, tarballHash, auditContext),
          });
          enqueued = Boolean(jobId);
        } catch (err) {
          logger.warn('Failed to enqueue review job for tarball', {
            packageName,
            version,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }

      return reply.status(404).send({
        error: 'Version not yet reviewed',
        reason: enqueued
          ? `${packageName}@${version} has not been reviewed yet. A review has been enqueued.`
          : `${packageName}@${version} has not been reviewed yet. Unable to enqueue review.`,
        package: packageName,
        requestedVersion: version,
        cliCommand: 'modulewarden status',
      } satisfies RegistryError);
    }
  );
}
