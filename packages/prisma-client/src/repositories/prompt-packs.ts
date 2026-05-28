/**
 * Prompt Pack Repository
 *
 * Manages hidden core prompt packs and visible custom prompts.
 * Core prompts are never exposed through user-facing endpoints.
 */
import { getPrisma } from '../index.js';
import type { PromptPack, PromptCategory } from '@prisma/client';

export interface CreatePromptPackInput {
  name: string;
  version: string;
  category: 'CORE' | 'CUSTOM_ADMIN' | 'ESCALATION' | 'PATTERN_CHECK';
  content: string;
  hash: string;
}

/**
 * Create a new prompt pack version.
 */
export async function createPromptPack(input: CreatePromptPackInput): Promise<PromptPack> {
  const prisma = getPrisma();
  return prisma.promptPack.create({ data: input });
}

/**
 * Get the latest version of a prompt pack by name and category.
 */
export async function getLatestPromptPack(
  name: string,
  category: PromptCategory
): Promise<PromptPack | null> {
  const prisma = getPrisma();
  return prisma.promptPack.findFirst({
    where: { name, category },
    orderBy: { version: 'desc' },
  });
}

/**
 * Get all current prompt packs grouped by category.
 */
export async function getCurrentPromptPacks(): Promise<{
  core: PromptPack[];
  custom: PromptPack[];
  escalation: PromptPack[];
  pattern: PromptPack[];
}> {
  const prisma = getPrisma();
  const packs = await prisma.promptPack.findMany({
    orderBy: [{ category: 'asc' }, { version: 'desc' }],
  });

  return {
    core: packs.filter((p) => p.category === 'CORE' as PromptCategory),
    custom: packs.filter((p) => p.category === 'CUSTOM_ADMIN' as PromptCategory),
    escalation: packs.filter((p) => p.category === 'ESCALATION' as PromptCategory),
    pattern: packs.filter((p) => p.category === 'PATTERN_CHECK' as PromptCategory),
  };
}

/**
 * Get prompt packs by hash for decision provenance.
 */
export async function getPromptPacksByHash(hashes: string[]): Promise<PromptPack[]> {
  const prisma = getPrisma();
  return prisma.promptPack.findMany({
    where: { hash: { in: hashes } },
  });
}

/**
 * Get all prompt pack names and latest versions (metadata only, no content).
 * For listing in admin UI — content is fetched separately with auth check.
 */
export async function listPromptPackVersions(): Promise<Array<{
  name: string;
  version: string;
  category: PromptCategory;
  createdAt: Date;
}>> {
  const prisma = getPrisma();
  const packs = await prisma.promptPack.findMany({
    select: { name: true, version: true, category: true, createdAt: true },
    orderBy: { createdAt: 'desc' },
  });
  return packs;
}
