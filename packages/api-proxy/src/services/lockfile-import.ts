import { getPrisma } from '@modulewarden/prisma-client';
import type { LockfileEntry, LockfileParseResult } from '@modulewarden/shared/services/lockfile';
import { parseLockfile } from '@modulewarden/shared/services/lockfile';
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
  lockfilePath: string
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

  // 3. Upsert each package version and create subscriptions
  for (const entry of parseResult.entries) {
    try {
      // Upsert package version
      await prisma.packageVersion.upsert({
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

      // Enqueue cold-start review via pg-boss (create review job)
      // v1 uses createReviewJob directly — pg-boss integration will be wired later
      const idempotencyKey = `import:${entry.packageName}:${entry.version}:${entry.integrity}`;

      // Check if a review job already exists
      const existingJob = await prisma.reviewJob.findUnique({
        where: { idempotencyKey },
      });

      if (!existingJob) {
        await prisma.reviewJob.create({
          data: {
            packageVersion: {
              connect: {
                packageName_version_registrySource_tarballHash: {
                  packageName: entry.packageName,
                  version: entry.version,
                  registrySource: 'npm',
                  tarballHash: entry.integrity,
                },
              },
            },
            auditContext: `lockfile-import:${lockfilePath.split('/').pop()}`,
            trigger: 'PREFLIGHT',
            status: 'PENDING',
            idempotencyKey,
          },
        });
        result.enqueuedReviews++;
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      result.errors.push(`Failed to process ${entry.packageName}@${entry.version}: ${message}`);
    }
  }

  // 4. Record lockfile import
  await prisma.lockfileImport.create({
    data: {
      projectId,
      lockfilePath,
      packageCount: parseResult.entries.length,
    },
  });

  // 5. Update project graph state
  await prisma.project.update({
    where: { id: projectId },
    data: { graphState: 'AUDITING' },
  });

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

  // Get all imported package versions for this project's subscriptions
  const subscriptions = await prisma.packageSubscription.findMany({
    where: { projectId, active: true },
  });

  const packageNames = subscriptions.map((s) => s.packageName);
  const versions = await prisma.packageVersion.findMany({
    where: { packageName: { in: packageNames } },
    select: { id: true, predecessorDecisions: { take: 1, select: { id: true } } },
  });

  const total = versions.length;
  const decided = versions.filter((v) => v.predecessorDecisions.length > 0).length;
  const pending = total - decided;

  return {
    ready: decided >= total && total > 0,
    total,
    decided,
    pending,
  };
}

/**
 * Enable the project registry if all imported packages have decisions.
 */
export async function tryEnableProjectRegistry(projectId: string): Promise<boolean> {
  const readiness = await checkProjectReadiness(projectId);

  if (readiness.ready) {
    const prisma = getPrisma();
    await prisma.project.update({
      where: { id: projectId },
      data: { graphState: 'READY', registryEnabled: true },
    });
    return true;
  }

  return false;
}
