import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { FastifyInstance } from 'fastify';
import type { RpcToolResult } from '@modulewarden/shared/services/rpc-tools';

const RPC_TOKEN = 'test-rpc-token';
const PACKAGE_NAME = 'test-pkg';
const PACKAGE_VERSION = '1.0.0';

describe('Audit RPC Bridge Server', () => {
  let app: FastifyInstance;
  let workspacePath: string;
  let inputsPkgDir: string;

  beforeAll(async () => {
    workspacePath = mkdtempSync(join(tmpdir(), 'mw-rpc-test-'));
    inputsPkgDir = join(workspacePath, 'inputs', 'package');
    mkdirSync(inputsPkgDir, { recursive: true });
    mkdirSync(join(workspacePath, 'inputs'), { recursive: true });
    mkdirSync(join(workspacePath, 'output'), { recursive: true });

    // Minimal package fixture
    writeFileSync(join(inputsPkgDir, 'package.json'), JSON.stringify({
      name: PACKAGE_NAME,
      version: PACKAGE_VERSION,
      description: 'RPC bridge test package',
      license: 'MIT',
      scripts: { postinstall: 'echo hello' },
      dependencies: { lodash: '^4.17.21' },
      repository: { url: 'https://github.com/test/test-pkg' },
      homepage: 'https://github.com/test/test-pkg',
      author: 'Test Author',
      keywords: ['test'],
    }));

    writeFileSync(join(inputsPkgDir, 'index.js'), `
      const http = require('http');
      const fs = require('fs');
      eval('console.log("dynamic")');
      module.exports = { run: () => {} };
    `);

    writeFileSync(join(inputsPkgDir, 'README.md'), '# Test Package\n\nTest description.');

    process.env.MW_RPC_TOKEN = RPC_TOKEN;
    process.env.MW_WORKSPACE = workspacePath;
    process.env.MW_PACKAGE_NAME = PACKAGE_NAME;
    process.env.MW_PACKAGE_VERSION = PACKAGE_VERSION;
    process.env.MW_API_BASE = 'http://localhost:19999';

    const { buildApp } = await import('../index.js');
    app = await buildApp();
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    try {
      const { rmSync } = await import('node:fs');
      rmSync(workspacePath, { recursive: true, force: true });
    } catch { /* ignore */ }
  });

  // ── Health ──────────────────────────────────────────────────

  it('1. health check returns ok without auth', async () => {
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.status).toBe('ok');
    expect(body.workspace).toBe(workspacePath);
  });

  it('2. rejects unauthenticated requests', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/tools/package-info',
      body: { requestId: 'r1' },
    });
    expect(res.statusCode).toBe(401);
  });

  it('3. accepts authenticated requests', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/tools/package-info',
      headers: { authorization: `Bearer ${RPC_TOKEN}` },
      body: { requestId: 'r1' },
    });
    expect(res.statusCode).toBe(200);
  });

  // ── package-info ────────────────────────────────────────────

  it('4. package-info extracts metadata', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/tools/package-info',
      headers: { authorization: `Bearer ${RPC_TOKEN}` },
      body: { requestId: 'r1' },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as RpcToolResult;
    expect(body.success).toBe(true);
    expect(body.tool).toBe('package-info');
    const data = body.data as Record<string, unknown>;
    expect(data.name).toBe(PACKAGE_NAME);
    expect(data.version).toBe(PACKAGE_VERSION);
    expect(data.hasInstallScript).toBe(true);
    expect(data.fileCount).toBeGreaterThanOrEqual(2); // index.js + package.json
    expect(data.scripts).toHaveProperty('postinstall');
  });

  // ── source-metadata ─────────────────────────────────────────

  it('5. source-metadata reads README and package.json fields', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/tools/source-metadata',
      headers: { authorization: `Bearer ${RPC_TOKEN}` },
      body: { requestId: 'r2' },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as RpcToolResult;
    expect(body.success).toBe(true);
    const data = body.data as Record<string, unknown>;
    expect(data.readmeSummary).toContain('Test Package');
    expect(data.authorName).toBe('Test Author');
    expect(data.repositoryUrl).toContain('github.com');
    expect(data.keywords).toContain('test');
  });

  // ── static-checks ───────────────────────────────────────────

  it('6. static-checks detects network, filesystem, dynamic code', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/tools/static-checks',
      headers: { authorization: `Bearer ${RPC_TOKEN}` },
      body: { requestId: 'r3' },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as RpcToolResult;
    expect(body.success).toBe(true);
    const data = body.data as Record<string, unknown>;
    const findings = data.findings as Array<{ category: string; severity: string }>;
    const categories = findings.map((f) => f.category);
    expect(categories).toContain('network');
    expect(categories).toContain('filesystem');
    expect(categories).toContain('dynamic-code');
    expect(categories).toContain('install-time');
    expect(data.obfuscationDetected).toBe(false);
  });

  // ── write-evidence (local-only) ─────────────────────────────

  it('7. write-evidence writes evidence file locally', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/tools/write-evidence',
      headers: { authorization: `Bearer ${RPC_TOKEN}` },
      body: {
        requestId: 'r4',
        params: {
          type: 'static-analysis',
          label: 'test-finding',
          description: 'A test finding',
          data: { severity: 'high', detail: 'something suspicious' },
        },
      },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as RpcToolResult;
    expect(body.success).toBe(true);
    const data = body.data as Record<string, unknown>;
    expect(data.evidenceId).toContain('test-finding');

    // Verify file was written
    const evidenceDir = join(workspacePath, 'output', 'evidence');
    expect(existsSync(evidenceDir)).toBe(true);
    const files = (await import('node:fs')).readdirSync(evidenceDir);
    expect(files.length).toBeGreaterThanOrEqual(1);
  });

  it('7b. write-evidence accepts JSON-RPC-style flattened findings payloads', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/tools/write-evidence',
      headers: { authorization: `Bearer ${RPC_TOKEN}` },
      body: {
        jsonrpc: '2.0',
        id: 5,
        method: 'call',
        params: {
          name: 'cors-anywhere',
          version: '0.4.4',
          findings: [{ id: 'CVE-2020-36851', severity: 'critical' }],
          summary: 'Known advisory found',
        },
      },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as RpcToolResult;
    expect(body.success).toBe(true);
    expect(String((body.data as Record<string, unknown>).evidenceId)).toContain('cors-anywhere-0.4.4-findings');
  });

  // ── submit-verdict (local write only) ───────────────────────

  it('8. submit-verdict writes verdict locally even when remote fails', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/tools/submit-verdict',
      headers: { authorization: `Bearer ${RPC_TOKEN}` },
      body: {
        requestId: 'r5',
        params: {
          verdict: {
            verdict: 'allow',
            riskSummary: 'Clean package',
            capabilityDeltas: [],
            intentMismatches: [],
            exploitHypotheses: [],
            scores: { risk: 0.1 },
            evidenceReferences: ['ev-test-finding'],
          },
        },
      },
    });
    expect(res.statusCode).toBe(200);
    // Remote will fail (no ModuleWarden API running), but local write succeeds
    const body = JSON.parse(res.body) as RpcToolResult;
    expect(body.success).toBe(false);
    expect(body.error?.toLowerCase()).toContain('verdict');

    // Local verdict file should exist (written before remote call)
    const outputDir = join(workspacePath, 'output');
    expect(existsSync(join(outputDir, 'verdict.json'))).toBe(true);
    const verdictFile = JSON.parse(
      (await import('node:fs')).readFileSync(join(outputDir, 'verdict.json'), 'utf-8')
    );
    expect(verdictFile.verdict).toBe('allow');
    expect(typeof verdictFile.riskSummary).toBe('string');
  });

  it('8b. submit-verdict accepts JSON-RPC-style flattened verdict payloads', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/tools/submit-verdict',
      headers: { authorization: `Bearer ${RPC_TOKEN}` },
      body: {
        jsonrpc: '2.0',
        id: 6,
        method: 'call',
        params: {
          verdict: 'block',
          riskSummary: 'Critical SSRF advisory',
          riskScore: 9,
          evidenceRefs: ['ev-cve'],
        },
      },
    });
    expect(res.statusCode).toBe(200);
    const outputDir = join(workspacePath, 'output');
    const verdictFile = JSON.parse(
      (await import('node:fs')).readFileSync(join(outputDir, 'verdict.json'), 'utf-8')
    );
    expect(verdictFile.verdict).toBe('block');
    expect(verdictFile.scores.risk).toBe(9);
    expect(verdictFile.evidenceReferences).toEqual(['ev-cve']);
  });
});
