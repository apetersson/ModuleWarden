import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { getPrisma, disconnectPrisma } from '@modulewarden/prisma-client';
import { importLockfile, checkProjectReadiness, tryEnableProjectRegistry } from '../services/lockfile-import.js';

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
    where: { packageVersion: { packageName: { startsWith: 'import-test-' } } },
  });
  await prisma.reviewJob.deleteMany({
    where: { packageVersion: { packageName: { startsWith: 'import-test-' } } },
  });
  await prisma.packageSubscription.deleteMany({ where: { projectId } });
  await prisma.packageVersion.deleteMany({
    where: { packageName: { startsWith: 'import-test-' } },
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

    // pkg-a already exists, so it should be upserted (no new version)
    // pkg-d should be new
    expect(result.totalEntries).toBe(2);
    expect(result.newVersions).toBe(2); // Both upserted (upsert doesn't distinguish new vs update)
    expect(result.enqueuedReviews).toBe(1); // Only pkg-d is new, pkg-a already has review
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

  it('6. tryEnableProjectRegistry fails without complete decisions', async () => {
    const enabled = await tryEnableProjectRegistry(projectId);
    expect(enabled).toBe(false);

    const prisma = getPrisma();
    const project = await prisma.project.findUnique({ where: { id: projectId } });
    expect(project?.registryEnabled).toBe(false);
    expect(project?.graphState).toBe('AUDITING');
  });

  it('7. handles missing lockfile gracefully', async () => {
    const result = await importLockfile(projectId, '/nonexistent/lockfile.json');
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.totalEntries).toBe(0);
  });
});
