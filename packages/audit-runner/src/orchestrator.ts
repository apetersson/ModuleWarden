/**
 * ModuleWarden PI Audit Orchestrator
 *
 * Runs inside the audit container. Requires an RPC bridge server, PI, and a
 * model endpoint; missing prerequisites are fatal because degraded file-only
 * verdicts mask broken agentic audit wiring.
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
import { appendFileSync, readFileSync, existsSync, writeFileSync, mkdirSync } from 'node:fs';
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
  const instPath = join(WORKSPACE, 'instructions.md');
  if (!existsSync(instPath)) {
    throw new Error('Configured prompt-pack instructions are required, but /workspace/instructions.md was not found');
  }

  const configuredInstructions = readFileSync(instPath, 'utf-8');
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

## Configured Audit Prompt Pack

The following instructions were assembled from ModuleWarden's configured prompt packs.
They are mandatory for this audit; do not replace them with a generic fallback.

${configuredInstructions}

## Requirements

1. Apply every configured prompt-pack instruction above.
2. Explore the package using \`package-info\` and \`source-metadata\`.
3. Run \`static-checks\` to detect suspicious patterns.
4. Write key findings as \`write-evidence\`.
5. Submit your final verdict with \`submit-verdict\`.
6. Include risk summary, capability findings, evidence references, and prompt-pack provenance.
`);

  // Add prepared evidence summary
  const evidenceDir = join(WORKSPACE, 'prepared-evidence');
  if (existsSync(evidenceDir)) {
    parts.push(`\n## Prepared Evidence\nEvidence files are available at: ${evidenceDir}\n`);
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
    throw new Error('RPC bridge is required for agentic audit but was not reachable');
  }

  mkdirSync(OUTPUT_DIR, { recursive: true });
  const sessionLogPath = join(OUTPUT_DIR, 'pi-session.log');
  const sessionErrorLogPath = join(OUTPUT_DIR, 'pi-session-error.log');
  writeFileSync(sessionLogPath, '');
  writeFileSync(sessionErrorLogPath, '');

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

  if (!piAvailable) {
    throw new Error('PI is required for agentic audit but was not available in the audit container');
  }

  if (!process.env.MW_MODEL_ENDPOINT_BASE_URL) {
    throw new Error('MW_MODEL_ENDPOINT_BASE_URL is required for agentic audit but was not configured');
  }

  const requestedModel = process.env.MW_MODEL_ENDPOINT_MODEL ?? 'deepseek-v4-flash';
  const modelName = requestedModel === 'deepseek-flash-4' ? 'deepseek-v4-flash' : requestedModel;
  const apiKey = process.env.MW_MODEL_ENDPOINT_API_KEY;
  if (!apiKey) {
    throw new Error('MW_MODEL_ENDPOINT_API_KEY is required for agentic audit but was not configured');
  }

  // Start PI in RPC mode
  console.log('[orchestrator] Starting PI RPC session...');
  const piProc = spawn('pi', [
    '--mode', 'rpc',
    '--no-session',
    '--provider', 'deepseek',
    '--model', modelName,
    '--api-key', apiKey,
  ], {
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
    const chunk = data.toString();
    piOutput += chunk;
    try {
      appendFileSync(sessionLogPath, chunk);
    } catch { /* ignore live stream write failures */ }
    const lines = chunk.split('\n').filter(Boolean);
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
    const chunk = data.toString();
    piError += chunk;
    try {
      appendFileSync(sessionErrorLogPath, chunk);
    } catch { /* ignore live stream write failures */ }
  });

  // Wait for PI to start
  await sleep(2000);

  // Send the audit prompt
  const auditPrompt = buildAuditPrompt();
  writeFileSync(join(OUTPUT_DIR, 'initial-prompt.md'), auditPrompt);
  console.log('[orchestrator] Sending audit prompt to PI...');
  sendRpcCommand(piProc, {
    type: 'prompt',
    message: auditPrompt,
  });

  // Wait for verdict (with timeout)
  console.log('[orchestrator] Waiting for verdict (timeout: 5 min)...');
  const verdict = await waitForVerdict(300_000);
  if (!promptAccepted) {
    console.log('[orchestrator] PI prompt acknowledgement was not observed before verdict timeout');
  }

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
  try {
    writeFileSync(sessionLogPath, piOutput);
    writeFileSync(sessionErrorLogPath, piError);
  } catch { /* ignore */ }

  console.log('[orchestrator] Audit session complete');
  process.exit(verdict ? 0 : 1);
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`[orchestrator] Fatal audit orchestration error: ${message}`);
  process.exit(1);
});
