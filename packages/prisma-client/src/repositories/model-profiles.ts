/**
 * Model Profile Repository
 *
 * Manages model endpoint configurations for PI audit runs.
 * Supports first-pass (broader/cheaper) and escalation (precise/capable) models.
 * Records provider, trust boundary, and logging posture for auditability.
 */
import { getPrisma } from '../index.js';
import type { ModelProfile } from '@prisma/client';

export interface CreateModelProfileInput {
  name: string;
  baseUrl: string;
  modelName: string;
  apiKeyHash?: string;
  temperature?: number;
  maxTokens?: number;
  isFallback: boolean;
}

/**
 * Create a new model profile.
 */
export async function createModelProfile(input: CreateModelProfileInput): Promise<ModelProfile> {
  const prisma = getPrisma();
  return prisma.modelProfile.create({ data: input });
}

/**
 * Get a model profile by name.
 */
export async function getModelProfile(name: string): Promise<ModelProfile | null> {
  const prisma = getPrisma();
  return prisma.modelProfile.findUnique({ where: { name } });
}

/**
 * Get all model profiles.
 */
export async function listModelProfiles(): Promise<ModelProfile[]> {
  const prisma = getPrisma();
  return prisma.modelProfile.findMany({ orderBy: { name: 'asc' } });
}

/**
 * Get the active model profile (non-fallback), or the fallback if none primary.
 */
export async function getActiveModelProfile(): Promise<ModelProfile | null> {
  const prisma = getPrisma();
  const primary = await prisma.modelProfile.findFirst({
    where: { isFallback: false },
    orderBy: { createdAt: 'desc' },
  });
  if (primary) return primary;
  return prisma.modelProfile.findFirst({ where: { isFallback: true } });
}

/**
 * Get the escalation model profile (if configured separately from first-pass).
 * Returns null if no separate escalation profile exists.
 */
export async function getEscalationModelProfile(): Promise<ModelProfile | null> {
  const prisma = getPrisma();
  return prisma.modelProfile.findFirst({
    where: { name: { contains: 'escalation' } },
    orderBy: { createdAt: 'desc' },
  });
}

/**
 * Delete a model profile.
 */
export async function deleteModelProfile(name: string): Promise<void> {
  const prisma = getPrisma();
  await prisma.modelProfile.delete({ where: { name } });
}
