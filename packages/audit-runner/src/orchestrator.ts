/**
 * ModuleWarden Structured Audit Orchestrator
 *
 * Runs inside the audit container. Requires an RPC bridge server and a model
 * endpoint; missing prerequisites are fatal because degraded file-only verdicts
 * mask broken agentic audit wiring.
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
 *   MW_MODEL_ENDPOINT_PROVIDER  - Endpoint/provider label (default: mw-leonardo for OpenAI-compatible endpoints)
 *   MW_MODEL_ENDPOINT_MAX_TOKENS- Override max output tokens (default: 2048)
 */
import { appendFileSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import type { AuditVerdict, RpcToolResult } from '@modulewarden/shared/services/rpc-tools';

const RPC_PORT = parseInt(process.env.MW_RPC_PORT ?? '9090', 10);
const RPC_TOKEN = process.env.MW_RPC_TOKEN ?? randomBytes(16).toString('hex');
const WORKSPACE = process.env.MW_WORKSPACE ?? '/workspace';
const PACKAGE_NAME = process.env.MW_PACKAGE_NAME ?? 'unknown';
const PACKAGE_VERSION = process.env.MW_PACKAGE_VERSION ?? 'unknown';
const OUTPUT_DIR = join(WORKSPACE, 'output');
const DEFAULT_MODEL_MAX_TOKENS = 4096;
const PROMPT_BUDGETS = {
  instructions: 4_000,
  packageInfo: 3_000,
  sourceMetadata: 3_000,
  staticChecks: 4_500,
  advisorySearch: 2_500,
} as const;

interface ProviderConfig {
  provider: string;
  model: string;
  apiKey: string;
  baseUrl: string;
}

interface CollectedEvidence {
  packageInfo: Record<string, unknown>;
  sourceMetadata: Record<string, unknown>;
  staticChecks: Record<string, unknown>;
  advisorySearch: Record<string, unknown>;
  evidenceReferences: string[];
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function truncateForPrompt(value: unknown, maxChars = 12_000): string {
  const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}\n...[truncated ${text.length - maxChars} chars]`;
}

async function callRpcTool(tool: string, params: Record<string, unknown>, requestId: string): Promise<RpcToolResult> {
  const response = await fetch(`http://127.0.0.1:${RPC_PORT}/tools/${tool}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${RPC_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ requestId, params }),
  });

  if (!response.ok) {
    throw new Error(`RPC tool ${tool} returned HTTP ${response.status}`);
  }

  return await response.json() as RpcToolResult;
}

async function requireRpcTool(tool: string, params: Record<string, unknown>, requestId: string): Promise<Record<string, unknown>> {
  const result = await callRpcTool(tool, params, requestId);
  if (!result.success) {
    throw new Error(`RPC tool ${tool} failed: ${result.error ?? 'unknown error'}`);
  }
  return result.data ?? {};
}

async function writeEvidence(
  type: 'static-analysis' | 'sandbox-trace' | 'web-search' | 'pi-session-log' | 'pi-session-artifact' | 'other',
  label: string,
  description: string,
  data: Record<string, unknown>
): Promise<string> {
  const result = await requireRpcTool('write-evidence', {
    type,
    label,
    description,
    data,
  }, `evidence-${label}-${Date.now()}`);

  const evidenceId = result.evidenceId;
  return typeof evidenceId === 'string' ? evidenceId : `ev-${label}`;
}

async function collectRequiredEvidence(): Promise<CollectedEvidence> {
  console.log('[orchestrator] Collecting required RPC evidence...');
  const evidenceReferences: string[] = [];

  const packageInfo = await requireRpcTool('package-info', {}, 'package-info-1');
  evidenceReferences.push(await writeEvidence(
    'other',
    'package-info',
    'Package metadata, scripts, dependency summary, and tarball file counts collected by the audit runner.',
    packageInfo
  ));

  const sourceMetadata = await requireRpcTool('source-metadata', {}, 'source-metadata-1');
  evidenceReferences.push(await writeEvidence(
    'other',
    'source-metadata',
    'README/changelog/repository metadata collected by the audit runner.',
    sourceMetadata
  ));

  const staticChecks = await requireRpcTool('static-checks', {}, 'static-checks-1');
  evidenceReferences.push(await writeEvidence(
    'static-analysis',
    'static-checks',
    'Static capability and suspicious-pattern analysis collected by the audit runner.',
    staticChecks
  ));

  const advisoryQuery = `${PACKAGE_NAME} ${PACKAGE_VERSION} npm vulnerability advisory CVE GHSA OSV`;
  let advisorySearch: Record<string, unknown>;
  const advisoryResult = await callRpcTool('web-search', {
    query: advisoryQuery,
    sources: ['advisories'],
  }, 'advisory-search-1');
  if (advisoryResult.success) {
    advisorySearch = {
      query: advisoryQuery,
      results: advisoryResult.data?.results ?? [],
    };
  } else {
    advisorySearch = {
      query: advisoryQuery,
      error: advisoryResult.error ?? 'advisory search failed',
      results: [],
    };
  }
  evidenceReferences.push(await writeEvidence(
    'web-search',
    'advisory-search',
    'Advisory and vulnerability lookup for the exact package/version.',
    advisorySearch
  ));

  writeFileSync(join(OUTPUT_DIR, 'structured-evidence.json'), JSON.stringify({
    packageInfo,
    sourceMetadata,
    staticChecks,
    advisorySearch,
    evidenceReferences,
  }, null, 2));

  console.log(`[orchestrator] Required evidence collected (${evidenceReferences.length} references)`);
  return { packageInfo, sourceMetadata, staticChecks, advisorySearch, evidenceReferences };
}

function buildStructuredVerdictPrompt(evidence: CollectedEvidence): string {
  const configuredInstructions = readFileSync(join(WORKSPACE, 'instructions.md'), 'utf-8');
  return `# ModuleWarden Structured Package Audit

You are auditing **${PACKAGE_NAME}@${PACKAGE_VERSION}** for ModuleWarden.

The audit runner has already executed required RPC tools and persisted evidence artifacts.
Use the evidence below plus the configured prompt-pack instructions to decide whether this exact package version should be allowed, blocked, or quarantined.

Return ONLY a single JSON object matching this schema:
{
  "verdict": "allow" | "block" | "quarantine",
  "riskSummary": "one concise paragraph grounded in the evidence",
  "capabilityDeltas": [{"category":"string","severity":"none|low|medium|high","description":"string","files":["string"],"isNew":true}],
  "intentMismatches": [{"type":"changelog|description|behavior|unknown","description":"string","confidence":"low|medium|high"}],
  "exploitHypotheses": [{"type":"known-pattern|novel|theoretical","description":"string","estimatedImpact":"low|medium|high|critical","estimatedLikelihood":"low|medium|high"}],
  "scores": {"risk": 0.0},
  "evidenceReferences": ${JSON.stringify(evidence.evidenceReferences)}
}

Your first output character must be "{". Your final output character must be "}".
Do not emit <think> blocks, markdown fences, prose, or explanations. If you need
internal reasoning, keep it private and output only the final JSON verdict.

Decision standard:
- "allow" only when the advisory evidence, static checks, package metadata, and source metadata are consistent with benign use.
- "quarantine" when evidence is incomplete, surprising, or ambiguous.
- "block" when the evidence shows credible malicious behavior, secret access, unsafe install/runtime behavior, exploitable vulnerable defaults, or an applicable critical/high advisory.

## Configured Prompt Pack Instructions
${truncateForPrompt(configuredInstructions, PROMPT_BUDGETS.instructions)}

## Evidence References
${JSON.stringify(evidence.evidenceReferences, null, 2)}

## Package Info
${truncateForPrompt(evidence.packageInfo, PROMPT_BUDGETS.packageInfo)}

## Source Metadata
${truncateForPrompt(evidence.sourceMetadata, PROMPT_BUDGETS.sourceMetadata)}

## Static Checks
${truncateForPrompt(evidence.staticChecks, PROMPT_BUDGETS.staticChecks)}

## Advisory Search
${truncateForPrompt(evidence.advisorySearch, PROMPT_BUDGETS.advisorySearch)}
`;
}

function extractJsonObject(text: string): Record<string, unknown> {
  const fencedBlocks = [...text.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)]
    .map((match) => match[1]?.trim())
    .filter((value): value is string => Boolean(value));
  for (const fenced of fencedBlocks.reverse()) {
    try {
      const parsed = JSON.parse(fenced) as unknown;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // Earlier fenced blocks are often illustrative schema snippets. Keep
      // scanning for the final machine-readable verdict.
    }
  }

  const afterThinking = text.includes('</think>')
    ? text.slice(text.lastIndexOf('</think>') + '</think>'.length)
    : text.includes('<think>')
      ? text.slice(0, text.lastIndexOf('<think>'))
      : text;
  const cleaned = afterThinking
    .replace(/^```(?:json)?/i, '')
    .replace(/```$/i, '')
    .trim();

  const candidates: string[] = [];
  let start = -1;
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = 0; i < cleaned.length; i += 1) {
    const char = cleaned[i];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === '\\') {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }

    if (char === '"') {
      inString = true;
      continue;
    }
    if (char === '{') {
      if (depth === 0) start = i;
      depth += 1;
      continue;
    }
    if (char === '}') {
      depth -= 1;
      if (depth === 0 && start !== -1) {
        candidates.push(cleaned.slice(start, i + 1));
        start = -1;
      }
    }
  }

  for (const candidate of candidates.reverse()) {
    try {
      const parsed = JSON.parse(candidate) as unknown;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // Keep scanning earlier balanced objects. Qwen often explains itself
      // before emitting a final valid JSON verdict.
    }
  }

  if (candidates.length === 0) {
    throw new Error(`Model response did not contain a JSON object: ${cleaned.slice(0, 500)}`);
  }

  throw new Error(`Model response did not contain a parseable JSON verdict object: ${cleaned.slice(0, 500)}`);
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.map(String) : [];
}

function normalizeScores(value: unknown): Record<string, number> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const scores: Record<string, number> = {};
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    if (typeof raw === 'number' && Number.isFinite(raw)) scores[key] = raw;
  }
  return scores;
}

function normalizeCapabilityDeltas(value: unknown, staticChecks: Record<string, unknown>): AuditVerdict['capabilityDeltas'] {
  if (Array.isArray(value)) {
    return value.map((item) => {
      const record = item && typeof item === 'object' ? item as Record<string, unknown> : {};
      const severity = ['none', 'low', 'medium', 'high'].includes(String(record.severity))
        ? String(record.severity) as 'none' | 'low' | 'medium' | 'high'
        : 'low';
      return {
        category: String(record.category ?? 'unknown'),
        severity,
        description: String(record.description ?? ''),
        files: asStringArray(record.files),
        isNew: typeof record.isNew === 'boolean' ? record.isNew : true,
      };
    });
  }

  const findings = Array.isArray(staticChecks.findings) ? staticChecks.findings : [];
  return findings.map((item) => {
    const record = item && typeof item === 'object' ? item as Record<string, unknown> : {};
    const severity = ['low', 'medium', 'high'].includes(String(record.severity))
      ? String(record.severity) as 'low' | 'medium' | 'high'
      : 'low';
    return {
      category: String(record.category ?? 'unknown'),
      severity,
      description: String(record.description ?? ''),
      files: asStringArray(record.files),
      isNew: true,
    };
  });
}

function normalizeIntentMismatches(value: unknown): AuditVerdict['intentMismatches'] {
  if (!Array.isArray(value)) return [];
  return value.map((item) => {
    const record = item && typeof item === 'object' ? item as Record<string, unknown> : {};
    const type = ['changelog', 'description', 'behavior', 'unknown'].includes(String(record.type))
      ? String(record.type) as 'changelog' | 'description' | 'behavior' | 'unknown'
      : 'unknown';
    const confidence = ['low', 'medium', 'high'].includes(String(record.confidence))
      ? String(record.confidence) as 'low' | 'medium' | 'high'
      : 'medium';
    return {
      type,
      description: String(record.description ?? ''),
      confidence,
    };
  });
}

function normalizeExploitHypotheses(value: unknown): AuditVerdict['exploitHypotheses'] {
  if (!Array.isArray(value)) return [];
  return value.map((item) => {
    const record = item && typeof item === 'object' ? item as Record<string, unknown> : {};
    const type = ['known-pattern', 'novel', 'theoretical'].includes(String(record.type))
      ? String(record.type) as 'known-pattern' | 'novel' | 'theoretical'
      : 'theoretical';
    const estimatedImpact = ['low', 'medium', 'high', 'critical'].includes(String(record.estimatedImpact))
      ? String(record.estimatedImpact) as 'low' | 'medium' | 'high' | 'critical'
      : 'low';
    const estimatedLikelihood = ['low', 'medium', 'high'].includes(String(record.estimatedLikelihood))
      ? String(record.estimatedLikelihood) as 'low' | 'medium' | 'high'
      : 'low';
    return {
      type,
      description: String(record.description ?? ''),
      estimatedImpact,
      estimatedLikelihood,
    };
  });
}

function normalizeVerdict(raw: Record<string, unknown>, evidence: CollectedEvidence): AuditVerdict {
  const verdict = String(raw.verdict ?? '').toLowerCase();
  if (!['allow', 'block', 'quarantine'].includes(verdict)) {
    throw new Error(`Model returned invalid verdict: ${String(raw.verdict)}`);
  }

  const riskSummary = String(raw.riskSummary ?? raw.summary ?? '').trim();
  if (!riskSummary) {
    throw new Error('Model returned an empty riskSummary');
  }

  const evidenceReferences = [
    ...new Set([
      ...evidence.evidenceReferences,
      ...asStringArray(raw.evidenceReferences),
      ...asStringArray(raw.evidenceRefs),
    ]),
  ];

  return {
    verdict: verdict as AuditVerdict['verdict'],
    riskSummary,
    capabilityDeltas: normalizeCapabilityDeltas(raw.capabilityDeltas, evidence.staticChecks),
    intentMismatches: normalizeIntentMismatches(raw.intentMismatches),
    exploitHypotheses: normalizeExploitHypotheses(raw.exploitHypotheses),
    scores: normalizeScores(raw.scores),
    evidenceReferences,
    piSessionId: `structured-leonardo-${Date.now()}`,
    promptPackVersion: 'structured-rpc-v1',
  };
}

async function callModelForVerdict(config: ProviderConfig, evidence: CollectedEvidence): Promise<AuditVerdict> {
  console.log('[orchestrator] Requesting structured verdict from configured model endpoint...');
  const prompt = buildStructuredVerdictPrompt(evidence);
  writeFileSync(join(OUTPUT_DIR, 'structured-verdict-prompt.md'), prompt);

  const response = await fetch(`${config.baseUrl.replace(/\/$/, '')}/chat/completions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: config.model,
      messages: [
        {
          role: 'system',
          content: 'You are ModuleWarden, a precise npm supply-chain auditor. Return only valid JSON. The first byte of your response must be "{". Do not emit thinking, markdown, prose, or tool_call tags.',
        },
        { role: 'user', content: prompt },
      ],
      temperature: 0,
      max_tokens: parseInt(process.env.MW_MODEL_ENDPOINT_MAX_TOKENS ?? String(DEFAULT_MODEL_MAX_TOKENS), 10),
      stream: false,
    }),
  });

  if (!response.ok) {
    throw new Error(`Model endpoint returned HTTP ${response.status}: ${(await response.text()).slice(0, 500)}`);
  }

  const body = await response.json() as {
    choices?: Array<{ message?: { content?: string }; text?: string }>;
  };
  const content = body.choices?.[0]?.message?.content ?? body.choices?.[0]?.text ?? '';
  writeFileSync(join(OUTPUT_DIR, 'structured-model-response.txt'), content);

  const parsed = extractJsonObject(content);
  const verdict = normalizeVerdict(parsed, evidence);
  console.log(`[orchestrator] Structured verdict received: ${verdict.verdict}`);
  return verdict;
}

async function runStructuredAudit(config: ProviderConfig): Promise<AuditVerdict> {
  const evidence = await collectRequiredEvidence();
  const verdict = await callModelForVerdict(config, evidence);

  const modelEvidenceId = await writeEvidence(
    'pi-session-artifact',
    'structured-model-verdict',
    'Raw structured Leonardo model verdict normalized by the audit runner.',
    {
      verdict,
      model: config.model,
      baseUrl: config.baseUrl,
    }
  );
  verdict.evidenceReferences = [...new Set([...verdict.evidenceReferences, modelEvidenceId])];

  const submitResult = await callRpcTool('submit-verdict', { verdict }, 'submit-verdict-1');
  if (!submitResult.success) {
    throw new Error(`submit-verdict failed: ${submitResult.error ?? 'unknown error'}`);
  }

  console.log(`[orchestrator] Verdict submitted through RPC bridge: ${verdict.verdict}`);
  return verdict;
}

function readRequiredEnv(name: string): string {
  const value = process.env[name];
  if (!value || value.trim() === '') {
    throw new Error(`${name} is required for agentic audit but was not configured`);
  }
  return value.trim();
}

/**
 * Resolve the model endpoint configuration from environment.
 *
 * Supports three modes:
 * 1. Explicit provider via MW_MODEL_ENDPOINT_PROVIDER (e.g. "openai", "deepseek", "anthropic")
 * 2. Auto-detection from MW_MODEL_ENDPOINT_BASE_URL (deepseek/openai only for their official APIs)
 * 3. Custom provider via MW_MODEL_ENDPOINT_CUSTOM_PROVIDER with a models.json path
 */
function resolveProviderConfig(): ProviderConfig {
  const baseUrl = readRequiredEnv('MW_MODEL_ENDPOINT_BASE_URL');
  const model = readRequiredEnv('MW_MODEL_ENDPOINT_MODEL');
  const apiKey = readRequiredEnv('MW_MODEL_ENDPOINT_API_KEY');
  const explicitProvider = process.env.MW_MODEL_ENDPOINT_PROVIDER;

  const isOfficialOpenAiBaseUrl = baseUrl.includes('openai.com') || baseUrl.includes('api.openai');

  if (explicitProvider) {
    if ((explicitProvider === 'openai' || explicitProvider === 'openai-compatible') && !isOfficialOpenAiBaseUrl) {
      throw new Error(
        `Refusing to use PI provider "${explicitProvider}" for non-OpenAI endpoint ${baseUrl}. ` +
        'Use the generated mw-leonardo provider for Leonardo/OpenAI-compatible endpoints.'
      );
    }
    console.log(`[orchestrator] Using explicit provider: ${explicitProvider}`);
    return {
      provider: explicitProvider,
      model,
      apiKey,
      baseUrl,
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
    };
  }

  if (isOfficialOpenAiBaseUrl) {
    console.log('[orchestrator] Auto-detected provider: openai');
    return {
      provider: 'openai',
      model,
      apiKey,
      baseUrl,
    };
  }

  // Default: OpenAI-compatible endpoint (vLLM, llama.cpp, Ollama, Leonardo, etc.).
  // Use an internal provider label for Leonardo/OpenAI-compatible endpoints so
  // placeholder keys such as "not-needed" are never routed to api.openai.com.
  console.log(`[orchestrator] Using generated mw-leonardo provider for OpenAI-compatible endpoint: ${baseUrl}`);
  return {
    provider: 'mw-leonardo',
    model,
    apiKey,
    baseUrl,
  };
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
  writeFileSync(sessionLogPath, [
    JSON.stringify({
      type: 'agent_start',
      runtime: 'structured-rpc',
      note: 'Audit runner collects RPC evidence directly and requests a structured verdict from the configured model endpoint.',
      package: `${PACKAGE_NAME}@${PACKAGE_VERSION}`,
      timestamp: new Date().toISOString(),
    }),
    '',
  ].join('\n'));
  writeFileSync(sessionErrorLogPath, '');

  // Resolve model endpoint configuration
  const providerConfig = resolveProviderConfig();

  console.log(`[orchestrator] Model endpoint: ${providerConfig.baseUrl}`);
  console.log(`[orchestrator] Provider: ${providerConfig.provider}, Model: ${providerConfig.model}`);
  console.log('[orchestrator] Starting structured RPC audit runner...');

  const verdict = await runStructuredAudit(providerConfig);
  appendFileSync(sessionLogPath, JSON.stringify({
    type: 'agent_end',
    runtime: 'structured-rpc',
    verdict: verdict.verdict,
    evidenceReferences: verdict.evidenceReferences,
    timestamp: new Date().toISOString(),
  }) + '\n');

  console.log('[orchestrator] Audit session complete');
  process.exit(0);
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  try {
    mkdirSync(OUTPUT_DIR, { recursive: true });
    writeFileSync(join(OUTPUT_DIR, 'orchestrator-error.txt'), message);
  } catch { /* ignore */ }
  console.error(`[orchestrator] Fatal audit orchestration error: ${message}`);
  process.exit(1);
});
