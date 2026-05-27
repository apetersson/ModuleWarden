import { getPrisma } from '../index.js';
import type { ReAuditCampaign } from '@prisma/client';

export interface ReAuditCampaignInput {
  projectId: string;
  reason: string;
  triggerType: 'PROMPT_CHANGE' | 'MODEL_CHANGE' | 'PATTERN_CHANGE' | 'ADMIN_REQUEST' | 'SCHEDULED';
  promptPackId?: string;
  modelProfileId?: string;
  patternDefinition?: string;
}

export async function createReAuditCampaign(input: ReAuditCampaignInput): Promise<ReAuditCampaign> {
  return getPrisma().reAuditCampaign.create({ data: input });
}

export async function getReAuditCampaign(id: string): Promise<ReAuditCampaign | null> {
  return getPrisma().reAuditCampaign.findUnique({ where: { id } });
}

export async function listCampaignsByProject(projectId: string): Promise<ReAuditCampaign[]> {
  return getPrisma().reAuditCampaign.findMany({
    where: { projectId },
    orderBy: { createdAt: 'desc' },
  });
}

export async function updateCampaignStatus(
  id: string,
  status: 'PENDING' | 'RUNNING' | 'COMPLETED' | 'CANCELLED'
): Promise<ReAuditCampaign> {
  return getPrisma().reAuditCampaign.update({
    where: { id },
    data: {
      status,
      ...(status === 'COMPLETED' || status === 'CANCELLED'
        ? { completedAt: new Date() }
        : {}),
    },
  });
}
