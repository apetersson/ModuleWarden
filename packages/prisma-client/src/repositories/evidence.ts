import { getPrisma } from '../index.js';
import type { EvidenceArtifact } from '@prisma/client';
import type { Prisma } from '@prisma/client';

export interface EvidenceArtifactInput {
  auditRunId: string;
  artifactType: string;
  name: string;
  content: Prisma.InputJsonValue;
  contentHash: string;
  filePath?: string;
  sizeBytes?: number;
  status?: 'ACTIVE' | 'SUPERSEDED' | 'REDACTED';
  supersedesEvidenceArtifactId?: string;
}

export async function createEvidenceArtifact(input: EvidenceArtifactInput): Promise<EvidenceArtifact> {
  return getPrisma().evidenceArtifact.create({
    data: {
      auditRunId: input.auditRunId,
      artifactType: input.artifactType as any,
      name: input.name,
      content: input.content,
      contentHash: input.contentHash,
      status: (input.status ?? 'ACTIVE') as any,
      ...(input.filePath !== undefined ? { filePath: input.filePath } : {}),
      ...(input.sizeBytes !== undefined ? { sizeBytes: input.sizeBytes } : {}),
      ...(input.supersedesEvidenceArtifactId !== undefined
        ? { supersedesEvidenceArtifactId: input.supersedesEvidenceArtifactId }
        : {}),
    },
  });
}

export async function getEvidenceArtifact(id: string): Promise<EvidenceArtifact | null> {
  return getPrisma().evidenceArtifact.findUnique({ where: { id } });
}

export async function listEvidenceByAuditRun(auditRunId: string): Promise<EvidenceArtifact[]> {
  return getPrisma().evidenceArtifact.findMany({
    where: { auditRunId },
    orderBy: { createdAt: 'asc' },
  });
}

export async function linkEvidenceToDecision(
  evidenceArtifactId: string,
  decisionId: string
): Promise<void> {
  await getPrisma().decision.update({
    where: { id: decisionId },
    data: {
      evidenceArtifacts: {
        connect: { id: evidenceArtifactId },
      },
    },
  });
}

export async function supersedeEvidenceArtifact(
  existingEvidenceArtifactId: string,
  replacement: Omit<EvidenceArtifactInput, 'supersedesEvidenceArtifactId'>
): Promise<EvidenceArtifact> {
  const prisma = getPrisma();
  // Mark the old artifact as superseded
  await prisma.evidenceArtifact.update({
    where: { id: existingEvidenceArtifactId },
    data: { status: 'SUPERSEDED' },
  });
  // Create the new artifact as active
  const next = await createEvidenceArtifact({
    ...replacement,
    supersedesEvidenceArtifactId: existingEvidenceArtifactId,
    status: 'ACTIVE',
  });

  return next;
}
