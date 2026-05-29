import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

// ⚠️ STUB: Capability extraction is regex-based, not AST-based.
// This means it can match inside strings/comments and is evadable.
// The ARCH-03 comment references AST-based extraction that was planned
// but not implemented. Results should be treated as best-effort signals.
export interface CapabilityFinding {
  category: CapabilityCategory;
  severity: 'high' | 'medium' | 'low';
  description: string;
  files: string[];
  evidence: string[];
}

export type CapabilityCategory =
  | 'network'
  | 'filesystem'
  | 'process'
  | 'dynamic-code'
  | 'env-credential'
  | 'native-wasm'
  | 'obfuscation'
  | 'dependency-indirection'
  | 'install-time';

export interface CapabilityReport {
  findings: CapabilityFinding[];
  summary: Record<CapabilityCategory, 'none' | 'low' | 'medium' | 'high'>;
}

// ── Pattern definitions for static analysis ────────────────

const NETWORK_PATTERNS = [
  { pattern: /require\(['"]http['"]\)/g, description: 'HTTP module required', severity: 'medium' as const },
  { pattern: /require\(['"]https['"]\)/g, description: 'HTTPS module required', severity: 'medium' as const },
  { pattern: /require\(['"]net['"]\)/g, description: 'TCP/net module required', severity: 'high' as const },
  { pattern: /require\(['"]dgram['"]\)/g, description: 'UDP/dgram module required', severity: 'high' as const },
  { pattern: /fetch\(/g, description: 'fetch() API call', severity: 'medium' as const },
  { pattern: /\.request\(/g, description: 'HTTP request method', severity: 'medium' as const },
  { pattern: /WebSocket/g, description: 'WebSocket usage', severity: 'high' as const },
  { pattern: /axios\./g, description: 'Axios HTTP calls', severity: 'low' as const },
  { pattern: /got\(/g, description: 'Got HTTP library', severity: 'low' as const },
];

const FILESYSTEM_PATTERNS = [
  { pattern: /require\(['"]fs['"]\)/g, description: 'Filesystem module required', severity: 'medium' as const },
  { pattern: /\.writeFile(Sync)?\(/g, description: 'File write operation', severity: 'high' as const },
  { pattern: /\.unlink(Sync)?\(/g, description: 'File deletion', severity: 'high' as const },
  { pattern: /\.chmod(Sync)?\(/g, description: 'Permission modification', severity: 'high' as const },
];

const PROCESS_PATTERNS = [
  { pattern: /require\(['"]child_process['"]\)/g, description: 'Child process module required', severity: 'high' as const },
  { pattern: /[.\s]exec\(/g, description: 'exec() call', severity: 'high' as const },
  { pattern: /\.spawn\(/g, description: 'spawn() call', severity: 'high' as const },
  { pattern: /\.execFile\(/g, description: 'execFile() call', severity: 'high' as const },
  { pattern: /\.fork\(/g, description: 'fork() call', severity: 'high' as const },
  { pattern: /process\.kill/g, description: 'Process kill', severity: 'medium' as const },
];

const DYNAMIC_CODE_PATTERNS = [
  { pattern: /\beval\(/g, description: 'eval() call', severity: 'high' as const },
  { pattern: /new Function\(/g, description: 'new Function() constructor', severity: 'high' as const },
  { pattern: /require\(['"]vm['"]\)/g, description: 'VM module required', severity: 'high' as const },
  { pattern: /setTimeout\(['"`]/g, description: 'String-based setTimeout', severity: 'low' as const },
];

const ENV_PATTERNS = [
  { pattern: /process\.env/g, description: 'Environment variable access', severity: 'medium' as const },
  { pattern: /process\.argv/g, description: 'Command-line argument access', severity: 'low' as const },
  { pattern: /process\.config/g, description: 'Node.js config access', severity: 'low' as const },
];

const NATIVE_PATTERNS = [
  { pattern: /require\(['"]node:[a-z]+['"]\)/g, description: 'Node.js built-in (node: prefix)', severity: 'low' as const },
  { pattern: /\.node\b/g, description: 'Native .node binary reference', severity: 'high' as const },
  { pattern: /\.wasm\b/g, description: 'WASM binary reference', severity: 'medium' as const },
  { pattern: /napi/g, description: 'N-API native module', severity: 'medium' as const },
];

const OBFUSCATION_PATTERNS = [
  { pattern: /\bBuffer\.from\([^)]+,\s*'base64'\)/g, description: 'Base64 decoding', severity: 'low' as const },
  { pattern: /\b[\w]{200,}/g, description: 'Very long identifier (possible minified/obfuscated)', severity: 'low' as const },
  { pattern: /String\.fromCharCode/g, description: 'Character code construction', severity: 'low' as const },
  { pattern: /\batob\(/g, description: 'Base64 decode (atob)', severity: 'low' as const },
];

/**
 * Perform static capability extraction on a directory of source files.
 */
export function extractCapabilities(sourceDir: string): CapabilityReport {
  const findings: CapabilityFinding[] = [];

  const sourceFiles = findSourceFiles(sourceDir);
  const allCategories: CapabilityCategory[] = [
    'network', 'filesystem', 'process', 'dynamic-code',
    'env-credential', 'native-wasm', 'obfuscation',
  ];

  const patternSets: Array<{ category: CapabilityCategory; patterns: Array<{ pattern: RegExp; description: string; severity: 'high' | 'medium' | 'low' }> }> = [
    { category: 'network', patterns: NETWORK_PATTERNS },
    { category: 'filesystem', patterns: FILESYSTEM_PATTERNS },
    { category: 'process', patterns: PROCESS_PATTERNS },
    { category: 'dynamic-code', patterns: DYNAMIC_CODE_PATTERNS },
    { category: 'env-credential', patterns: ENV_PATTERNS },
    { category: 'native-wasm', patterns: NATIVE_PATTERNS },
    { category: 'obfuscation', patterns: OBFUSCATION_PATTERNS },
  ];

  for (const { category, patterns } of patternSets) {
    for (const { pattern, description, severity } of patterns) {
      const matchingFiles: string[] = [];
      const evidence: string[] = [];

      for (const file of sourceFiles) {
        try {
          const content = readFileSync(file, 'utf-8');
          const matches = content.match(pattern);

          if (matches && matches.length > 0) {
            matchingFiles.push(relativePath(sourceDir, file));
            evidence.push(matches.slice(0, 3).join(' | ')); // First 3 matches
          }
        } catch {
          // Skip binary files
        }
      }

      if (matchingFiles.length > 0) {
        findings.push({
          category,
          severity,
          description,
          files: matchingFiles,
          evidence,
        });
      }
    }
  }

  // Build summary
  const summary = {} as Record<CapabilityCategory, 'none' | 'low' | 'medium' | 'high'>;
  for (const category of allCategories) {
    const categoryFindings = findings.filter((f) => f.category === category);
    if (categoryFindings.length === 0) {
      summary[category] = 'none';
    } else if (categoryFindings.some((f) => f.severity === 'high')) {
      summary[category] = 'high';
    } else if (categoryFindings.some((f) => f.severity === 'medium')) {
      summary[category] = 'medium';
    } else {
      summary[category] = 'low';
    }
  }

  return { findings, summary };
}

function findSourceFiles(dir: string): string[] {
  try {
    const output = execFileSync('find', [
      dir,
      '-type', 'f',
      '(',
      '-name', '*.js', '-o',
      '-name', '*.jsx', '-o',
      '-name', '*.ts', '-o',
      '-name', '*.tsx', '-o',
      '-name', '*.mjs', '-o',
      '-name', '*.cjs', '-o',
      '-name', '*.mts',
      ')',
    ], {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return output.trim().split('\n').filter(Boolean).sort();
  } catch {
    return [];
  }
}

function relativePath(base: string, full: string): string {
  return full.replace(base, '').replace(/^\//, '');
}
