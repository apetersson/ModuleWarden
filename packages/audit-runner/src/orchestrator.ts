/**
 * ModuleWarden PI Audit Orchestrator
 *
 * Runs inside the audit container. Requires an RPC bridge server, PI, and a
 * model endpoint; missing prerequisites are fatal because degraded file-only
 * verdicts mask broken agentic audit wiring.
 *
 * Supports any OpenAI-compatible /v1 endpoint (DeepSeek, vLLM, Ollama,
 * Leonardo-hosted models, etc.) by configuring the provider and base URL.
 *
 * Usage: node dist/orchestrator.js
 *
 * Environment:
 *   MW_RPC_PORT                 - RPC bridge port (default 9090)
 *   MW_RPC_TOKEN                - Auth token for RPC bridge
 *   MW_WORKSPACE                - Workspace path (default /workspace)
 *   MW_PACKAGE_NAME             - Package under audit
 *   MW_PACKAGE_VERSION          - Package version
 *   MW_MODEL_ENDPOINT_BASE_URL  - OpenAI-compatible /v1 endpoint URL
 *   MW_MODEL_ENDPOINT_API_KEY   - API key for the endpoint
 *   MW_MODEL_ENDPOINT_MODEL     - Model slug (e.g. qwen3.6-27b, deepseek-chat)
 *   MW_MODEL_ENDPOINT_PROVIDER  - PI provider name (default: openai)
 *   MW_MODEL_ENDPOINT_MAX_TOKENS- Override max output tokens (default: 16384)
 *   MW_AUDIT_MAX_TURNS          - Max agent turns before timeout (default: 50)
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { appendFileSync, readFileSync, existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { randomBytes } from 'node:crypto';
import { homedir } from 'node:os';

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
- **web-search** — Search npm/advisory/general web sources via ModuleWarden's search broker
- **write-evidence** — Persist findings as evidence artifacts
- **submit-verdict** — Submit your final structured verdict

Call RPC tools with ModuleWarden's direct envelope shape, not JSON-RPC. Example:
\`\`\`bash
curl -s -X POST http://127.0.0.1:${RPC_PORT}/tools/write-evidence \\
  -H "Authorization: Bearer $MW_RPC_TOKEN" \\
  -H "Content-Type: application/json" \\
  -d '{"requestId":"ev-1","params":{"type":"web-search","label":"known-advisory","description":"Known vulnerability review","data":{"finding":"...","sources":["..."]}}}'

curl -s -X POST http://127.0.0.1:${RPC_PORT}/tools/submit-verdict \\
  -H "Authorization: Bearer $MW_RPC_TOKEN" \\
  -H "Content-Type: application/json" \\
  -d '{"requestId":"verdict-1","params":{"verdict":{"verdict":"quarantine","riskSummary":"...","capabilityDeltas":[],"intentMismatches":[],"exploitHypotheses":[],"scores":{"risk":0.5},"evidenceReferences":["ev-known-advisory"]}}}'
\`\`\`

The container also includes command-line inspection helpers:
- **prettier** — Format minified or bundled JavaScript into readable inspection copies
- **js-beautify** — Alternative JavaScript beautifier for files Prettier cannot parse cleanly

You also have full filesystem access to explore the unpacked package under:
\`/workspace/inputs/package/\`

## Configured Audit Prompt Pack

The following instructions were assembled from ModuleWarden's configured prompt packs.
They are mandatory for this audit; do not replace them with a generic fallback.

${configuredInstructions}

## Requirements

1. Apply every configured prompt-pack instruction above.
2. Explore the package using \`package-info\` and \`source-metadata\`.
3. Run \`web-search\` when prompt packs require advisory, provenance, or public-source checks.
4. Run \`static-checks\` to detect suspicious patterns.
5. Write key findings as \`write-evidence\`.
6. Submit your final verdict with \`submit-verdict\`.
7. Include risk summary, capability findings, evidence references, and prompt-pack provenance.
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
 * Resolve the PI provider configuration from environment.
 *
 * Supports three modes:
 * 1. Explicit provider via MW_MODEL_ENDPOINT_PROVIDER (e.g. "openai", "deepseek", "anthropic")
 * 2. Auto-detection from MW_MODEL_ENDPOINT_BASE_URL (deepseek if URL contains "deepseek", else openai)
 * 3. Custom provider via MW_MODEL_ENDPOINT_CUSTOM_PROVIDER with a models.json path
 */
function resolveProviderConfig(): {
  provider: string;
  model: string;
  apiKey: string;
  baseUrl: string;
  extraEnv: Record<string, string>;
} {
  const baseUrl = process.env.MW_MODEL_ENDPOINT_BASE_URL;
  const model = process.env.MW_MODEL_ENDPOINT_MODEL ?? 'qwen3.6-27b';
  const apiKey = process.env.MW_MODEL_ENDPOINT_API_KEY ?? 'vllm';
  const explicitProvider = process.env.MW_MODEL_ENDPOINT_PROVIDER;

  if (!baseUrl) {
    throw new Error('MW_MODEL_ENDPOINT_BASE_URL is required for agentic audit but was not configured');
  }

  if (explicitProvider) {
    console.log(`[orchestrator] Using explicit provider: ${explicitProvider}`);
    return {
      provider: explicitProvider,
      model,
      apiKey,
      baseUrl,
      extraEnv: resolveProviderEnv(explicitProvider, baseUrl),
    };
  }

  // Auto-detect from base URL
  if (baseUrl.includes('deepseek')) {
    console.log('[orchestrator] Auto-detected provider: deepseek');
    return {
      provider: 'deepseek',
      model: model === 'deepseek-flash-4' ? 'deepseek-v4-flash' : model,
      apiKey,
      baseUrl,
      extraEnv: {},
    };
  }

  if (baseUrl.includes('openai.com') || baseUrl.includes('api.openai')) {
    console.log('[orchestrator] Auto-detected provider: openai');
    return {
      provider: 'openai',
      model,
      apiKey,
      baseUrl,
      extraEnv: { OPENAI_BASE_URL: baseUrl },
    };
  }

  // Default: OpenAI-compatible endpoint (vLLM, Ollama, Leonardo, etc.)
  console.log(`[orchestrator] Using OpenAI-compatible provider for: ${baseUrl}`);
  return {
    provider: 'openai',
    model,
    apiKey,
    baseUrl,
    extraEnv: { OPENAI_BASE_URL: baseUrl },
  };
}

/**
 * Set provider-specific environment variables that PI needs.
 */
function resolveProviderEnv(provider: string, baseUrl: string): Record<string, string> {
  switch (provider) {
    case 'openai':
    case 'openai-compatible':
      return { OPENAI_BASE_URL: baseUrl };
    case 'deepseek':
      // DeepSeek provider in PI reads DEEPSEEK_API_KEY and uses its built-in base URL.
      // If a custom base URL is needed, use the openai provider instead.
      return {};
    default:
      // For custom providers defined in models.json, no extra env needed.
      return {};
  }
}

/**
 * Write a PI models.json for custom provider registration.
 * This allows PI to use arbitrary OpenAI-compatible endpoints with a named provider.
 */
function writePiModelsConfig(baseUrl: string, model: string, apiKey: string): string {
  const piConfigDir = join(homedir(), '.pi', 'agent');
  mkdirSync(piConfigDir, { recursive: true });

  const modelsConfig = {
    providers: {
      'mw-leonardo': {
        baseUrl: baseUrl,
        api: 'openai-completions',
        apiKey: apiKey,
        compat: {
          supportsDeveloperRole: false,
          supportsReasoningEffort: false,
        },
        models: [
          {
            id: model,
            name: `ModuleWarden Leonardo — ${model}`,
            reasoning: false,
            input: ['text'],
            contextWindow: 128000,
            maxTokens: 16384,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          },
        ],
      },
    },
  };

  const configPath = join(piConfigDir, 'models.json');
  writeFileSync(configPath, JSON.stringify(modelsConfig, null, 2));
  console.log(`[orchestrator] Wrote PI models config: ${configPath}`);
  return configPath;
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

  // Resolve model endpoint configuration
  const { provider, model: modelName, apiKey, baseUrl, extraEnv } = resolveProviderConfig();
  const maxTurns = parseInt(process.env.MW_AUDIT_MAX_TURNS ?? '50', 10);
  const maxTokens = parseInt(process.env.MW_MODEL_ENDPOINT_MAX_TOKENS ?? '16384', 10);

  console.log(`[orchestrator] Model endpoint: ${baseUrl}`);
  console.log(`[orchestrator] Provider: ${provider}, Model: ${modelName}`);

  // Write PI models.json for custom provider registration if needed
  writePiModelsConfig(baseUrl, modelName, apiKey);

  // Build PI spawn arguments
  const piArgs: string[] = [
    '--mode', 'rpc',
    '--no-session',
    '--provider', provider,
    '--model', modelName,
    '--api-key', apiKey,
    '--thinking', 'high',
  ];

  // Start PI in RPC mode
  console.log(`[orchestrator] Starting PI RPC session (provider=${provider}, model=${modelName})...`);
  const piProc = spawn('pi', piArgs, {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      ...process.env,
      ...extraEnv,
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

  // Wait for verdict (with configurable timeout)
  const verdictTimeoutMs = parseInt(process.env.MW_AUDIT_TIMEOUT_MS ?? '600000', 10);
  console.log(`[orchestrator] Waiting for verdict (timeout: ${Math.round(verdictTimeoutMs / 1000)}s)...`);
  const verdict = await waitForVerdict(verdictTimeoutMs);
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
