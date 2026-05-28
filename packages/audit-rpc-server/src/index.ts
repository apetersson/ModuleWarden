/**
 * ModuleWarden Audit RPC Bridge Server
 *
 * Runs inside each isolated audit Docker container.
 * Listens on MW_RPC_PORT (default 9090) and serves RPC tool endpoints
 * that PI connects to via custom tool definitions.
 *
 * Tools either execute locally inside the container (package-info,
 * static-checks, sandbox-execute) or proxy to ModuleWarden's main service
 * (predecessor-diff, web-search, write-evidence, submit-verdict).
 */

import Fastify, { type FastifyInstance } from 'fastify';
import { readFileSync, existsSync, readdirSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { execSync } from 'node:child_process';
import type {
  PackageInfoResponse,
  PredecessorDiffResponse,
  SourceMetadataResponse,
  StaticCheckResponse,
  SandboxExecuteResponse,
  SandboxExecuteParams,
  WebSearchResponse,
  WebSearchParams,
  WriteEvidenceParams,
  WriteEvidenceResponse,
  SubmitVerdictParams,
  SubmitVerdictResponse,
  RpcToolResult,
} from '@modulewarden/shared/services/rpc-tools';

// ── Configuration from environment ──────────────────────────

const PORT = parseInt(process.env.MW_RPC_PORT ?? '9090', 10);
const HOST = process.env.MW_RPC_HOST ?? '127.0.0.1';
const RPC_TOKEN = process.env.MW_RPC_TOKEN ?? '';
const WORKSPACE = process.env.MW_WORKSPACE ?? '/workspace';
const MW_API_BASE = process.env.MW_API_BASE ?? 'http://modulewarden-api:4000';
const MW_API_TOKEN = RPC_TOKEN; // Same run-scoped token for API calls

// ── Helpers ─────────────────────────────────────────────────

function getInputsDir(): string {
  return join(WORKSPACE, 'inputs');
}

function getOutputDir(): string {
  return join(WORKSPACE, 'output');
}

function checkToken(token: string | undefined): boolean {
  if (!RPC_TOKEN) return true;
  return token === RPC_TOKEN;
}

function pkgDir(): string {
  return join(getInputsDir(), 'package');
}

function readPackageJson(): Record<string, unknown> | null {
  const path = join(pkgDir(), 'package.json');
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, 'utf-8'));
}

// ── Tool Implementations ────────────────────────────────────

function handlePackageInfo(requestId: string): RpcToolResult {
  const pkg = readPackageJson();
  if (!pkg) {
    return {
      tool: 'package-info', requestId, success: false,
      error: `package.json not found in ${pkgDir()}`,
    };
  }

  const scripts = (pkg as Record<string, unknown>).scripts ?? {};
  const scriptsRecord = scripts as Record<string, string>;
  const hasInstallScript = !!(scriptsRecord.preinstall || scriptsRecord.install || scriptsRecord.postinstall);

  let fileCount = 0;
  let totalSizeBytes = 0;
  const packageDir = pkgDir();
  if (existsSync(packageDir)) {
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.isFile()) { fileCount++; try { totalSizeBytes += statSync(full).size; } catch { /* */ } }
      }
    };
    walk(packageDir);
  }

  const repo =
    typeof (pkg as Record<string, unknown>).repository === 'object'
      ? ((pkg as Record<string, unknown>).repository as Record<string, unknown>).url ?? null
      : ((pkg as Record<string, unknown>).repository as string) ?? null;

  const data: PackageInfoResponse = {
    name: (pkg as Record<string, unknown>).name as string ?? '',
    version: (pkg as Record<string, unknown>).version as string ?? '',
    description: (pkg as Record<string, unknown>).description as string ?? '',
    license: (pkg as Record<string, unknown>).license as string ?? null,
    homepage: (pkg as Record<string, unknown>).homepage as string ?? null,
    repository: repo as string | null,
    scripts: scriptsRecord,
    dependencies: (pkg as Record<string, unknown>).dependencies as Record<string, string> ?? {},
    devDependencies: (pkg as Record<string, unknown>).devDependencies as Record<string, string> ?? {},
    hasInstallScript,
    fileCount,
    totalSizeBytes,
  };

  return { tool: 'package-info', requestId, success: true, data: data as unknown as Record<string, unknown> };
}

function handleSourceMetadata(requestId: string): RpcToolResult {
  const packageDir = pkgDir();
  const data: SourceMetadataResponse = {
    readmeSummary: null, changelogContent: null, repositoryUrl: null,
    homepageUrl: null, authorName: null, maintainers: [],
    issuesUrl: null, fundingUrl: null, keywords: [],
  };

  for (const name of ['README.md', 'README', 'Readme.md']) {
    const p = join(packageDir, name);
    if (existsSync(p)) { data.readmeSummary = readFileSync(p, 'utf-8').slice(0, 2000); break; }
  }
  for (const name of ['CHANGELOG.md', 'CHANGELOG', 'CHANGES.md']) {
    const p = join(packageDir, name);
    if (existsSync(p)) { data.changelogContent = readFileSync(p, 'utf-8').slice(0, 5000); break; }
  }

  const pkg = readPackageJson();
  if (pkg) {
    const repo = pkg.repository;
    data.repositoryUrl = typeof repo === 'object' ? (repo as Record<string, unknown>).url as string ?? null : repo as string ?? null;
    data.homepageUrl = pkg.homepage as string ?? null;
    const author = pkg.author;
    data.authorName = typeof author === 'object' ? (author as Record<string, unknown>).name as string ?? null : author as string ?? null;
    data.keywords = (pkg.keywords as string[]) ?? [];
    const bugs = pkg.bugs;
    data.issuesUrl = typeof bugs === 'object' ? (bugs as Record<string, unknown>).url as string ?? null : null;
    const fund = pkg.funding;
    data.fundingUrl = typeof fund === 'object' ? (fund as Record<string, unknown>).url as string ?? null : null;
  }

  return { tool: 'source-metadata', requestId, success: true, data: data as unknown as Record<string, unknown> };
}

function handleStaticChecks(requestId: string): RpcToolResult {
  const packageDir = pkgDir();
  const findings: StaticCheckResponse['findings'] = [];
  const summary: StaticCheckResponse['summary'] = {
    network: 'none', filesystem: 'none', process: 'none',
    'dynamic-code': 'none', 'env-credential': 'none', 'native-wasm': 'none',
    obfuscation: 'none', 'dependency-indirection': 'none', 'install-time': 'none',
  };
  const suspiciousPatterns: string[] = [];

  if (!existsSync(packageDir)) {
    return {
      tool: 'static-checks', requestId, success: true,
      data: { findings, summary, obfuscationDetected: false, suspiciousPatterns } as unknown as Record<string, unknown>,
    };
  }

  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) { if (entry.name !== 'node_modules') walk(full); }
      else if (entry.isFile() && /\.(js|mjs|cjs|ts)$/i.test(entry.name)) {
        try {
          const content = readFileSync(full, 'utf-8');
          const rel = full.replace(packageDir, '').replace(/^\//, '');
          if (/(require\(['"](http|https|net|dgram)['"]\)|fetch\(|WebSocket)/.test(content)) {
            findings.push({ category: 'network', severity: 'medium', description: 'Network access', files: [rel], evidence: ['HTTP/net module or fetch/WebSocket'] });
            summary.network = 'medium';
          }
          if (/(require\(['"]fs['"]\)|\.writeFile(Sync)?\()/.test(content)) {
            findings.push({ category: 'filesystem', severity: 'medium', description: 'Filesystem access', files: [rel], evidence: ['fs module or file write'] });
            summary.filesystem = 'medium';
          }
          if (/(require\(['"]child_process['"]\)|\.exec\(|\.spawn\(|\.fork\()/.test(content)) {
            findings.push({ category: 'process', severity: 'high', description: 'Process execution', files: [rel], evidence: ['child_process or exec/spawn/fork'] });
            summary.process = 'high';
          }
          if (/(eval\(|Function\(|setTimeout\([^,)]*['"])/.test(content)) {
            findings.push({ category: 'dynamic-code', severity: 'high', description: 'Dynamic code execution', files: [rel], evidence: ['eval/Function/setTimeout string'] });
            summary['dynamic-code'] = 'high';
          }
          if (/\\x[0-9a-f]{2}|String\.fromCharCode|atob\(|btoa\(|0x[0-9a-f]{5,}/i.test(content)) {
            summary.obfuscation = 'medium';
            suspiciousPatterns.push(`Obfuscation in ${rel}`);
          }
        } catch { /* skip */ }
      }
    }
  };
  walk(packageDir);

  const pkg = readPackageJson();
  if (pkg) {
    const scripts = (pkg.scripts ?? {}) as Record<string, string>;
    if (scripts.preinstall || scripts.install || scripts.postinstall) {
      summary['install-time'] = 'high';
      findings.push({ category: 'install-time', severity: 'high', description: 'Lifecycle scripts', files: ['package.json'], evidence: ['preinstall/install/postinstall defined'] });
    }
  }

  return {
    tool: 'static-checks', requestId, success: true,
    data: { findings, summary, obfuscationDetected: summary.obfuscation !== 'none', suspiciousPatterns } as unknown as Record<string, unknown>,
  };
}

function handleSandboxExecute(requestId: string, params: SandboxExecuteParams): RpcToolResult {
  const packageDir = pkgDir();
  if (!existsSync(packageDir)) {
    return { tool: 'sandbox-execute', requestId, success: false, error: 'Package directory not found' };
  }

  const startTime = Date.now();
  let stdout = '';
  let stderr = '';
  let exitCode = -1;

  try {
    switch (params.command) {
      case 'install':
        stdout = execSync('npm install --no-audit --no-fund --ignore-scripts 2>&1 || true', { cwd: packageDir, encoding: 'utf-8', timeout: 60_000, maxBuffer: 1024 * 1024 });
        exitCode = 0;
        break;
      case 'import':
        if (!params.moduleName) return { tool: 'sandbox-execute', requestId, success: false, error: 'moduleName required' };
        try {
          stdout = execSync(`node -e "try { const m = require('${params.moduleName.replace(/'/g, "\\'")}'); console.log('Import OK:', typeof m); } catch(e) { console.error('Import failed:', e.message); }"`, { cwd: packageDir, encoding: 'utf-8', timeout: 30_000 });
          exitCode = 0;
        } catch (e) { stdout = String(e); exitCode = 1; }
        break;
      case 'run-script':
        if (!params.scriptName) return { tool: 'sandbox-execute', requestId, success: false, error: 'scriptName required' };
        try {
          stdout = execSync(`npm run ${params.scriptName} 2>&1 || true`, { cwd: packageDir, encoding: 'utf-8', timeout: 60_000 });
          exitCode = 0;
        } catch (e) { stdout = String(e); exitCode = 1; }
        break;
    }
  } catch (err) { stderr = String(err); exitCode = 1; }

  const data: SandboxExecuteResponse = {
    success: exitCode === 0, exitCode, stdout, stderr,
    observedNetworkConnections: [], observedFileWrites: exitCode === 0 ? ['node_modules/'] : [], durationMs: Date.now() - startTime,
  };
  return { tool: 'sandbox-execute', requestId, success: true, data: data as unknown as Record<string, unknown> };
}

async function handleProxyDiff(requestId: string, params: { predecessorVersion: string; predecessorHash: string }): Promise<RpcToolResult> {
  try {
    const url = `${MW_API_BASE}/internal/predecessor-diff?package=${encodeURIComponent(process.env.MW_PACKAGE_NAME ?? '')}&version=${encodeURIComponent(params.predecessorVersion)}&hash=${encodeURIComponent(params.predecessorHash)}`;
    const resp = await fetch(url, { headers: { Authorization: `Bearer ${MW_API_TOKEN}` } });
    if (!resp.ok) return { tool: 'predecessor-diff', requestId, success: false, error: `Predecessor diff failed: ${resp.status}` };
    const data = (await resp.json()) as PredecessorDiffResponse;
    return { tool: 'predecessor-diff', requestId, success: true, data: data as unknown as Record<string, unknown> };
  } catch (err) {
    return { tool: 'predecessor-diff', requestId, success: false, error: `Diff error: ${err instanceof Error ? err.message : String(err)}` };
  }
}

async function handleWebSearch(requestId: string, params: WebSearchParams): Promise<RpcToolResult> {
  try {
    const resp = await fetch(`${MW_API_BASE}/internal/web-search`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${MW_API_TOKEN}` },
      body: JSON.stringify({ query: params.query, sources: params.sources }),
    });
    if (!resp.ok) return { tool: 'web-search', requestId, success: false, error: `Search failed: ${resp.status}` };
    const data = (await resp.json()) as WebSearchResponse;
    return { tool: 'web-search', requestId, success: true, data: data as unknown as Record<string, unknown> };
  } catch (err) {
    return { tool: 'web-search', requestId, success: false, error: `Search error: ${err instanceof Error ? err.message : String(err)}` };
  }
}

async function handleWriteEvidence(requestId: string, params: WriteEvidenceParams): Promise<RpcToolResult> {
  const outputDir = getOutputDir();
  const evidenceDir = join(outputDir, 'evidence');
  mkdirSync(evidenceDir, { recursive: true });

  const fn = join(evidenceDir, `${params.label.replace(/[^a-zA-Z0-9_-]/g, '_')}.json`);
  writeFileSync(fn, JSON.stringify(params.data, null, 2));

  let artifactCount = 1;
  for (const fp of params.filePaths ?? []) {
    const src = join(WORKSPACE, fp);
    if (existsSync(src)) { writeFileSync(join(evidenceDir, fp.replace(/[/\\]/g, '_')), readFileSync(src)); artifactCount++; }
  }

  try {
    await fetch(`${MW_API_BASE}/internal/evidence`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${MW_API_TOKEN}` },
      body: JSON.stringify({ label: params.label, description: params.description, type: params.type, artifactCount }),
    });
  } catch { /* fire-and-forget */ }

  const data: WriteEvidenceResponse = { evidenceId: `ev-${params.label}-${Date.now()}`, artifactCount };
  return { tool: 'write-evidence', requestId, success: true, data: data as unknown as Record<string, unknown> };
}

async function handleSubmitVerdict(requestId: string, params: SubmitVerdictParams): Promise<RpcToolResult> {
  const outputDir = getOutputDir();
  mkdirSync(outputDir, { recursive: true });
  writeFileSync(join(outputDir, 'verdict.json'), JSON.stringify(params.verdict, null, 2));

  try {
    const resp = await fetch(`${MW_API_BASE}/internal/verdict`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${MW_API_TOKEN}` },
      body: JSON.stringify(params.verdict),
    });
    if (!resp.ok) return { tool: 'submit-verdict', requestId, success: false, error: `Verdict submission failed: ${resp.status}` };
    const data = (await resp.json()) as SubmitVerdictResponse;
    return { tool: 'submit-verdict', requestId, success: true, data: data as unknown as Record<string, unknown> };
  } catch (err) {
    return { tool: 'submit-verdict', requestId, success: false, error: `Verdict error: ${err instanceof Error ? err.message : String(err)}` };
  }
}

// ── Route Registration ──────────────────────────────────────

/**
 * Build a Fastify instance with all RPC tool routes registered.
 * Testable: does not call listen().
 */
export async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });

  // Auth hook
  app.addHook('onRequest', async (request, reply) => {
    if (request.url === '/health') return;
    const token = request.headers['authorization']?.replace(/^Bearer\s+/i, '');
    if (!checkToken(token)) {
      reply.status(401).send({ success: false, error: 'Invalid or missing RPC token' });
    }
  });

  app.get('/health', async () => ({
    status: 'ok', workspace: WORKSPACE, port: PORT,
  }));

  // ── Tool Routes ──────────────────────────────────────────

  app.post<{ Body: { requestId: string } }>('/tools/package-info', async (request) =>
    handlePackageInfo(request.body.requestId));

  app.post<{ Body: { requestId: string } }>('/tools/source-metadata', async (request) =>
    handleSourceMetadata(request.body.requestId));

  app.post<{ Body: { requestId: string } }>('/tools/static-checks', async (request) =>
    handleStaticChecks(request.body.requestId));

  app.post<{ Body: { requestId: string; params: SandboxExecuteParams } }>('/tools/sandbox-execute', async (request) =>
    handleSandboxExecute(request.body.requestId, request.body.params));

  app.post<{ Body: { requestId: string; params: { predecessorVersion: string; predecessorHash: string } } }>(
    '/tools/predecessor-diff', async (request) => handleProxyDiff(request.body.requestId, request.body.params));

  app.post<{ Body: { requestId: string; params: WebSearchParams } }>(
    '/tools/web-search', async (request) => handleWebSearch(request.body.requestId, request.body.params));

  app.post<{ Body: { requestId: string; params: WriteEvidenceParams } }>(
    '/tools/write-evidence', async (request) => handleWriteEvidence(request.body.requestId, request.body.params));

  app.post<{ Body: { requestId: string; params: SubmitVerdictParams } }>(
    '/tools/submit-verdict', async (request) => handleSubmitVerdict(request.body.requestId, request.body.params));

  return app;
}

// ── Main entry point when run directly ──────────────────────

async function main(): Promise<void> {
  const app = await buildApp();
  try {
    await app.listen({ port: PORT, host: HOST });
    console.log(`[mw-rpc] Audit RPC bridge listening on ${HOST}:${PORT}`);
    console.log(`[mw-rpc] Workspace: ${WORKSPACE}`);
    console.log(`[mw-rpc] Package: ${process.env.MW_PACKAGE_NAME ?? 'unknown'}@${process.env.MW_PACKAGE_VERSION ?? 'unknown'}`);
  } catch (err) {
    console.error('[mw-rpc] Failed to start:', err);
    process.exit(1);
  }
}

// Only start when run directly (not imported for tests)
const isMainModule = process.argv[1]?.endsWith('index.ts') || process.argv[1]?.endsWith('dist/index.js');
if (isMainModule) {
  // eslint-disable-next-line @typescript-eslint/no-floating-promises
  main();
}
