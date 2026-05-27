import { getPrisma } from '../index.js';
import type { AuditRun } from '@prisma/client';

export interface AuditRunInput {
  reviewJobId: string;
  containerId?: string;
  containerName?: string;
  status?: 'PENDING' | 'RUNNING' | 'COMPLETED' | 'TIMED_OUT' | 'CRASHED' | 'CANCELLED';
  piSessionId?: string;
  piRunId?: string;
  rpcTokenHash?: string;
}

export async function createAuditRun(input: AuditRunInput): Promise<AuditRun> {
  return getPrisma().auditRun.create({
    data: {
      reviewJobId: input.reviewJobId,
      containerId: input.containerId,
      containerName: input.containerName,
      status: input.status ?? 'PENDING',
      piSessionId: input.piSessionId,
      piRunId: input.piRunId,
      rpcTokenHash: input.rpcTokenHash,
    },
  });
}

export async function getAuditRun(id: string): Promise<AuditRun | null> {
  return getPrisma().auditRun.findUnique({ where: { id } });
}

export async function updateAuditRunStatus(
  id: string,
  status: 'PENDING' | 'RUNNING' | 'COMPLETED' | 'TIMED_OUT' | 'CRASHED' | 'CANCELLED',
  fields?: {
    containerId?: string;
    containerName?: string;
    startedAt?: Date;
    completedAt?: Date;
    timeoutAt?: Date;
    errorMessage?: string;
    piSessionId?: string;
    piRunId?: string;
  }
): Promise<AuditRun> {
  return getPrisma().auditRun.update({
    where: { id },
    data: { ...fields, status },
  });
}

export async function listAuditRunsByReviewJob(reviewJobId: string): Promise<AuditRun[]> {
  return getPrisma().auditRun.findMany({
    where: { reviewJobId },
    orderBy: { createdAt: 'desc' },
  });
}
