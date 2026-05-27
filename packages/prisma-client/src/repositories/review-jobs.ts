import { getPrisma } from '../index.js';
import type { ReviewJob } from '@prisma/client';

export interface ReviewJobInput {
  packageVersionId: string;
  auditContext: string;
  trigger: 'PREFLIGHT' | 'SUBSCRIPTION' | 'MANUAL' | 'RE_AUDIT';
  idempotencyKey: string;
  pgBossJobId?: string;
}

export async function createReviewJob(input: ReviewJobInput): Promise<ReviewJob> {
  return getPrisma().reviewJob.create({ data: input });
}

export async function upsertReviewJob(input: ReviewJobInput): Promise<ReviewJob> {
  return getPrisma().reviewJob.upsert({
    where: {
      packageVersionId_auditContext: {
        packageVersionId: input.packageVersionId,
        auditContext: input.auditContext,
      },
    },
    create: input,
    update: { status: 'PENDING', pgBossJobId: input.pgBossJobId },
  });
}

export async function getReviewJob(id: string): Promise<ReviewJob | null> {
  return getPrisma().reviewJob.findUnique({ where: { id } });
}

export async function getReviewJobByIdempotencyKey(key: string): Promise<ReviewJob | null> {
  return getPrisma().reviewJob.findUnique({ where: { idempotencyKey: key } });
}

export async function listReviewJobsByStatus(status: string): Promise<ReviewJob[]> {
  return getPrisma().reviewJob.findMany({
    where: { status: status as any },
    orderBy: { createdAt: 'asc' },
  });
}

export async function updateReviewJobStatus(
  id: string,
  status: 'PENDING' | 'QUEUED' | 'RUNNING' | 'COMPLETED' | 'FAILED' | 'CANCELLED' | 'DEAD_LETTER',
  pgBossJobId?: string
): Promise<ReviewJob> {
  return getPrisma().reviewJob.update({
    where: { id },
    data: { status, ...(pgBossJobId !== undefined ? { pgBossJobId } : {}) },
  });
}

export async function deduplicateReviewJob(
  packageVersionId: string,
  auditContext: string
): Promise<ReviewJob | null> {
  // If a review job already exists for this package version + context, return it
  return getPrisma().reviewJob.findUnique({
    where: {
      packageVersionId_auditContext: {
        packageVersionId,
        auditContext,
      },
    },
  });
}
