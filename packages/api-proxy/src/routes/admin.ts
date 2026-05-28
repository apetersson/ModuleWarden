import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { getPrisma, createOverride, listActiveOverrides, deactivateOverride } from '@modulewarden/prisma-client';
import { checkAdmin } from '../middleware/auth.js';

interface OverrideBody {
  packageName: string;
  version: string;
  tarballHash?: string;
  targetVerdict: 'ALLOW' | 'BLOCK' | 'QUARANTINE';
  scope?: 'SPECIFIC_VERSION' | 'PACKAGE' | 'PROJECT' | 'GLOBAL';
  reason: string;
  supersedesDecisionId?: string;
}

/**
 * Admin override endpoints.
 * Only accessible with security-admin tokens.
 */
export async function registerAdminRoutes(app: FastifyInstance): Promise<void> {
  /**
   * POST /admin/override — Create a security-admin override.
   */
  app.post<{ Body: OverrideBody }>(
    '/admin/override',
    async (request: FastifyRequest<{ Body: OverrideBody }>, reply: FastifyReply) => {
      if (!checkAdmin(request, reply)) return;

      const { packageName, version, tarballHash, targetVerdict, reason, supersedesDecisionId } = request.body;
      const scope = request.body.scope ?? 'SPECIFIC_VERSION';

      if (!packageName || !version || !targetVerdict || !reason) {
        return reply.status(400).send({
          error: 'Missing required fields',
          required: ['packageName', 'version', 'targetVerdict', 'reason'],
        });
      }

      if (!['ALLOW', 'BLOCK', 'QUARANTINE'].includes(targetVerdict)) {
        return reply.status(400).send({ error: 'targetVerdict must be ALLOW, BLOCK, or QUARANTINE' });
      }

      // Input validation for scope, packageName, version, reason (QUAL-06)
      if (scope && !['SPECIFIC_VERSION', 'PACKAGE', 'PROJECT', 'GLOBAL'].includes(scope)) {
        return reply.status(400).send({ error: 'scope must be SPECIFIC_VERSION, PACKAGE, PROJECT, or GLOBAL' });
      }

      if (!/^@?[a-z0-9][a-z0-9._-]*$/.test(packageName)) {
        return reply.status(400).send({ error: 'Invalid package name format. Must be a valid npm package name.' });
      }

      if (!/^\d+\.\d+\.\d+/.test(version)) {
        return reply.status(400).send({ error: 'Invalid version format. Must be a valid semver (e.g. 1.0.0).' });
      }

      if (reason.length < 10) {
        return reply.status(400).send({ error: 'Reason must be at least 10 characters.' });
      }

      if (reason.length > 2000) {
        return reply.status(400).send({ error: 'Reason must not exceed 2000 characters.' });
      }

      const prisma = getPrisma();

      // Find the specific package version
      let pv = tarballHash
        ? await prisma.packageVersion.findUnique({
            where: {
              packageName_version_registrySource_tarballHash: {
                packageName,
                version,
                registrySource: 'npm',
                tarballHash,
              },
            },
          })
        : await prisma.packageVersion.findFirst({
            where: { packageName, version, registrySource: 'npm' },
            orderBy: { createdAt: 'desc' },
          });

      // Create the package version record if it doesn't exist
      // L-3: Reject if no tarballHash provided and no existing record found.
      // Synthetic hashes create orphan records that never match real tarballs.
      if (!pv) {
        if (!tarballHash) {
          return reply.status(400).send({
            error: 'tarballHash is required',
            reason: 'Package version not found and no tarball hash was provided. ' +
              'Specify the tarballHash to create an override for this version.',
          });
        }
        pv = await prisma.packageVersion.create({
          data: {
            packageName,
            version,
            registrySource: 'npm',
            tarballHash,
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

      // Extract token identity from the auth header for audit trail (O-3)
      const authHeader = request.headers.authorization;
      const tokenPrefix = authHeader?.startsWith('Bearer ')
        ? authHeader.slice(7, 15) + '…'
        : 'unknown';

      // Create the override record
      const override = await createOverride({
        decisionId: decision.id,
        adminIdentity: tokenPrefix,
        scope,
        targetVerdict,
        reason,
        ...((supersedesDecisionId ?? latestDecision?.id)
          ? { supersedesDecisionId: supersedesDecisionId ?? latestDecision!.id }
          : {}),
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
        const { importLockfile } = await import('../services/lockfile-import.js');
        const result = await importLockfile(filename, content);
        return reply.status(201).send({
          packageCount: result.newVersions,
          subscriptionCount: result.newSubscriptions,
          reviewCount: result.enqueuedReviews,
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
