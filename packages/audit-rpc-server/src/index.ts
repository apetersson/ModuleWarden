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
import { readFileSync, existsSync, readdirSync, statSync, writeFileSync, mkdirSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { execSync, execFileSync } from 'node:child_process';
import type {
  AuditVerdict,
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
import { extractCapabilities, type CapabilityFinding } from '@modulewarden/shared/services/capability-extract';

// ── Configuration from environment ──────────────────────────

const PORT = parseInt(process.env.MW_RPC_PORT ?? '9090', 10);
const HOST = process.env.MW_RPC_HOST ?? '127.0.0.1';
const RPC_TOKEN = process.env.MW_RPC_TOKEN ?? '';
const MW_API_TOKEN = process.env.MW_API_TOKEN ?? process.env.MW_RPC_TOKEN ?? ''; // Distinct token for outbound API calls; falls back to RPC token for backward compat
const WORKSPACE = process.env.MW_WORKSPACE ?? '/workspace';
const MW_API_BASE = process.env.MW_API_BASE ?? 'http://modulewarden-api:4000';

// ── Helpers ─────────────────────────────────────────────────

function getInputsDir(): string {
  return join(WORKSPACE, 'inputs');
}

function getOutputDir(): string {
  return join(WORKSPACE, 'output');
}

function checkToken(token: string | undefined): boolean {
  // Fail closed: require a valid token even though the container is isolated (M-7)
  if (!RPC_TOKEN) return false;
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

function unwrapToolBody<T>(body: unknown): { requestId: string; params: T } {
  const record = body && typeof body === 'object' ? body as Record<string, unknown> : {};
  const nestedParams = record.params && typeof record.params === 'object'
    ? record.params as Record<string, unknown>
    : {};
  const params = record.jsonrpc && nestedParams.params && typeof nestedParams.params === 'object'
    ? nestedParams.params as Record<string, unknown>
    : nestedParams;
  return {
    requestId: String(record.requestId ?? record.id ?? `req-${Date.now()}`),
    params: (params && typeof params === 'object' ? params : {}) as T,
  };
}

function normalizeEvidenceParams(params: Record<string, unknown>): WriteEvidenceParams {
  const label = typeof params.label === 'string'
    ? params.label
    : typeof params.name === 'string' && typeof params.version === 'string'
      ? `${params.name}-${params.version}-findings`
      : `evidence-${Date.now()}`;
  const description = typeof params.description === 'string'
    ? params.description
    : typeof params.summary === 'string'
      ? params.summary
      : 'Audit evidence';
  const rawType = typeof params.type === 'string' ? params.type : 'other';
  const validTypes = new Set(['static-analysis', 'sandbox-trace', 'web-search', 'pi-session-log', 'pi-session-artifact', 'other']);
  return {
    type: validTypes.has(rawType) ? rawType as WriteEvidenceParams['type'] : 'other',
    label,
    description,
    data: (params.data && typeof params.data === 'object' ? params.data : params) as Record<string, unknown>,
    filePaths: Array.isArray(params.filePaths)
      ? params.filePaths.map(String)
      : Array.isArray(params.evidence_files)
        ? params.evidence_files.map(String)
        : undefined,
  };
}

function normalizeVerdictParams(params: Record<string, unknown>): SubmitVerdictParams {
  const source = params.verdict && typeof params.verdict === 'object'
    ? params.verdict as Record<string, unknown>
    : params;
  const rawVerdict = String(source.verdict ?? 'quarantine').toLowerCase();
  const verdict = ['allow', 'block', 'quarantine'].includes(rawVerdict)
    ? rawVerdict as AuditVerdict['verdict']
    : 'quarantine';
  const score = typeof source.riskScore === 'number' ? source.riskScore : undefined;

  return {
    verdict: {
      verdict,
      riskSummary: String(source.riskSummary ?? source.summary ?? ''),
      capabilityDeltas: Array.isArray(source.capabilityDeltas) ? source.capabilityDeltas as AuditVerdict['capabilityDeltas'] : [],
      intentMismatches: Array.isArray(source.intentMismatches) ? source.intentMismatches as AuditVerdict['intentMismatches'] : [],
      exploitHypotheses: Array.isArray(source.exploitHypotheses) ? source.exploitHypotheses as AuditVerdict['exploitHypotheses'] : [],
      scores: source.scores && typeof source.scores === 'object'
        ? source.scores as Record<string, number>
        : score === undefined ? {} : { risk: score },
      evidenceReferences: Array.isArray(source.evidenceReferences)
        ? source.evidenceReferences.map(String)
        : Array.isArray(source.evidenceRefs)
          ? source.evidenceRefs.map(String)
          : [],
      ...(typeof source.piSessionId === 'string' ? { piSessionId: source.piSessionId } : {}),
      ...(typeof source.promptPackVersion === 'string' ? { promptPackVersion: source.promptPackVersion } : {}),
    },
  };
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

  const scripts = (pkg).scripts ?? {};
  const scriptsRecord = scripts as Record<string, string>;
  const hasInstallScript = Boolean(scriptsRecord.preinstall || scriptsRecord.install || scriptsRecord.postinstall);

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
    typeof (pkg).repository === 'object'
      ? ((pkg).repository as Record<string, unknown>).url ?? null
      : ((pkg).repository as string) ?? null;

  const data: PackageInfoResponse = {
    name: (pkg).name as string ?? '',
    version: (pkg).version as string ?? '',
    description: (pkg).description as string ?? '',
    license: (pkg).license as string ?? null,
    homepage: (pkg).homepage as string ?? null,
    repository: repo as string | null,
    scripts: scriptsRecord,
    dependencies: (pkg).dependencies as Record<string, string> ?? {},
    devDependencies: (pkg).devDependencies as Record<string, string> ?? {},
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

  if (!existsSync(packageDir)) {
    return {
      tool: 'static-checks', requestId, success: true,
      data: { findings: [], summary: {
        network: 'none', filesystem: 'none', process: 'none',
        'dynamic-code': 'none', 'env-credential': 'none', 'native-wasm': 'none',
        obfuscation: 'none', 'dependency-indirection': 'none', 'install-time': 'none',
      }, obfuscationDetected: false, suspiciousPatterns: [] },
    };
  }

  // Use shared AST-based capability extraction (ARCH-03)
  const { findings: capFindings, summary } = extractCapabilities(packageDir);
  const pkg = readPackageJson();
  const scripts = pkg?.scripts && typeof pkg.scripts === 'object'
    ? pkg.scripts as Record<string, string>
    : {};
  const installScripts = ['preinstall', 'install', 'postinstall', 'prepare']
    .filter((name) => typeof scripts[name] === 'string');
  if (installScripts.length > 0) {
    capFindings.push({
      category: 'install-time',
      severity: 'high',
      description: 'Lifecycle script executes during package installation',
      files: ['package.json'],
      evidence: installScripts.map((name) => `${name}: ${scripts[name]}`),
    });
    summary['install-time'] = 'high';
  }

  const suspiciousPatterns: string[] = [];
  for (const f of capFindings) {
    if (f.category === 'obfuscation') {
      for (const file of f.files) {
        suspiciousPatterns.push(`Obfuscation in ${file}`);
      }
    }
  }

  // Convert shared capability findings to RPC StaticCheckResponse format
  const findings: StaticCheckResponse['findings'] = capFindings.map((f: CapabilityFinding) => ({
    category: f.category,
    severity: f.severity,
    description: f.description,
    files: f.files,
    evidence: f.evidence,
  }));

  return {
    tool: 'static-checks', requestId, success: true,
    data: { findings, summary, obfuscationDetected: summary.obfuscation !== 'none', suspiciousPatterns },
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
          // Use execFileSync with temp script to avoid shell injection
          const tmpDir = mkdtempSync(join(tmpdir(), 'mw-import-'));
          const scriptPath = join(tmpDir, 'import-check.mjs');
          const safeModuleName = params.moduleName.replace(/[^a-zA-Z0-9_/@\-.]/g, '');
          const importCode = safeModuleName.startsWith('node:')
            ? `import { createRequire } from 'module'; const require = createRequire(import.meta.url); const m = require('${safeModuleName.replace(/'/g, "\\'")}'); console.log('Import OK:', typeof m);`
            : `import m from '${safeModuleName.replace(/'/g, "\\'")}'; console.log('Import OK:', typeof (m?.default ?? m));`;
          writeFileSync(scriptPath, importCode);
          stdout = execFileSync('node', [scriptPath], { cwd: packageDir, encoding: 'utf-8', timeout: 30_000 });
          exitCode = 0;
        } catch (e) { stdout = String(e); exitCode = 1; }
        break;
      case 'run-script':
        if (!params.scriptName) return { tool: 'sandbox-execute', requestId, success: false, error: 'scriptName required' };
        try {
          stdout = execFileSync('npm', ['run', params.scriptName], { cwd: packageDir, encoding: 'utf-8', timeout: 60_000 });
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
    handlePackageInfo(unwrapToolBody<Record<string, never>>(request.body).requestId));

  app.post<{ Body: { requestId: string } }>('/tools/source-metadata', async (request) =>
    handleSourceMetadata(unwrapToolBody<Record<string, never>>(request.body).requestId));

  app.post<{ Body: { requestId: string } }>('/tools/static-checks', async (request) =>
    handleStaticChecks(unwrapToolBody<Record<string, never>>(request.body).requestId));

  app.post<{ Body: { requestId: string; params: SandboxExecuteParams } }>('/tools/sandbox-execute', async (request) => {
    const { requestId, params } = unwrapToolBody<SandboxExecuteParams>(request.body);
    return handleSandboxExecute(requestId, params);
  });

  app.post<{ Body: { requestId: string; params: { predecessorVersion: string; predecessorHash: string } } }>(
    '/tools/predecessor-diff', async (request) => {
      const { requestId, params } = unwrapToolBody<{ predecessorVersion: string; predecessorHash: string }>(request.body);
      return handleProxyDiff(requestId, params);
    });

  app.post<{ Body: { requestId: string; params: WebSearchParams } }>('/tools/web-search', async (request) => {
    const { requestId, params } = unwrapToolBody<WebSearchParams>(request.body);
    return handleWebSearch(requestId, params);
  });

  app.post<{ Body: { requestId: string; params: WriteEvidenceParams } }>('/tools/write-evidence', async (request) => {
    const { requestId, params } = unwrapToolBody<Record<string, unknown>>(request.body);
    return handleWriteEvidence(requestId, normalizeEvidenceParams(params));
  });

  app.post<{ Body: { requestId: string; params: SubmitVerdictParams } }>('/tools/submit-verdict', async (request) => {
    const { requestId, params } = unwrapToolBody<Record<string, unknown>>(request.body);
    return handleSubmitVerdict(requestId, normalizeVerdictParams(params));
  });

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
const isMainModule = process.argv[1] === fileURLToPath(import.meta.url);
if (isMainModule) {
  // eslint-disable-next-line @typescript-eslint/no-floating-promises
  main();
}
