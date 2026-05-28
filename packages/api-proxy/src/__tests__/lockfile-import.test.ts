import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { getPrisma, disconnectPrisma } from '@modulewarden/prisma-client';
import {
  importLockfile,
  checkProjectReadiness,
  tryEnableProjectRegistry,
  refreshProjectReadinessForPackageVersion,
} from '../services/lockfile-import.js';

let projectId: string;
let lockfileDir: string;

beforeAll(async () => {
  const prisma = getPrisma();
  await prisma.$connect();

  // Create a test project
  const project = await prisma.project.create({
    data: { name: 'lockfile-import-test', graphState: 'IMPORTING' },
  });
  projectId = project.id;

  lockfileDir = mkdtempSync(join(tmpdir(), 'mw-import-test-'));
});

afterAll(async () => {
  const prisma = getPrisma();
  // Clean up test data
  await prisma.importedPackageVersion.deleteMany({
    where: { packageVersion: { packageName: { startsWith: 'import-' } } },
  });
  await prisma.reviewJob.deleteMany({
    where: { packageVersion: { packageName: { startsWith: 'import-' } } },
  });
  await prisma.packageSubscription.deleteMany({ where: { projectId } });
  await prisma.packageVersion.deleteMany({
    where: { packageName: { startsWith: 'import-' } },
  });
  await prisma.lockfileImport.deleteMany({ where: { projectId } });
  await prisma.project.deleteMany({ where: { id: projectId } });
  await prisma.$disconnect();
  await disconnectPrisma();
  rmSync(lockfileDir, { recursive: true, force: true });
});

function writeNpmLockfile(entries: Record<string, { version: string }>): string {
  const packages: Record<string, any> = {};
  for (const [name, info] of Object.entries(entries)) {
    packages[`node_modules/${name}`] = {
      version: info.version,
      integrity: `sha512-${Buffer.from(`${name}@${info.version}`).toString('base64').slice(0, 44)}`,
    };
  }
  const path = join(lockfileDir, 'package-lock.json');
  writeFileSync(path, JSON.stringify({
    name: 'test-project',
    lockfileVersion: 3,
    packages,
  }, null, 2));
  return path;
}

describe('lockfile import', () => {
  it('1. imports npm lockfile and creates package versions', async () => {
    const lockfilePath = writeNpmLockfile({
      'import-test-pkg-a': { version: '1.0.0' },
      'import-test-pkg-b': { version: '2.0.0' },
      'import-test-pkg-c': { version: '3.0.0' },
    });

    const result = await importLockfile(projectId, lockfilePath);

    expect(result.totalEntries).toBe(3);
    expect(result.newVersions).toBe(3);
    expect(result.newSubscriptions).toBe(3);
    expect(result.enqueuedReviews).toBe(3);
    expect(result.errors).toHaveLength(0);
  });

  it('2. handles duplicate import (upsert)', async () => {
    const lockfilePath = writeNpmLockfile({
      'import-test-pkg-a': { version: '1.0.0' },
      'import-test-pkg-d': { version: '4.0.0' },
    });

    const result = await importLockfile(projectId, lockfilePath);

    // pkg-a already exists, so it is updated and still re-enqueues if still pending
    // pkg-d should be new and also enqueued
    expect(result.totalEntries).toBe(2);
    expect(result.newVersions).toBe(2); // Both upserted (upsert doesn't distinguish new vs update)
    expect(result.enqueuedReviews).toBe(2); // Both entries map to review jobs in this queue state
  });

  it('3. creates subscriptions for all packages', async () => {
    const prisma = getPrisma();
    const subs = await prisma.packageSubscription.findMany({
      where: { projectId, active: true },
    });

    expect(subs.length).toBeGreaterThanOrEqual(4);
    const names = subs.map((s) => s.packageName);
    expect(names).toContain('import-test-pkg-a');
    expect(names).toContain('import-test-pkg-d');
  });

  it('4. creates review jobs for each imported version', async () => {
    const prisma = getPrisma();
    const jobs = await prisma.reviewJob.findMany({
      where: {
        packageVersion: { packageName: { startsWith: 'import-test-' } },
      },
    });

    expect(jobs.length).toBeGreaterThanOrEqual(4);
    expect(jobs.every((j) => j.status === 'PENDING')).toBe(true);
    expect(jobs.every((j) => j.trigger === 'PREFLIGHT')).toBe(true);
  });

  it('5. checkProjectReadiness returns correct counts', async () => {
    const readiness = await checkProjectReadiness(projectId);
    expect(readiness.total).toBeGreaterThanOrEqual(4);
    expect(readiness.decided).toBe(0);
    expect(readiness.pending).toBeGreaterThanOrEqual(4);
    expect(readiness.ready).toBe(false);
  });

  it('6b. refreshProjectReadinessForPackageVersion enqueues project-ready callback after decisions', async () => {
    const prisma = getPrisma();
    const readyProject = await prisma.project.create({
      data: { name: 'lockfile-import-ready-registry', graphState: 'IMPORTING' },
    });
    const readyProjectId = readyProject.id;

    const lockfilePath = writeNpmLockfile({
      'import-ready-pkg-a': { version: '1.0.0' },
      'import-ready-pkg-b': { version: '1.0.1' },
    });

    await importLockfile(readyProjectId, lockfilePath);

    const projectPackages = await prisma.importedPackageVersion.findMany({
      where: {
        projectId: readyProjectId,
        packageVersion: {
          packageName: { startsWith: 'import-ready-pkg-' },
        },
      },
      include: { packageVersion: true },
    });

    for (const link of projectPackages) {
      const reviewJob = await prisma.reviewJob.create({
        data: {
          packageVersionId: link.packageVersion.id,
          auditContext: `preflight:${link.packageVersion.packageName}`,
          trigger: 'PREFLIGHT',
          status: 'COMPLETED',
          idempotencyKey: `ready-${link.packageVersion.packageName}-${link.packageVersion.version}`,
        },
      });

      await getPrisma().decision.create({
        data: {
          reviewJobId: reviewJob.id,
          packageVersionId: link.packageVersion.id,
          verdict: 'ALLOW',
          reasonSummary: 'Ready test decision',
          actorType: 'AGENT',
        },
      });
    }

    const callbacks: Array<{ projectId: string; reason: string }> = [];
    const callbackResult = await refreshProjectReadinessForPackageVersion(
      projectPackages[0].packageVersionId,
      async (projectId, reason) => {
        callbacks.push({ projectId, reason });
        return `project-ready-${projectId}`;
      }
    );

    expect(callbackResult).toBeUndefined();
    expect(callbacks).toEqual([
      {
        projectId: readyProjectId,
        reason: `Project ${readyProjectId} is now ready for registry enablement`,
      },
    ]);

    await prisma.decision.deleteMany({ where: { packageVersionId: { in: projectPackages.map((link) => link.packageVersion.id) } } });
    await prisma.reviewJob.deleteMany({ where: { packageVersionId: { in: projectPackages.map((link) => link.packageVersion.id) } } });

    await prisma.importedPackageVersion.deleteMany({ where: { projectId: readyProjectId } });
    await prisma.lockfileImport.deleteMany({ where: { projectId: readyProjectId } });
    await prisma.packageSubscription.deleteMany({ where: { projectId: readyProjectId } });
    await prisma.project.deleteMany({ where: { id: readyProjectId } });
  });

  it('6c. refreshProjectReadinessForPackageVersion does not emit callback for incomplete coverage', async () => {
    const prisma = getPrisma();
    const incompleteProject = await prisma.project.create({
      data: { name: 'lockfile-import-ready-registry-incomplete', graphState: 'IMPORTING' },
    });
    const incompleteProjectId = incompleteProject.id;

    const lockfilePath = writeNpmLockfile({
      'import-incomplete-pkg-a': { version: '1.0.0' },
    });

    await importLockfile(incompleteProjectId, lockfilePath);

    const incompleteProjectPackages = await prisma.importedPackageVersion.findMany({
      where: { projectId: incompleteProjectId },
      include: { packageVersion: true },
    });

    const callbacks: Array<{ projectId: string; reason: string }> = [];
    await refreshProjectReadinessForPackageVersion(
      incompleteProjectPackages[0].packageVersionId,
      async (projectId, reason) => {
        callbacks.push({ projectId, reason });
        return `project-ready-${projectId}`;
      }
    );

    expect(callbacks).toEqual([]);

    await prisma.importedPackageVersion.deleteMany({ where: { projectId: incompleteProjectId } });
    await prisma.lockfileImport.deleteMany({ where: { projectId: incompleteProjectId } });
    await prisma.packageSubscription.deleteMany({ where: { projectId: incompleteProjectId } });
    await prisma.project.deleteMany({ where: { id: incompleteProjectId } });
  });

  it('6d. refreshProjectReadinessForPackageVersion ignores callback errors and continues', async () => {
    const prisma = getPrisma();
    const resilientProject = await prisma.project.create({
      data: { name: 'lockfile-import-ready-callback-error', graphState: 'IMPORTING' },
    });
    const resilientProjectId = resilientProject.id;

    const lockfilePath = writeNpmLockfile({
      'import-failing-callback': { version: '1.0.0' },
    });

    await importLockfile(resilientProjectId, lockfilePath);

    const resilientPackages = await prisma.importedPackageVersion.findMany({
      where: { projectId: resilientProjectId },
      include: { packageVersion: true },
    });

    const reviewJob = await prisma.reviewJob.create({
      data: {
        packageVersionId: resilientPackages[0].packageVersion.id,
        auditContext: `preflight:${resilientPackages[0].packageVersion.packageName}`,
        trigger: 'PREFLIGHT',
        status: 'COMPLETED',
        idempotencyKey: `ready-callback-${resilientPackages[0].packageVersion.packageName}`,
      },
    });

    await getPrisma().decision.create({
      data: {
        reviewJobId: reviewJob.id,
        packageVersionId: resilientPackages[0].packageVersion.id,
        verdict: 'ALLOW',
        reasonSummary: 'Resilience test decision',
        actorType: 'AGENT',
      },
    });

    const callbacks: Array<{ projectId: string; reason: string }> = [];
    await expect(
      refreshProjectReadinessForPackageVersion(
        resilientPackages[0].packageVersionId,
        async (projectId, reason) => {
          callbacks.push({ projectId, reason });
          throw new Error('project-ready transport failed');
        }
      )
    ).resolves.toBeUndefined();

    expect(callbacks).toHaveLength(1);

    await prisma.decision.deleteMany({ where: { packageVersionId: resilientPackages[0].packageVersion.id } });
    await prisma.reviewJob.delete({ where: { id: reviewJob.id } });
    await prisma.importedPackageVersion.deleteMany({ where: { projectId: resilientProjectId } });
    await prisma.lockfileImport.deleteMany({ where: { projectId: resilientProjectId } });
    await prisma.packageSubscription.deleteMany({ where: { projectId: resilientProjectId } });
    await prisma.project.deleteMany({ where: { id: resilientProjectId } });
  });

  it('7. tryEnableProjectRegistry fails without complete decisions', async () => {
    const enabled = await tryEnableProjectRegistry(projectId);
    expect(enabled).toBe(false);

    const prisma = getPrisma();
    const project = await prisma.project.findUnique({ where: { id: projectId } });
    expect(project?.registryEnabled).toBe(false);
    expect(project?.graphState).toBe('AUDITING');
  });

  it('8. handles missing lockfile gracefully', async () => {
    const result = await importLockfile(projectId, '/nonexistent/lockfile.json');
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.totalEntries).toBe(0);
  });
});
