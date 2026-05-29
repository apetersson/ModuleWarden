/**
 * Public queue-status endpoint.
 * GET /queue/:package — Returns audit queue progress for a package.
 * No authentication required. Safe for public consumption — returns only
 * package name, current status, and a retry hint.
 */

import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { getPrisma } from '@modulewarden/prisma-client';
import { fetchUpstreamPackument } from '@modulewarden/shared/services/upstream';

interface QueueParams {
  package: string;
}

interface QueueStatusResponse {
  package: string;
  inQueue: boolean;
  hasBeenAudited: boolean;
  status: 'unknown' | 'pending' | 'in-progress' | 'completed' | 'failed';
  latestVersion?: string;
  verdict?: string | null;
  enqueuedAt?: string | null;
  completedAt?: string | null;
  message: string;
}

/**
 * Register the public queue-status route.
 */
export async function registerQueueStatusRoute(app: FastifyInstance): Promise<void> {
  app.get<{ Params: QueueParams }>(
    '/queue/:package',
    async (request: FastifyRequest<{ Params: QueueParams }>, reply: FastifyReply) => {
      const packageName = request.params.package;

      // Skip internal packages
      if (packageName.startsWith('@modulewarden/')) {
        return reply.status(404).send({ error: 'Not found' });
      }

      const prisma = getPrisma();

      // Look up the most recent package version entry
      const pv = await prisma.packageVersion.findFirst({
        where: { packageName, registrySource: 'npm' },
        orderBy: { createdAt: 'desc' },
        select: {
          id: true,
          version: true,
          createdAt: true,
          reviewJobs: {
            orderBy: { createdAt: 'desc' },
            take: 1,
            select: {
              id: true,
              status: true,
              createdAt: true,
              auditRuns: {
                orderBy: { createdAt: 'desc' },
                take: 1,
                select: {
                  id: true,
                  status: true,
                  completedAt: true,
                  errorMessage: true,
                },
              },
              decisions: {
                orderBy: { createdAt: 'desc' },
                take: 1,
                select: {
                  id: true,
                  verdict: true,
                  createdAt: true,
                },
              },
            },
          },
        },
      });

      if (!pv || pv.reviewJobs.length === 0) {
        // Package has never been imported — tell user it's pending
        // Try to fetch upstream to get latest version info
        let latestVersion: string | undefined;
        try {
          const upstream = await fetchUpstreamPackument(packageName);
          if (upstream) {
            latestVersion = upstream['dist-tags']?.latest ?? Object.keys(upstream.versions).sort().pop();
          }
        } catch {
          // Upstream fetch is best-effort for the queue-status page
        }

        const response: QueueStatusResponse = {
          package: packageName,
          inQueue: false,
          hasBeenAudited: false,
          status: 'pending',
          ...(latestVersion !== undefined ? { latestVersion } : {}),
          message: `Package ${packageName} has not been queued for audit yet. ` +
            `Try installing it with your package manager to trigger an automatic audit. ` +
            `Once enqueued, check back here for progress.`,
        };
        return reply.send(response);
      }

      const reviewJob = pv.reviewJobs[0]!;
      const auditRun = reviewJob.auditRuns[0] ?? null;
      const decision = reviewJob.decisions[0] ?? null;

      let status: QueueStatusResponse['status'];
      let message: string;

      switch (reviewJob.status) {
        case 'QUEUED':
        case 'PENDING':
          status = 'pending';
          message = `Package ${packageName}@${pv.version} is queued for audit. ` +
            `Please wait — check back here for progress updates. ` +
            `Retry the install once the audit completes.`;
          break;
        case 'RUNNING':
          status = 'in-progress';
          message = `Package ${packageName}@${pv.version} is currently being audited. ` +
            `This usually takes a few minutes. ` +
            `Check back here for the result and retry once complete.`;
          break;
        case 'COMPLETED':
          if (decision) {
            status = 'completed';
            if (decision.verdict === 'ALLOW') {
              message = `Package ${packageName}@${pv.version} has been reviewed and ALLOWED. ` +
                `You can now install it: pnpm add ${packageName}`;
            } else if (decision.verdict === 'BLOCK') {
              message = `Package ${packageName}@${pv.version} has been BLOCKED by security policy. ` +
                `It cannot be installed. Check with your administrator for details.`;
            } else if (decision.verdict === 'QUARANTINE') {
              message = `Package ${packageName}@${pv.version} is QUARANTINED — ` +
                `human review is required before installation.`;
            } else {
              message = `Package ${packageName}@${pv.version} has been reviewed. ` +
                `Retry the install to see if it resolves.`;
            }
          } else {
            status = 'completed';
            message = `Package ${packageName}@${pv.version} has been audited but no decision was recorded. ` +
              `Contact your administrator for details.`;
          }
          break;
        case 'FAILED':
        case 'DEAD_LETTER':
          status = 'failed';
          message = `Package ${packageName}@${pv.version} audit failed. ` +
            (auditRun?.errorMessage ? `Reason: ${auditRun.errorMessage}. ` : '') +
            `Contact your administrator or retry the install to trigger a re-audit.`;
          break;
        case 'CANCELLED':
          status = 'failed';
          message = `Package ${packageName}@${pv.version} audit was cancelled. ` +
            `Retry the install to trigger a fresh audit.`;
          break;
        default:
          status = 'pending';
          message = `Package ${packageName}@${pv.version} status is unknown. ` +
            `Retry the install to trigger an audit.`;
      }

      const response: QueueStatusResponse = {
        package: packageName,
        inQueue: ['QUEUED', 'PENDING', 'RUNNING'].includes(reviewJob.status),
        hasBeenAudited: reviewJob.status === 'COMPLETED',
        status,
        latestVersion: pv.version,
        verdict: decision?.verdict ?? null,
        enqueuedAt: reviewJob.createdAt.toISOString(),
        completedAt: auditRun?.completedAt?.toISOString() ?? null,
        message,
      };

      return reply.send(response);
    }
  );
}
