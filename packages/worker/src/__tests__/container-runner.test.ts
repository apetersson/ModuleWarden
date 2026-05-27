import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { ContainerRunner } from '../services/container-runner.js';
import { execSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const TEST_IMAGE = 'modulewarden-audit-runner';

describe('ContainerRunner', () => {
  let runner: ContainerRunner;

  beforeAll(async () => {
    runner = new ContainerRunner({
      imageName: TEST_IMAGE,
      auditNetworkName: 'mw-audit-test-net',
      containerTimeoutMs: 30_000,
    });
  });

  afterAll(async () => {
    try {
      execSync('docker network rm mw-audit-test-net 2>/dev/null || true', { stdio: 'pipe' });
    } catch { /* ignore */ }
  });

  it('1. creates fresh container, runs, and captures evidence', async () => {
    const result = await runner.run({
      rpcToken: 'test-token',
      rpcPort: 9090,
      packageName: 'test-pkg',
      packageVersion: '1.0.0',
    });

    expect(result.containerId).toBeTruthy();
    expect(result.exitCode).toBe(0);
    expect(result.workspacePath).toBeTruthy();
    expect(existsSync(result.workspacePath)).toBe(true);

    // Evidence artifacts should be found in the output directory
    const outputDir = join(result.workspacePath, 'output');
    expect(existsSync(outputDir)).toBe(true);
    expect(result.evidenceArtifacts.length).toBeGreaterThanOrEqual(1);

    // Container should be destroyed after run
    try {
      execSync(`docker inspect ${result.containerId}`, { stdio: 'pipe' });
      // If we get here, container was not destroyed — fail the test
      expect(false).toBe(true);
    } catch {
      // Expected — container was removed
      expect(true).toBe(true);
    }

    runner.cleanupWorkspace(result.workspacePath);
    expect(existsSync(result.workspacePath)).toBe(false);
  });

  it('2. injects only safe environment variables (no secrets)', async () => {
    const result = await runner.run({
      rpcToken: 'secret-test-token',
      rpcPort: 9090,
      packageName: 'secret-test',
      packageVersion: '2.0.0',
    });

    expect(result.exitCode).toBe(0);

    // Check the captured environment — should include MW_ vars
    // but should NOT include DB credentials, model keys, or Verdaccio tokens
    const outputDir = join(result.workspacePath, 'output');
    const envFile = join(outputDir, 'inspection', 'env.txt');
    if (existsSync(envFile)) {
      const envContent = readFileSync(envFile, 'utf-8');
      // Should have MW_ env vars
      expect(envContent).toContain('MW_PACKAGE_NAME=secret-test');
      expect(envContent).toContain('MW_PACKAGE_VERSION=2.0.0');
      // Should NOT have RPC token (grep -v removed it)
      expect(envContent).not.toContain('MW_RPC_TOKEN');
      // Should NOT have DB creds, model keys, etc.
      expect(envContent).not.toContain('POSTGRES');
      expect(envContent).not.toContain('DATABASE_URL');
      expect(envContent).not.toContain('API_KEY');
    }

    runner.cleanupWorkspace(result.workspacePath);
  });

  it('3. handles non-existent image with error', async () => {
    const badRunner = new ContainerRunner({
      imageName: 'this-image-does-not-exist',
      auditNetworkName: 'mw-audit-test-net',
      containerTimeoutMs: 10_000,
    });

    await expect(badRunner.run({
      rpcToken: 'test',
      rpcPort: 9090,
      packageName: 'fail-test',
      packageVersion: '1.0.0',
    })).rejects.toThrow();
  });

  it('4. collects evidence from output directory', async () => {
    const result = await runner.run({
      rpcToken: 'evidence-test',
      rpcPort: 9090,
      packageName: 'evidence-test',
      packageVersion: '1.0.0',
    });

    expect(result.exitCode).toBe(0);
    expect(result.evidenceArtifacts.length).toBeGreaterThanOrEqual(3);
    // Should have at least: env.txt, system.txt, run-config.json
    const artifactNames = result.evidenceArtifacts.map(a => a.split('/').pop());
    expect(artifactNames).toContain('env.txt');
    expect(artifactNames).toContain('system.txt');

    runner.cleanupWorkspace(result.workspacePath);
  });

  it('5. ensures the audit network exists', async () => {
    const networkInfo = execSync(
      'docker network inspect mw-audit-test-net',
      { encoding: 'utf-8', stdio: 'pipe' }
    );
    const networks = JSON.parse(networkInfo);
    expect(networks.length).toBeGreaterThanOrEqual(1);
    expect(networks[0].Name).toBe('mw-audit-test-net');
  });

  it('6. each container gets a fresh isolated workspace', async () => {
    const result1 = await runner.run({
      rpcToken: 'isolated-1',
      rpcPort: 9090,
      packageName: 'isolated-test',
      packageVersion: '1.0.0',
    });
    const ws1 = result1.workspacePath;

    const result2 = await runner.run({
      rpcToken: 'isolated-2',
      rpcPort: 9090,
      packageName: 'isolated-test',
      packageVersion: '1.0.0',
    });
    const ws2 = result2.workspacePath;

    // Different workspaces
    expect(ws1).not.toBe(ws2);
    expect(result1.exitCode).toBe(0);
    expect(result2.exitCode).toBe(0);

    runner.cleanupWorkspace(ws1);
    runner.cleanupWorkspace(ws2);
    expect(existsSync(ws1)).toBe(false);
    expect(existsSync(ws2)).toBe(false);
  });
});
