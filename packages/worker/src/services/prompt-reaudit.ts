/**
 * Prompt-change re-audit trigger service.
 *
 * When prompt packs, model profiles, or pattern libraries change,
 * this service schedules re-audits for currently allowed versions
 * in the active used graph, including versions with admin overrides.
 */

import { getPrisma, createReAuditCampaign } from '@modulewarden/prisma-client';
import type { JobQueue } from '../jobs/queue.js';
import type { PromptCategory } from '@modulewarden/prisma-client';

/**
 * Result of a prompt-change re-audit trigger.
 */
export interface PromptChangeReAuditResult {
  campaignId: string;
  projectId: string;
  affectedVersionCount: number;
  changedPromptPacks: string[];
}

/**
 * Check if any prompt packs have changed since the last decision was made.
 * Returns the names of changed packs.
 */
async function detectPromptPackChanges(): Promise<string[]> {
  const prisma = getPrisma();

  // Find the most recent decision that has a prompt version recorded
  const recentDecision = await prisma.decision.findFirst({
    where: { promptVersion: { not: null } },
    orderBy: { createdAt: 'desc' },
    select: { promptVersion: true },
  });

  if (!recentDecision?.promptVersion) return [];

  const changed: string[] = [];
  const categories: PromptCategory[] = ['CORE', 'CUSTOM_ADMIN', 'ESCALATION', 'PATTERN_CHECK'];

  for (const category of categories) {
    // Get the latest pack for this category
    const latestPackage = await prisma.promptPack.findFirst({
      where: { category },
      orderBy: { version: 'desc' },
      select: { name: true, version: true },
    });

    if (latestPackage && latestPackage.version !== recentDecision.promptVersion) {
      changed.push(`${latestPackage.name}@${latestPackage.version}`);
    }
  }

  return changed;
}

/**
 * Trigger a re-audit campaign for all allowed package versions
 * in all active projects. Called when prompt packs change.
 *
 * @param queue - Job queue to enqueue re-audit jobs
 * @param changedPackNames - Optional list of changed prompt pack names
 * @returns Results for each affected project
 */
export async function triggerPromptChangeReAudit(
  queue: JobQueue,
  changedPackNames?: string[]
): Promise<PromptChangeReAuditResult[]> {
  const prisma = getPrisma();
  const results: PromptChangeReAuditResult[] = [];

  // Detect what changed if not specified
  const changedPacks = changedPackNames ?? await detectPromptPackChanges();
  if (changedPacks.length === 0) return [];

  // Find all active projects with registry enabled
  const projects = await prisma.project.findMany({
    where: {
      registryEnabled: true,
      graphState: 'READY',
      importedPackageVersions: { some: {} },
    },
    select: { id: true, name: true },
  });

  for (const project of projects) {
    // Create a re-audit campaign for this project
    const campaign = await createReAuditCampaign({
      projectId: project.id,
      reason: `Prompt change: ${changedPacks.join(', ')}`,
      triggerType: 'PROMPT_CHANGE',
    });

    // Enqueue the campaign as a pg-boss job
    try {
      await queue.send('re-audit-campaign', {
        campaignId: campaign.id,
        reason: campaign.reason,
      });
    } catch {
      // Campaign created but job enqueue failed — will be picked up by scheduled sweep
    }

    results.push({
      campaignId: campaign.id,
      projectId: project.id,
      affectedVersionCount: 0, // Populated by campaign handler
      changedPromptPacks: changedPacks,
    });
  }

  return results;
}

/**
 * Check if a specific prompt pack change should trigger re-audits
 * and create campaigns if so.
 *
 * @param queue - Job queue
 * @param promptName - Name of the changed prompt pack
 * @param newVersion - New version string
 */
export async function onPromptPackCreated(
  queue: JobQueue,
  promptName: string,
  newVersion: string
): Promise<void> {
  // Trigger re-audit for all active projects
  const results = await triggerPromptChangeReAudit(queue, [`${promptName}@${newVersion}`]);

  if (results.length > 0) {
    console.log(
      `[prompt-reaudit] Prompt pack ${promptName}@${newVersion} created: ` +
      `triggered ${results.length} re-audit campaigns`
    );
  }
}
