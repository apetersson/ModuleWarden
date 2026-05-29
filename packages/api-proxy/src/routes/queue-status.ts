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

interface PipelineProgress {
  totalSteps: number;
  completedSteps: number;
  pendingSteps: number;
  readySteps: number;
  runningSteps: number;
  failedSteps: number;
  blockedSteps: number;
  cyclesDetected: number;
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
  pipeline?: PipelineProgress;
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
        // No ReviewJob yet — check if there's an active pipeline for this package
        let latestVersion: string | undefined;
        try {
          const upstream = await fetchUpstreamPackument(packageName);
          if (upstream) {
            latestVersion = upstream['dist-tags']?.latest ?? Object.keys(upstream.versions).sort().pop();
          }
        } catch {
          // Upstream fetch is best-effort
        }

        // Look for a pipeline that covers this package
        const existingPipeline = await prisma.auditPipeline.findFirst({
          where: { rootPackageName: packageName, status: 'IN_PROGRESS' as any },
          orderBy: { createdAt: 'desc' },
          select: { id: true, totalSteps: true, createdAt: true, status: true },
        });

        // Also check if this package appears as a step in any pipeline
        const pipelineStep = existingPipeline ? null : await prisma.auditPipelineStep.findFirst({
          where: { packageName, pipeline: { status: 'IN_PROGRESS' as any } },
          orderBy: { createdAt: 'desc' },
          select: {
            id: true,
            linearOrder: true,
            pipeline: { select: { id: true, totalSteps: true, rootPackageName: true, createdAt: true } },
          },
        });

        if (existingPipeline || pipelineStep) {
          const pipeline = existingPipeline ?? pipelineStep!.pipeline;
          const stepCount = await prisma.auditPipelineStep.count({
            where: { pipelineId: pipeline.id },
          });
          const completedSteps = await prisma.auditPipelineStep.count({
            where: { pipelineId: pipeline.id, status: { in: ['ALLOWED', 'BLOCKED', 'QUARANTINED'] as any } },
          });
          const runningSteps = await prisma.auditPipelineStep.count({
            where: { pipelineId: pipeline.id, status: 'RUNNING' as any },
          });

          const response: QueueStatusResponse = {
            package: packageName,
            inQueue: true,
            hasBeenAudited: false,
            status: runningSteps > 0 ? 'in-progress' : 'pending',
            ...(latestVersion !== undefined ? { latestVersion } : {}),
            enqueuedAt: pipeline.createdAt.toISOString(),
            pipeline: {
              totalSteps: pipeline.totalSteps,
              completedSteps,
              pendingSteps: stepCount - completedSteps - runningSteps,
              readySteps: 0,
              runningSteps,
              failedSteps: 0,
              blockedSteps: 0,
              cyclesDetected: 0,
            },
            message: `Package ${packageName} is in the audit pipeline. ` +
              `${completedSteps}/${pipeline.totalSteps} dependency steps completed. ` +
              `Retry the install after all steps complete.`,
          };
          return reply.send(response);
        }

        // No pipeline either — genuinely not queued
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

      // ── Pipeline progress ────────────────────────────────────
      // Look up the most recent AuditPipeline for this package and
      // report step-level progress.
      const pipeline = await prisma.auditPipeline.findFirst({
        where: { rootPackageName: packageName },
        orderBy: { createdAt: 'desc' },
        select: {
          id: true,
          totalSteps: true,
          steps: {
            select: { status: true },
          },
        },
      });

      let pipelineProgress: PipelineProgress | undefined;
      if (pipeline) {
        const stepStatuses = pipeline.steps.map((s: { status: string }) => s.status);
        pipelineProgress = {
          totalSteps: pipeline.totalSteps,
          completedSteps: stepStatuses.filter((s) => s === 'ALLOWED' || s === 'BLOCKED' || s === 'QUARANTINED').length,
          pendingSteps: stepStatuses.filter((s) => s === 'PENDING').length,
          readySteps: stepStatuses.filter((s) => s === 'READY').length,
          runningSteps: stepStatuses.filter((s) => s === 'RUNNING').length,
          failedSteps: stepStatuses.filter((s) => s === 'FAILED').length,
          blockedSteps: stepStatuses.filter((s) => s === 'BLOCKED' || s === 'QUARANTINED').length,
          cyclesDetected: 0, // stored on pipeline metadata — best-effort
        };

        // Update the status message to include pipeline progress
        if (['pending', 'in-progress'].includes(status) && pipelineProgress.totalSteps > 1) {
          const done = pipelineProgress.completedSteps;
          const total = pipelineProgress.totalSteps;
          const running = pipelineProgress.runningSteps;
          if (running > 0) {
            message = `Package ${packageName} is in the audit pipeline. ` +
              `${done}/${total} dependency steps completed, ${running} currently running. ` +
              `Retry the install after all steps complete.`;
          } else {
            message = `Package ${packageName} is in the audit pipeline. ` +
              `${done}/${total} dependency steps completed. ` +
              `Please wait — check back here for progress updates.`;
          }
        }
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
        ...(pipelineProgress ? { pipeline: pipelineProgress } : {}),
        message,
      };

      return reply.send(response);
    }
  );
}
