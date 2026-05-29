/**
 * Model Profile Repository
 *
 * Manages model endpoint configurations for PI audit runs.
 * Supports first-pass (broader/cheaper) and escalation (precise/capable) models.
 * Records provider, trust boundary, and logging posture for auditability.
 */
import { getPrisma } from '../index.js';
import type { ModelProfile } from '@prisma/client';
import { createHash } from 'node:crypto';

export interface CreateModelProfileInput {
  name: string;
  baseUrl: string;
  modelName: string;
  apiKeyHash?: string;
  temperature?: number;
  maxTokens?: number;
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
 * Get the most recently created model profile.
 * Throws if no profile exists — the system must have at least one profile configured.
 */
export async function getActiveModelProfile(): Promise<ModelProfile> {
  const prisma = getPrisma();
  const profile = await prisma.modelProfile.findFirst({
    orderBy: { createdAt: 'desc' },
  });
  if (!profile && process.env.MW_MODEL_ENDPOINT_BASE_URL && process.env.MW_MODEL_ENDPOINT_MODEL) {
    const apiKeyHash = process.env.MW_MODEL_ENDPOINT_API_KEY
      ? createHash('sha256').update(process.env.MW_MODEL_ENDPOINT_API_KEY).digest('hex')
      : undefined;
    return prisma.modelProfile.upsert({
      where: { name: 'env-default' },
      update: {
        baseUrl: process.env.MW_MODEL_ENDPOINT_BASE_URL,
        modelName: process.env.MW_MODEL_ENDPOINT_MODEL,
        ...(apiKeyHash ? { apiKeyHash } : {}),
      },
      create: {
        name: 'env-default',
        baseUrl: process.env.MW_MODEL_ENDPOINT_BASE_URL,
        modelName: process.env.MW_MODEL_ENDPOINT_MODEL,
        ...(apiKeyHash ? { apiKeyHash } : {}),
      },
    });
  }
  if (!profile) {
    throw new Error(
      'No model profile found. At least one model profile must be configured ' +
      'before audits can run. Use the admin API, seed script, or set ' +
      'MW_MODEL_ENDPOINT_BASE_URL and MW_MODEL_ENDPOINT_MODEL for local env-backed configuration.'
    );
  }
  return profile;
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
