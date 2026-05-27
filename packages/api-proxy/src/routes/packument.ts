import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { getPrisma } from '@modulewarden/prisma-client';
import { fetchUpstreamPackument } from '@modulewarden/shared/services/upstream';
import { filterToApproved } from '../services/filter.js';
import { getDecisionsForVersions } from '../services/decisions.js';

interface PackumentParams {
  package: string;
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

      // No project enabled — proxy in standby mode, return empty packument
      if (!enabledProject) {
        return reply.send({
          name: packageName,
          'dist-tags': {},
          versions: {},
          description: upstream.description,
          modified: new Date().toISOString(),
        });
      }

      // Check project graph readiness
      // If the project's dependency graph is still being audited, mark all
      // versions as deprecated to prevent npm from installing unvetted code,
      // but still show the package exists so failures are deterministic.
      if (enabledProject.graphState !== 'READY') {
        const versions = Object.fromEntries(
          Object.entries(upstream.versions).map(([v, vd]) => [
            v,
            {
              ...vd,
              deprecated: `[AUDITING] Package ${packageName} is still being audited. ` +
                `Run 'modulewarden status' to check progress.`,
            },
          ])
        );
        return reply.send({
          name: packageName,
          'dist-tags': {},
          versions,
          description: upstream.description,
          license: upstream.license,
          modified: new Date().toISOString(),
        });
      }

      // Collect decisions for all upstream versions
      const upstreamVersions = Object.keys(upstream.versions);
      const decisions = await getDecisionsForVersions(packageName, upstreamVersions);

      // Filter to approved-only
      const filtered = filterToApproved(upstream, decisions);
      return reply.send(filtered);
    }
  );
}
