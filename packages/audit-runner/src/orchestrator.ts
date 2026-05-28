/**
 * ModuleWarden PI Audit Orchestrator
 *
 * Runs inside the audit container alongside the RPC bridge server.
 * Starts PI in RPC mode with custom audit tools, sends the audit prompt,
 * and captures the structured verdict.
 *
 * Usage: node dist/orchestrator.js
 *
 * Environment:
 *   MW_RPC_PORT     - RPC bridge port (default 9090)
 *   MW_RPC_TOKEN    - Auth token for RPC bridge
 *   MW_WORKSPACE    - Workspace path (default /workspace)
 *   MW_PACKAGE_NAME - Package under audit
 *   MW_PACKAGE_VERSION - Package version
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { readFileSync, existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

const RPC_PORT = parseInt(process.env.MW_RPC_PORT ?? '9090', 10);
const RPC_TOKEN = process.env.MW_RPC_TOKEN ?? randomBytes(16).toString('hex');
const WORKSPACE = process.env.MW_WORKSPACE ?? '/workspace';
const PACKAGE_NAME = process.env.MW_PACKAGE_NAME ?? 'unknown';
const PACKAGE_VERSION = process.env.MW_PACKAGE_VERSION ?? 'unknown';
const OUTPUT_DIR = join(WORKSPACE, 'output');

interface AuditEvent {
  type: string;
  data?: Record<string, unknown>;
  error?: string;
}

/**
 * Parse a JSONL line from PI RPC output.
 */
function parseRpcLine(line: string): AuditEvent | null {
  try {
    return JSON.parse(line) as AuditEvent;
  } catch {
    return null;
  }
}

/**
 * Send a JSONL command to PI's RPC stdin.
 */
function sendRpcCommand(proc: ChildProcess, command: Record<string, unknown>): void {
  if (proc.stdin) {
    proc.stdin.write(JSON.stringify(command) + '\n');
  }
}

/**
 * Build the audit prompt from prepared evidence and package info.
 */
function buildAuditPrompt(): string {
  const parts: string[] = [];

  parts.push(`# ModuleWarden Package Audit

You are auditing package **${PACKAGE_NAME}@${PACKAGE_VERSION}**.

## Your Task

Analyze this package version for security risks. You must determine whether it should be:
- **allow** — Safe to use
- **block** — Malicious or clearly unsafe
- **quarantine** — Suspicious or unclear; needs human review

## Available Tools

You have access to the following tools via the RPC bridge at http://127.0.0.1:${RPC_PORT}:
- **package-info** — Package.json metadata, file listing, script info
- **source-metadata** — README, changelog, repository info
- **static-checks** — Static analysis for capabilities, obfuscation, patterns
- **sandbox-execute** — Run npm install, import checks, script execution
- **write-evidence** — Persist findings as evidence artifacts
- **submit-verdict** — Submit your final structured verdict

You also have full filesystem access to explore the unpacked package under:
\`/workspace/inputs/package/\`

## Requirements

1. First, explore the package using \`package-info\` and \`source-metadata\`
2. Run \`static-checks\` to detect suspicious patterns
3. Write key findings as \`write-evidence\`
4. Submit your final verdict with \`submit-verdict\`
5. Include risk summary, capability findings, and evidence references
`);

  // Add prepared evidence summary
  const evidenceDir = join(WORKSPACE, 'prepared-evidence');
  if (existsSync(evidenceDir)) {
    parts.push(`\n## Prepared Evidence\nEvidence files are available at: ${evidenceDir}\n`);
  }

  // Add instruction files
  const instPath = join(WORKSPACE, 'instructions.md');
  if (existsSync(instPath)) {
    parts.push(`\n## Run Instructions\n${readFileSync(instPath, 'utf-8')}\n`);
  }

  return parts.join('\n');
}

/**
 * Wait for PI RPC session to complete.
 * Returns when verdict file exists or timeout reached.
 */
async function waitForVerdict(timeoutMs = 300_000): Promise<Record<string, unknown> | null> {
  const verdictPath = join(OUTPUT_DIR, 'verdict.json');
  const startTime = Date.now();

  while (Date.now() - startTime < timeoutMs) {
    if (existsSync(verdictPath)) {
      try {
        return JSON.parse(readFileSync(verdictPath, 'utf-8'));
      } catch {
        await sleep(500);
      }
    }
    await sleep(1000);
  }
  return null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Main orchestrator entry point.
 */
async function main(): Promise<void> {
  console.log(`[orchestrator] Starting audit orchestration for ${PACKAGE_NAME}@${PACKAGE_VERSION}`);
  console.log(`[orchestrator] RPC bridge: http://127.0.0.1:${RPC_PORT}`);

  // Wait for RPC bridge to be ready
  let bridgeReady = false;
  const bridgeStart = Date.now();
  while (Date.now() - bridgeStart < 10_000) {
    try {
      const resp = await fetch(`http://127.0.0.1:${RPC_PORT}/health`);
      if (resp.ok) {
        console.log('[orchestrator] RPC bridge is ready');
        bridgeReady = true;
        break;
      }
    } catch {
      await sleep(200);
    }
  }

  if (!bridgeReady) {
    console.log('[orchestrator] RPC bridge not reachable — running tool-only audit');
    await runToolOnlyAudit();
    return;
  }

  // Create output directory
  try {
    const { mkdirSync } = await import('node:fs');
    mkdirSync(OUTPUT_DIR, { recursive: true });
  } catch { /* ignore */ }

  // Check if PI is available and has a model endpoint
  let piAvailable = false;
  try {
    const whichResult = await new Promise<string>((resolve, reject) => {
      const p = spawn('which', ['pi']);
      let out = '';
      p.stdout?.on('data', (d) => { out += d.toString(); });
      p.on('close', (code) => code === 0 ? resolve(out.trim()) : reject(new Error('not found')));
    });
    console.log(`[orchestrator] PI found at: ${whichResult}`);
    piAvailable = true;
  } catch {
    console.log('[orchestrator] PI not available');
  }

  if (!piAvailable || !process.env.MW_MODEL_ENDPOINT_BASE_URL) {
    console.log('[orchestrator] PI or model endpoint not configured — running tool-only audit');
    await runToolOnlyAudit();
    return;
  }

  // Start PI in RPC mode
  console.log('[orchestrator] Starting PI RPC session...');
  const piProc = spawn('pi', ['--mode', 'rpc', '--no-session', '--provider', 'openai-compatible', '--model', 'gpt-4o'], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      ...process.env,
      MW_RPC_TOKEN: RPC_TOKEN,
      MW_RPC_PORT: String(RPC_PORT),
    },
  });

  let piOutput = '';
  let piError = '';
  let promptAccepted = false;

  piProc.stdout?.on('data', (data: Buffer) => {
    piOutput += data.toString();
    const lines = data.toString().split('\n').filter(Boolean);
    for (const line of lines) {
      const event = parseRpcLine(line);
      if (event?.type === 'response' && (event as any).command === 'prompt') {
        promptAccepted = true;
      }
      if (event?.type === 'agent_end') {
        console.log('[orchestrator] PI agent completed');
      }
    }
  });

  piProc.stderr?.on('data', (data: Buffer) => {
    piError += data.toString();
  });

  // Wait for PI to start
  await sleep(2000);

  // Send the audit prompt
  const auditPrompt = buildAuditPrompt();
  console.log('[orchestrator] Sending audit prompt to PI...');
  sendRpcCommand(piProc, {
    type: 'prompt',
    message: auditPrompt,
  });

  // Wait for verdict (with timeout)
  console.log('[orchestrator] Waiting for verdict (timeout: 5 min)...');
  const verdict = await waitForVerdict(300_000);

  if (verdict) {
    console.log(`[orchestrator] Verdict received: ${JSON.stringify(verdict).slice(0, 200)}...`);
    // Signal PI to exit
    sendRpcCommand(piProc, { type: 'abort' });
  } else {
    console.log('[orchestrator] No verdict received within timeout');
    sendRpcCommand(piProc, { type: 'abort' });
  }

  // Wait for PI to exit
  await new Promise<void>((resolve) => {
    const timeout = setTimeout(() => {
      piProc.kill();
      resolve();
    }, 10_000);
    piProc.on('exit', () => {
      clearTimeout(timeout);
      resolve();
    });
    piProc.on('error', () => {
      clearTimeout(timeout);
      resolve();
    });
  });

  // Save PI session output as evidence
  const sessionLogPath = join(OUTPUT_DIR, 'pi-session.log');
  try {
    writeFileSync(sessionLogPath, piOutput);
    writeFileSync(join(OUTPUT_DIR, 'pi-session-error.log'), piError);
  } catch { /* ignore */ }

  console.log('[orchestrator] Audit session complete');
  process.exit(verdict ? 0 : 1);
}

/**
 * Fallback: Run a tool-only audit when PI or RPC bridge is unavailable.
 * Performs basic file inspection and writes findings locally.
 */
async function runToolOnlyAudit(): Promise<void> {
  console.log('[orchestrator] Running tool-only audit...');

  const bridgeAvailable = await checkBridgeHealth();

  if (bridgeAvailable) {
    // Use RPC bridge tools
    await runBridgeAudit();
  } else {
    // No bridge — do basic file inspection
    await runFileInspection();
  }
}

async function checkBridgeHealth(): Promise<boolean> {
  try {
    const resp = await fetch(`http://127.0.0.1:${RPC_PORT}/health`);
    return resp.ok;
  } catch {
    return false;
  }
}

async function runBridgeAudit(): Promise<void> {
  const baseUrl = `http://127.0.0.1:${RPC_PORT}`;
  const headers = { Authorization: `Bearer ${RPC_TOKEN}`, 'Content-Type': 'application/json' };

  const pkgResp = await fetch(`${baseUrl}/tools/package-info`, {
    method: 'POST', headers, body: JSON.stringify({ requestId: 'r1' }),
  });
  const pkgData = await pkgResp.json() as any;
  console.log(`[orchestrator] Package: ${pkgData.data?.name ?? 'unknown'}@${pkgData.data?.version ?? 'unknown'}`);

  const staticResp = await fetch(`${baseUrl}/tools/static-checks`, {
    method: 'POST', headers, body: JSON.stringify({ requestId: 'r2' }),
  });
  const staticData = await staticResp.json() as any;
  console.log(`[orchestrator] Static findings: ${(staticData.data?.findings ?? []).length}`);

  await fetch(`${baseUrl}/tools/write-evidence`, {
    method: 'POST', headers,
    body: JSON.stringify({
      requestId: 'r3',
      params: { type: 'static-analysis', label: `static-analysis-${Date.now()}`, description: `Static analysis for ${PACKAGE_NAME}@${PACKAGE_VERSION}`, data: staticData.data ?? {} },
    }),
  });

  const verdict = {
    verdict: 'quarantine',
    riskSummary: `Tool-only audit of ${PACKAGE_NAME}@${PACKAGE_VERSION}. Found ${(staticData.data?.findings ?? []).length} findings. Manual review required.`,
    capabilityDeltas: [], intentMismatches: [], exploitHypotheses: [],
    scores: { findingCount: (staticData.data?.findings ?? []).length },
    evidenceReferences: [`static-analysis-${Date.now()}`],
  };
  writeFileSync(join(OUTPUT_DIR, 'verdict.json'), JSON.stringify(verdict, null, 2));
  console.log('[orchestrator] Bridge audit complete');
}

async function runFileInspection(): Promise<void> {
  console.log('[orchestrator] No RPC bridge — running file inspection...');

  const inputsDir = join(WORKSPACE, 'inputs');
  const pkgDir = join(inputsDir, 'package');
  const inspectionDir = join(OUTPUT_DIR, 'inspection');

  try {
    const { readdirSync, statSync } = await import('node:fs');

    // List package files
    const files: string[] = [];
    if (existsSync(pkgDir)) {
      const walk = (dir: string): void => {
        for (const e of readdirSync(dir, { withFileTypes: true })) {
          const full = join(dir, e.name);
          if (e.isDirectory()) walk(full);
          else files.push(full.replace(pkgDir, '').replace(/^\//, ''));
        }
      };
      walk(pkgDir);
    }

    mkdirSync(inspectionDir, { recursive: true });
    writeFileSync(join(inspectionDir, 'files.txt'), files.join('\n'));
    // Write basic inspection metadata
    const env = Object.entries(process.env)
      .filter(([k]) => k !== 'MW_RPC_TOKEN' && !k.startsWith('MW_RPC_'))
      .map(([k, v]) => `${k}=${v}`).join('\n');
    writeFileSync(join(inspectionDir, 'env.txt'), env);
    writeFileSync(join(inspectionDir, 'system.txt'), `Node: ${process.version}\nArch: ${process.arch}\nPlatform: ${process.platform}\n`);

    // Count findings
    const jsFiles = files.filter((f) => /\.(js|mjs|cjs|ts)$/i.test(f));
    const findingCount = jsFiles.length > 0 ? Math.min(jsFiles.length, 5) : 0;

    const verdict = {
      verdict: 'quarantine',
      riskSummary: `File-only inspection of ${PACKAGE_NAME}@${PACKAGE_VERSION}. Found ${findingCount} inspectable files. No static analysis available.`,
      capabilityDeltas: [], intentMismatches: [], exploitHypotheses: [],
      scores: { fileCount: files.length, jsFileCount: jsFiles.length },
      evidenceReferences: [],
    };
    writeFileSync(join(OUTPUT_DIR, 'verdict.json'), JSON.stringify(verdict, null, 2));
    console.log(`[orchestrator] File inspection complete — ${files.length} files found`);
  } catch (err) {
    // Minimal fallback
    const verdict = {
      verdict: 'quarantine',
      riskSummary: `Minimal inspection of ${PACKAGE_NAME}@${PACKAGE_VERSION}.`,
      capabilityDeltas: [], intentMismatches: [], exploitHypotheses: [],
      scores: {},
      evidenceReferences: [],
    };
    writeFileSync(join(OUTPUT_DIR, 'verdict.json'), JSON.stringify(verdict, null, 2));

    // Write basic inspection files for backward compatibility
    try {
      const inspectionDir = join(OUTPUT_DIR, 'inspection');
      mkdirSync(inspectionDir, { recursive: true });
      const env = Object.entries(process.env).filter(([k]) => k !== 'MW_RPC_TOKEN').map(([k, v]) => `${k}=${v}`).join('\n');
      writeFileSync(join(inspectionDir, 'env.txt'), env);
    } catch { /* */ }

    console.log('[orchestrator] Minimal inspection complete');
  }
}

// eslint-disable-next-line @typescript-eslint/no-floating-promises
main();
