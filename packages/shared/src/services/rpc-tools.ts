/**
 * RPC tool protocol types for the in-container PI audit bridge.
 *
 * The audit RPC bridge server runs inside each isolated Docker container.
 * PI connects to it via custom tools that proxy requests to ModuleWarden's
 * main service or execute tools locally inside the container.
 */

/**
 * Structured verdict produced by the PI audit agent.
 */
export interface AuditVerdict {
  /** The final decision */
  verdict: 'allow' | 'block' | 'quarantine';
  /** Human-readable risk summary */
  riskSummary: string;
  /** Capability deltas detected */
  capabilityDeltas: CapabilityDelta[];
  /** Intent mismatch findings */
  intentMismatches: IntentMismatchFinding[];
  /** Exploit hypotheses */
  exploitHypotheses: ExploitHypothesis[];
  /** Scores for auditability */
  scores: Record<string, number>;
  /** Evidence artifact references */
  evidenceReferences: string[];
  /** Optional PI session metadata */
  piSessionId?: string;
  /** Prompt pack version used */
  promptPackVersion?: string;
}

export interface CapabilityDelta {
  category: string;
  severity: 'none' | 'low' | 'medium' | 'high';
  description: string;
  files: string[];
  isNew: boolean;
}

export interface IntentMismatchFinding {
  type: 'changelog' | 'description' | 'behavior' | 'unknown';
  description: string;
  confidence: 'low' | 'medium' | 'high';
}

export interface ExploitHypothesis {
  type: 'known-pattern' | 'novel' | 'theoretical';
  description: string;
  estimatedImpact: 'low' | 'medium' | 'high' | 'critical';
  estimatedLikelihood: 'low' | 'medium' | 'high';
}

/**
 * RPC tool parameter and response types.
 */

export interface PackageInfoParams {
  /** Optional path to already-unpacked tarball */
  unpackedPath?: string;
}

export interface PackageInfoResponse {
  name: string;
  version: string;
  description: string;
  license: string | null;
  homepage: string | null;
  repository: string | null;
  scripts: Record<string, string>;
  dependencies: Record<string, string>;
  devDependencies: Record<string, string>;
  hasInstallScript: boolean;
  fileCount: number;
  totalSizeBytes: number;
}

export interface PredecessorDiffParams {
  predecessorVersion: string;
  predecessorHash: string;
}

export interface PredecessorDiffResponse {
  hasPredecessor: boolean;
  fileDiff: {
    added: string[];
    removed: string[];
    changed: string[];
    totalAddedBytes: number;
    totalRemovedBytes: number;
  };
  dependencyDiff: {
    added: Record<string, string>;
    removed: Record<string, string>;
    changed: Record<string, { old: string; new: string }>;
  };
  lifecycleScriptDiff: {
    added: string[];
    removed: string[];
    changed: Array<{ name: string; oldCmd: string; newCmd: string }>;
  };
  capabilityDelta: CapabilityDelta[];
}

export interface SourceMetadataResponse {
  readmeSummary: string | null;
  changelogContent: string | null;
  repositoryUrl: string | null;
  homepageUrl: string | null;
  authorName: string | null;
  maintainers: string[];
  issuesUrl: string | null;
  fundingUrl: string | null;
  keywords: string[];
}

export interface StaticCheckResponse {
  findings: Array<{
    category: string;
    severity: 'low' | 'medium' | 'high';
    description: string;
    files: string[];
    evidence: string[];
  }>;
  summary: Record<string, 'none' | 'low' | 'medium' | 'high'>;
  obfuscationDetected: boolean;
  suspiciousPatterns: string[];
}

export interface SandboxExecuteParams {
  command: 'install' | 'import' | 'run-script';
  /** Package name to import (for import command) */
  moduleName?: string;
  /** Script name to run (for run-script) */
  scriptName?: string;
}

export interface SandboxExecuteResponse {
  success: boolean;
  exitCode: number;
  stdout: string;
  stderr: string;
  /** Network connections observed during execution */
  observedNetworkConnections: string[];
  /** Files written during execution */
  observedFileWrites: string[];
  /** Duration in ms */
  durationMs: number;
}

export interface WebSearchParams {
  query: string;
  sources?: string[];
}

export interface WebSearchResponse {
  results: Array<{
    title: string;
    url: string;
    snippet: string;
    source: string;
  }>;
}

export interface WriteEvidenceParams {
  type: 'static-analysis' | 'sandbox-trace' | 'web-search' | 'pi-session-log' | 'pi-session-artifact' | 'other';
  label: string;
  description: string;
  /** Evidence data as JSON-stringifiable object */
  data: Record<string, unknown>;
  /** Optional file paths within the workspace evidence directory */
  filePaths?: string[];
}

export interface WriteEvidenceResponse {
  evidenceId: string;
  artifactCount: number;
}

export interface SubmitVerdictParams {
  verdict: AuditVerdict;
}

export interface SubmitVerdictResponse {
  decisionId: string;
  success: boolean;
}

/**
 * Union of all RPC tool request types keyed by tool name.
 */
export interface RPCToolRequest {
  'package-info': { params: PackageInfoParams };
  'predecessor-diff': { params: PredecessorDiffParams };
  'source-metadata': { params: Record<string, never> };
  'static-checks': { params: Record<string, never> };
  'sandbox-execute': { params: SandboxExecuteParams };
  'web-search': { params: WebSearchParams };
  'write-evidence': { params: WriteEvidenceParams };
  'submit-verdict': { params: SubmitVerdictParams };
}

/**
 * Union of all RPC tool response types keyed by tool name.
 */
export interface RPCToolResponse {
  'package-info': PackageInfoResponse;
  'predecessor-diff': PredecessorDiffResponse;
  'source-metadata': SourceMetadataResponse;
  'static-checks': StaticCheckResponse;
  'sandbox-execute': SandboxExecuteResponse;
  'web-search': WebSearchResponse;
  'write-evidence': WriteEvidenceResponse;
  'submit-verdict': SubmitVerdictResponse;
}

export type RpcToolName = keyof RPCToolRequest;

/**
 * Generic RPC envelope for tool calls.
 */
export interface RpcToolCall {
  tool: RpcToolName;
  requestId: string;
  params: Record<string, unknown>;
}

export interface RpcToolResult {
  tool: RpcToolName;
  requestId: string;
  success: boolean;
  data?: Record<string, unknown>;
  error?: string;
}
