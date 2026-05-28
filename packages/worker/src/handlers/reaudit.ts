import {
  CampaignStatus,
  createReAuditCampaign,
  getPrisma,
  getReAuditCampaign,
  listAllowedVersionsForReAudit,
  updateCampaignStatus,
} from '@modulewarden/prisma-client';
import { buildIdempotencyKey } from '@modulewarden/shared/constants';
import type { JobQueue } from '../jobs/queue.js';

/**
 * Register the re-audit campaign handler.
 *
 * For active projects, this handler replays package-review jobs for all
 * versions that currently carry an ALLOW decision in that project's imported
 * graph. Each replay is created with a deterministic idempotency key so
 * repeated campaign triggers collapse safely.
 */
export async function registerReAuditCampaignHandler(queue: JobQueue): Promise<void> {
  await queue.work('re-audit-campaign', async (job) => {
    const reason = (job.data.reason?.trim() || 'Scheduled re-audit sweep');
    const { campaignId } = job.data;
    const prisma = getPrisma();

    const loadCampaign = async (id: string) => {
      const campaign = await getReAuditCampaign(id);

      if (!campaign) {
        throw new Error(`Re-audit campaign ${id} not found`);
      }

      return {
        id: campaign.id,
        projectId: campaign.projectId,
        reason: campaign.reason,
        status: campaign.status,
      };
    };

    const createCampaignForProject = async (projectId: string) => {
      const created = await createReAuditCampaign({
        projectId,
        reason,
        triggerType: 'SCHEDULED',
      });

      return { id: created.id, projectId: created.projectId, reason: created.reason, status: created.status };
    };

    const campaigns = campaignId
      ? [await loadCampaign(campaignId)]
      : await prisma.project.findMany({
          where: {
            registryEnabled: true,
            graphState: 'READY',
            importedPackageVersions: {
              some: {},
            },
          },
          select: { id: true },
        }).then((projects) => Promise.all(projects.map(({ id }) => createCampaignForProject(id))));

    let totalReevaluated = 0;

    for (const campaign of campaigns) {
      if (campaign.status === CampaignStatus.CANCELLED) {
        continue;
      }

      await updateCampaignStatus(campaign.id, CampaignStatus.RUNNING);

      const allowedVersions = await listAllowedVersionsForReAudit(campaign.projectId);
      let reevaluated = 0;

      for (const allowed of allowedVersions) {
        const packageVersion = await prisma.packageVersion.findUnique({
          where: { id: allowed.packageVersionId },
          select: {
            packageName: true,
            version: true,
            tarballHash: true,
          },
        });

        if (!packageVersion) {
          continue;
        }

        const auditContext = `re-audit:${campaign.id}:${allowed.decisionId}`;
        const idempotencyKey = buildIdempotencyKey(
          'package-review',
          packageVersion.packageName,
          packageVersion.version,
          packageVersion.tarballHash,
          auditContext
        );

        await prisma.reviewJob.upsert({
          where: { idempotencyKey },
          create: {
            packageVersionId: allowed.packageVersionId,
            auditContext,
            trigger: 'RE_AUDIT',
            status: 'QUEUED',
            idempotencyKey,
          },
          update: {
            status: 'QUEUED',
            trigger: 'RE_AUDIT',
          },
        });

        const pgBossJobId = await queue.enqueuePackageReview(
          packageVersion.packageName,
          packageVersion.version,
          packageVersion.tarballHash,
          auditContext
        );

        if (pgBossJobId) {
          await prisma.reviewJob.update({
            where: { idempotencyKey },
            data: { pgBossJobId },
          }).catch(() => {
            // best-effort
          });
        }

        await prisma.decision.update({
          where: { id: allowed.decisionId },
          data: {
            reAuditCampaigns: {
              connect: { id: campaign.id },
            },
          },
        }).catch(() => {
          // best-effort
        });

        reevaluated += 1;
        totalReevaluated += 1;
      }

      await updateCampaignStatus(campaign.id, CampaignStatus.COMPLETED);
      await prisma.reAuditCampaign.update({
        where: { id: campaign.id },
        data: {
          reason: `${reason}: ${reevaluated} package version(s) re-enqueued`,
        },
      });

      console.log(`[reaudit] Campaign ${campaign.id} completed with ${reevaluated} re-enqueued jobs`);
    }

    console.log(`[reaudit] Completed re-audit campaigns, total jobs enqueued: ${totalReevaluated}`);
  });
}
