import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { getPrisma, createOverride, listActiveOverrides, deactivateOverride } from '@modulewarden/prisma-client';
import { parseLockfile } from '@modulewarden/shared/services/lockfile';

interface OverrideBody {
  packageName: string;
  version: string;
  tarballHash?: string;
  targetVerdict: 'ALLOW' | 'BLOCK' | 'QUARANTINE';
  scope: 'SPECIFIC_VERSION' | 'PACKAGE' | 'PROJECT' | 'GLOBAL';
  reason: string;
  supersedesDecisionId?: string;
}

/**
 * Admin override endpoints.
 * Only accessible with security-admin tokens.
 */
export async function registerAdminRoutes(app: FastifyInstance): Promise<void> {
  // Auth middleware helper
  function checkAdmin(request: FastifyRequest, reply: FastifyReply): boolean {
    const authHeader = request.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      reply.status(401).send({ error: 'Authentication required' });
      return false;
    }

    const token = authHeader.slice(7);
    // H-2: Use MW_AUTH_ADMIN_TOKENS (matching config) and fail closed
    const adminEnv = process.env.MW_AUTH_ADMIN_TOKENS;
    if (!adminEnv) {
      reply.status(503).send({ error: 'Admin auth not configured: set MW_AUTH_ADMIN_TOKENS' });
      return false;
    }
    const adminTokens = adminEnv.split(',');

    if (!adminTokens.includes(token)) {
      reply.status(403).send({ error: 'Forbidden: admin token required' });
      return false;
    }

    return true;
  }

  /**
   * POST /admin/override — Create a security-admin override.
   */
  app.post<{ Body: OverrideBody }>(
    '/admin/override',
    async (request: FastifyRequest<{ Body: OverrideBody }>, reply: FastifyReply) => {
      if (!checkAdmin(request, reply)) return;

      const { packageName, version, tarballHash, targetVerdict, scope, reason, supersedesDecisionId } = request.body;

      if (!packageName || !version || !targetVerdict || !reason) {
        return reply.status(400).send({
          error: 'Missing required fields',
          required: ['packageName', 'version', 'targetVerdict', 'reason'],
        });
      }

      if (!['ALLOW', 'BLOCK', 'QUARANTINE'].includes(targetVerdict)) {
        return reply.status(400).send({ error: 'targetVerdict must be ALLOW, BLOCK, or QUARANTINE' });
      }

      const prisma = getPrisma();

      // Find the specific package version
      const where = tarballHash
        ? {
            packageName_version_registrySource_tarballHash: {
              packageName,
              version,
              registrySource: 'npm',
              tarballHash,
            } as const,
          }
        : {
            packageName_version_registrySource_tarballHash: {
              packageName,
              version,
              registrySource: 'npm',
              tarballHash: '',
            } as const,
          };

      let pv = tarballHash
        ? await prisma.packageVersion.findUnique({ where: where as any })
        : await prisma.packageVersion.findFirst({
            where: { packageName, version, registrySource: 'npm' },
            orderBy: { createdAt: 'desc' },
          });

      if (!pv) {
        // Create the package version record if it doesn't exist
        pv = await prisma.packageVersion.create({
          data: {
            packageName,
            version,
            registrySource: 'npm',
            tarballHash: tarballHash ?? `override:${packageName}:${version}`,
          },
        });
      }

      // Find the latest decision for this version
      const latestDecision = await prisma.decision.findFirst({
        where: { packageVersionId: pv.id },
        orderBy: { createdAt: 'desc' },
      });

      // Ensure a review job exists for this package version (M-4)
      let reviewJobId = latestDecision?.reviewJobId;
      if (!reviewJobId) {
        // Create a sentinel review job for admin-created decisions
        const sentinelJob = await prisma.reviewJob.create({
          data: {
            packageVersionId: pv.id,
            auditContext: `admin-override:${packageName}@${version}`,
            trigger: 'MANUAL',
            status: 'COMPLETED',
            idempotencyKey: `admin-override:${pv.id}`,
          },
        });
        reviewJobId = sentinelJob.id;
      }

      const decision = await prisma.decision.create({
        data: {
          reviewJobId,
          packageVersionId: pv.id,
          verdict: targetVerdict,
          reasonSummary: reason,
          actorType: 'ADMIN',
        },
      });

      // Create the override record
      const override = await createOverride({
        decisionId: decision.id,
        adminIdentity: 'admin', // Extracted from token context in production
        scope,
        targetVerdict,
        reason,
        supersedesDecisionId: supersedesDecisionId ?? latestDecision?.id,
      });

      return reply.status(201).send({
        id: override.id,
        decisionId: decision.id,
        packageName,
        version,
        targetVerdict,
        scope,
        reason,
        createdAt: override.createdAt,
      });
    }
  );

  /**
   * GET /admin/overrides — List all active overrides.
   */
  app.get(
    '/admin/overrides',
    async (request: FastifyRequest, reply: FastifyReply) => {
      if (!checkAdmin(request, reply)) return;

      const overrides = await listActiveOverrides();
      return reply.send(overrides);
    }
  );

  /**
   * DELETE /admin/override/:id — Deactivate an override.
   */
  app.delete<{ Params: { id: string } }>(
    '/admin/override/:id',
    async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
      if (!checkAdmin(request, reply)) return;

      const { id } = request.params;
      await deactivateOverride(id);
      return reply.send({ status: 'deactivated', id });
    }
  );

  /**
   * POST /admin/import-lockfile — Import a lockfile and enqueue reviews.
   */
  app.post<{ Body: { filename: string; format: string; content: string } }>(
    '/admin/import-lockfile',
    async (request: FastifyRequest<{ Body: { filename: string; format: string; content: string } }>, reply: FastifyReply) => {
      if (!checkAdmin(request, reply)) return;

      const { filename, content } = request.body;
      if (!filename || !content) {
        return reply.status(400).send({ error: 'Missing filename or content' });
      }

      try {
        const { importLockfileWithSubscriptions } = await import('../services/lockfile-import.js');
        const result = await importLockfileWithSubscriptions(filename, content);
        return reply.status(201).send({
          packageCount: result.packageCount,
          subscriptionCount: result.subscriptionCount,
          reviewCount: result.reviewCount,
        });
      } catch (err) {
        return reply.status(500).send({
          error: 'Lockfile import failed',
          detail: err instanceof Error ? err.message : String(err),
        });
      }
    }
  );
}
