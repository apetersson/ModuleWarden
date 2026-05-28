import { getPrisma } from '@modulewarden/prisma-client';
import type { LockfileEntry, LockfileParseResult } from '@modulewarden/shared/services/lockfile';
import { parseLockfile } from '@modulewarden/shared/services/lockfile';
import { buildIdempotencyKey } from '@modulewarden/shared/constants';
import { existsSync } from 'node:fs';

export interface ImportResult {
  projectId: string;
  totalEntries: number;
  newVersions: number;
  newSubscriptions: number;
  enqueuedReviews: number;
  errors: string[];
}

/**
 * Import a lockfile into ModuleWarden.
 *
 * Steps:
 * 1. Parse the lockfile to extract all package versions
 * 2. Upsert each package version into Prisma
 * 3. Subscribe to each package for upstream monitoring
 * 4. Enqueue cold-start review jobs for each version
 * 5. Update project graph state to AUDITING
 */
export async function importLockfile(
  projectId: string,
  lockfilePath: string,
  pgBossSend?: (queue: string, data: Record<string, unknown>) => Promise<string | null>
): Promise<ImportResult> {
  const result: ImportResult = {
    projectId,
    totalEntries: 0,
    newVersions: 0,
    newSubscriptions: 0,
    enqueuedReviews: 0,
    errors: [],
  };

  // 1. Verify file exists
  if (!existsSync(lockfilePath)) {
    result.errors.push(`Lockfile not found: ${lockfilePath}`);
    return result;
  }

  // 2. Parse lockfile
  const parseResult: LockfileParseResult = parseLockfile(lockfilePath);
  result.errors.push(...parseResult.errors);
  result.totalEntries = parseResult.entries.length;

  if (parseResult.entries.length === 0) {
    return result;
  }

  const prisma = getPrisma();
  const lockfileImport = await prisma.lockfileImport.create({
    data: {
      projectId,
      lockfilePath,
      packageCount: parseResult.entries.length,
    },
  });

  // 3. Upsert each package version and create subscriptions
  for (const entry of parseResult.entries) {
    try {
      // Upsert package version
      const packageVersion = await prisma.packageVersion.upsert({
        where: {
          packageName_version_registrySource_tarballHash: {
            packageName: entry.packageName,
            version: entry.version,
            registrySource: 'npm',
            tarballHash: entry.integrity,
          },
        },
        create: {
          packageName: entry.packageName,
          version: entry.version,
          registrySource: 'npm',
          tarballHash: entry.integrity,
          description: entry.resolved ? `Resolved from ${entry.resolved}` : undefined,
        },
        update: {}, // No-op on conflict
      });
      result.newVersions++;

      await prisma.importedPackageVersion.upsert({
        where: {
          projectId_packageVersionId: {
            projectId,
            packageVersionId: packageVersion.id,
          },
        },
        create: {
          projectId,
          packageVersionId: packageVersion.id,
          lockfileImportId: lockfileImport.id,
        },
        update: { lockfileImportId: lockfileImport.id },
      });

      // Create subscription for each package (upsert)
      await prisma.packageSubscription.upsert({
        where: {
          projectId_packageName_registrySource: {
            projectId,
            packageName: entry.packageName,
            registrySource: 'npm',
          },
        },
        create: {
          projectId,
          packageName: entry.packageName,
          registrySource: 'npm',
          active: true,
        },
        update: { active: true },
      });
      result.newSubscriptions++;

      const auditContext = `lockfile-import:${lockfilePath.split('/').pop()}`;
      const idempotencyKey = buildIdempotencyKey('package-review', entry.packageName, entry.version, entry.integrity, auditContext);
      const reviewJob = await prisma.reviewJob.upsert({
        where: { idempotencyKey },
        create: {
          packageVersionId: packageVersion.id,
          auditContext,
          trigger: 'PREFLIGHT',
          status: 'PENDING',
          idempotencyKey,
        },
        update: {},
      });

      if (reviewJob.status === 'PENDING') {
        const pgBossJobId = await pgBossSend?.('package-review', {
          packageName: entry.packageName,
          packageVersion: entry.version,
          tarballHash: entry.integrity,
          auditContext,
          idempotencyKey,
        });
        await prisma.reviewJob.update({
          where: { id: reviewJob.id },
          data: {
            status: pgBossJobId ? 'QUEUED' : 'PENDING',
            pgBossJobId: pgBossJobId ?? undefined,
          },
        });
        result.enqueuedReviews++;
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      result.errors.push(`Failed to process ${entry.packageName}@${entry.version}: ${message}`);
    }
  }

  // 5. Update project graph state
  await prisma.project.update({
    where: { id: projectId },
    data: { graphState: 'AUDITING' },
  });

  await tryEnableProjectRegistry(
    projectId,
    pgBossSend
      ? (readyProjectId, reason) => pgBossSend('project-ready', { projectId: readyProjectId, reason })
      : undefined
  );

  return result;
}

/**
 * Check if a project has complete decision coverage for all imported packages.
 * A project is ready when every imported package version has an ALLOW, BLOCK,
 * or QUARANTINE decision.
 */
export async function checkProjectReadiness(projectId: string): Promise<{
  ready: boolean;
  total: number;
  decided: number;
  pending: number;
}> {
  const prisma = getPrisma();

  const versions = await prisma.importedPackageVersion.findMany({
    where: { projectId },
    select: {
      packageVersion: {
        select: { predecessorDecisions: { take: 1, select: { id: true } } },
      },
    },
  });

  const total = versions.length;
  const decided = versions.filter((v) => v.packageVersion.predecessorDecisions.length > 0).length;
  const pending = total - decided;

  return {
    ready: decided >= total && total > 0,
    total,
    decided,
    pending,
  };
}

/**
 * Re-check all projects that currently include this package version and promote
 * them to READY when all imported versions are decided.
 */
export async function refreshProjectReadinessForPackageVersion(
  packageVersionId: string,
  onProjectReady?: (projectId: string, reason: string) => Promise<string | null>
): Promise<void> {
  const prisma = getPrisma();
  const projectLinks = await prisma.importedPackageVersion.findMany({
    where: { packageVersionId },
    select: { projectId: true },
  });
  for (const { projectId } of projectLinks) {
    await tryEnableProjectRegistry(projectId, onProjectReady);
  }
}

/**
 * Enable the project registry if all imported packages have decisions.
 */
export async function tryEnableProjectRegistry(
  projectId: string,
  onProjectReady?: (projectId: string, reason: string) => Promise<string | null>
): Promise<boolean> {
  const readiness = await checkProjectReadiness(projectId);

  if (!readiness.ready) {
    return false;
  }

  const prisma = getPrisma();
  await prisma.project.update({
    where: { id: projectId },
    data: { graphState: 'READY', registryEnabled: true },
  });

  if (onProjectReady) {
    await onProjectReady(projectId, `Project ${projectId} is now ready for registry enablement`);
  }

  return true;
}
