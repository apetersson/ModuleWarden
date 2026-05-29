/**
 * Prompt Pack Repository
 *
 * Manages hidden core prompt packs and visible custom prompts.
 * Core prompts are never exposed through user-facing endpoints.
 */
import { getPrisma } from '../index.js';
import type { PromptPack, PromptCategory } from '@prisma/client';

const DEFAULT_PROMPT_CATEGORIES_KEY = 'defaultPromptCategories';
const ALL_PROMPT_CATEGORIES: PromptCategory[] = ['CORE', 'PATTERN_CHECK', 'ESCALATION', 'CUSTOM_ADMIN'];

export interface PromptCategorySetting {
  category: PromptCategory;
  enabled: boolean;
}

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
  const enabledCategories = new Set(
    (await getDefaultPromptCategorySettings())
      .filter((setting) => setting.enabled)
      .map((setting) => setting.category)
  );
  const packs = await prisma.promptPack.findMany({
    where: { category: { in: [...enabledCategories] } },
    orderBy: [{ category: 'asc' }, { name: 'asc' }, { version: 'desc' }],
  });
  const latestByName = new Map<string, PromptPack>();
  for (const pack of packs) {
    const key = `${pack.category}:${pack.name}`;
    if (!latestByName.has(key)) latestByName.set(key, pack);
  }
  const current = [...latestByName.values()];

  return {
    core: current.filter((p) => p.category === 'CORE' as PromptCategory),
    custom: current.filter((p) => p.category === 'CUSTOM_ADMIN' as PromptCategory),
    escalation: current.filter((p) => p.category === 'ESCALATION' as PromptCategory),
    pattern: current.filter((p) => p.category === 'PATTERN_CHECK' as PromptCategory),
  };
}

function normalizePromptCategorySettings(value: unknown): PromptCategorySetting[] {
  const raw = value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
  return ALL_PROMPT_CATEGORIES.map((category) => ({
    category,
    enabled: raw[category] !== false,
  }));
}

export async function getDefaultPromptCategorySettings(): Promise<PromptCategorySetting[]> {
  const prisma = getPrisma();
  const setting = await prisma.appSetting.findUnique({
    where: { key: DEFAULT_PROMPT_CATEGORIES_KEY },
    select: { value: true },
  });
  return normalizePromptCategorySettings(setting?.value);
}

export async function updateDefaultPromptCategorySettings(
  settings: PromptCategorySetting[]
): Promise<PromptCategorySetting[]> {
  const prisma = getPrisma();
  const next = Object.fromEntries(
    ALL_PROMPT_CATEGORIES.map((category) => [
      category,
      settings.find((setting) => setting.category === category)?.enabled !== false,
    ])
  );
  await prisma.appSetting.upsert({
    where: { key: DEFAULT_PROMPT_CATEGORIES_KEY },
    create: { key: DEFAULT_PROMPT_CATEGORIES_KEY, value: next },
    update: { value: next },
  });
  return normalizePromptCategorySettings(next);
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
