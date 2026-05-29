import { PrismaClient } from '@prisma/client';
import { buildPostgresConnectionString, defaultConfig } from '@modulewarden/shared/config';

let client: PrismaClient | null = null;

export function getPrisma(): PrismaClient {
  if (!client) {
    if (!process.env.DATABASE_URL) {
      const config = defaultConfig();
      process.env.DATABASE_URL = buildPostgresConnectionString(config, true);
    }

    client = new PrismaClient({
      log: process.env.NODE_ENV === 'development' ? ['warn', 'error'] : ['error'],
    });
  }
  return client;
}

export async function disconnectPrisma(): Promise<void> {
  if (client) {
    await client.$disconnect();
    client = null;
  }
}

// Re-export Prisma types for convenience
export type {
  Prisma,
  Project,
  LockfileImport,
  PackageSubscription,
  UpstreamMetadataSnapshot,
  PackageVersion,
  TarballArtifact,
  ReviewJob,
  AuditRun,
  AppSetting,
  PromptPack,
  ModelProfile,
  EvidenceArtifact,
  Decision,
  Score,
  Override,
  ReAuditCampaign,
  EvaluationLabel,
} from '@prisma/client';

export {
  GraphState,
  ReviewTrigger,
  JobStatus,
  RunStatus,
  PromptCategory,
  EvidenceType,
  Verdict,
  ActorType,
  OverrideScope,
  ReAuditTrigger,
  CampaignStatus,
  LabelType,
} from '@prisma/client';

export * from './repositories/projects.js';
export * from './repositories/package-versions.js';
export * from './repositories/review-jobs.js';
export * from './repositories/decisions.js';
export * from './repositories/audit-runs.js';
export * from './repositories/evidence.js';
export * from './repositories/overrides.js';
export * from './repositories/campaigns.js';
export * from './repositories/subscriptions.js';
export * from './repositories/prompt-packs.js';
export * from './repositories/model-profiles.js';
