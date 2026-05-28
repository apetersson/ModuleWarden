import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { requireAnyAuth } from '../middleware/auth.js';
import { getStatusInfo } from '../services/policy.js';

interface StatusParams {
  package: string;
}

interface ExplainParams {
  package: string;
  version: string;
}

/**
 * Status and explain endpoints for developers.
 * Safe for public consumption — never leaks prompts, secrets, or internal tool details.
 */
export async function registerStatusRoutes(app: FastifyInstance): Promise<void> {
  /**
   * GET /status — List all packages with their status. (A-2: requires auth)
   */
  app.get('/status', { preHandler: [requireAnyAuth] }, async (_request, reply) => {
    const prisma = (await import('@modulewarden/prisma-client')).getPrisma();
    const packages = await prisma.packageVersion.findMany({
      distinct: ['packageName'],
      select: { packageName: true, version: true, createdAt: true },
      orderBy: { createdAt: 'desc' },
    });

    const result = await Promise.all(
      packages.map(async (p) => {
        const info = await getStatusInfo(p.packageName, p.version);
        return { ...info, updatedAt: p.createdAt.toISOString() };
      })
    );

    return reply.send({ packages: result });
  });

  /**
   * GET /status/:package — Get status of all known versions of a package. (A-2: requires auth)
   */
  app.get<{ Params: StatusParams }>(
    '/status/:package', { preHandler: [requireAnyAuth] },
    async (request: FastifyRequest<{ Params: StatusParams }>, reply: FastifyReply) => {
      const packageName = request.params.package;

      if (!packageName || packageName.startsWith('@modulewarden/')) {
        return reply.status(404).send({ error: 'Not found' });
      }

      const prisma = (await import('@modulewarden/prisma-client')).getPrisma();
      const versions = await prisma.packageVersion.findMany({
        where: { packageName, registrySource: 'npm' },
        orderBy: { createdAt: 'desc' },
        take: 50,
        select: { version: true, tarballHash: true },
      });

      if (versions.length === 0) {
        return reply.send({
          package: packageName,
          status: 'unknown',
          explanation: `Package ${packageName} has not been imported or reviewed yet.`,
          nextAction: `Run 'modulewarden preflight ${packageName}' to import it.`,
        });
      }

      const statuses = await Promise.all(
        versions.map((v) => getStatusInfo(packageName, v.version))
      );

      return reply.send({
        package: packageName,
        versions: statuses,
      });
    }
  );

  /**
   * GET /status/:package/:version — Get detailed status for a specific version. (A-2: requires auth)
   */
  app.get<{ Params: ExplainParams }>(
    '/status/:package/:version', { preHandler: [requireAnyAuth] },
    async (request: FastifyRequest<{ Params: ExplainParams }>, reply: FastifyReply) => {
      const { package: packageName, version } = request.params;

      if (!packageName || !version) {
        return reply.status(400).send({ error: 'Package name and version required' });
      }

      if (packageName.startsWith('@modulewarden/')) {
        return reply.status(404).send({ error: 'Not found' });
      }

      const info = await getStatusInfo(packageName, version);
      return reply.send(info);
    }
  );

  /**
   * GET /explain/:package/:version — Alias for /status/:package/:version (A-2: requires auth)
   */
  app.get<{ Params: ExplainParams }>(
    '/explain/:package/:version', { preHandler: [requireAnyAuth] },
    async (request: FastifyRequest<{ Params: ExplainParams }>, reply: FastifyReply) => {
      const { package: packageName, version } = request.params;

      if (!packageName || !version) {
        return reply.status(400).send({ error: 'Package name and version required' });
      }

      if (packageName.startsWith('@modulewarden/')) {
        return reply.status(404).send({ error: 'Not found' });
      }

      const info = await getStatusInfo(packageName, version);
      return reply.send(info);
    }
  );
}
