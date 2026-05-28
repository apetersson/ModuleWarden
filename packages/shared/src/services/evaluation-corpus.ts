/**
 * Evaluation corpus for replay testing.
 *
 * Defines known malicious/benign package entries that can be replayed
 * through the audit pipeline to measure detection quality.
 * Each entry includes: package name, benign predecessor version,
 * malicious/suspicious version, benign control versions, expected
 * behavior, and incident notes.
 */

/**
 * Expected verdict for an evaluation entry.
 */
export type ExpectedVerdict = 'block' | 'quarantine' | 'allow' | 'unknown';

/**
 * A single corpus entry representing a package version to evaluate.
 */
export interface CorpusEntry {
  /** Unique ID for this entry */
  id: string;
  /** Package name on npm */
  packageName: string;
  /** Version to audit */
  version: string;
  /** Benign predecessor version (can be older version or empty for cold-start) */
  predecessorVersion?: string;
  /** Known benign versions of the same package (controls) */
  benignControls?: string[];
  /** What the audit should conclude */
  expectedVerdict: ExpectedVerdict;
  /** CVE/GHSA ID if known */
  cveId?: string;
  /** Source of the entry */
  source: 'incident' | 'known-malicious' | 'suspicious' | 'benign' | 'fixture';
  /** Human-readable notes */
  notes?: string;
  /** Tags for filtering */
  tags?: string[];
}

/**
 * The evaluation corpus — a curated set of package versions for replay testing.
 */
export const EVALUATION_CORPUS: CorpusEntry[] = [
  // ── Known incident replays ────────────────────────────────
  // These are well-documented real-world npm supply-chain attacks.

  {
    id: 'event-stream-1',
    packageName: 'event-stream',
    version: '4.0.1',
    predecessorVersion: '4.0.0',
    expectedVerdict: 'block',
    cveId: 'CVE-2018-16487',
    source: 'incident',
    notes: 'Copay dependency — injected flatmap-stream with malicious payload. Added unexpected network access and cryptocurrency wallet theft.',
    tags: ['dependency-confusion', 'malicious-payload', 'network'],
  },
  {
    id: 'eslint-scope-1',
    packageName: 'eslint-scope',
    version: '3.7.3',
    predecessorVersion: '3.7.2',
    expectedVerdict: 'block',
    cveId: 'GHSA-93f3-23rq-pjfp',
    source: 'incident',
    notes: 'Compromised npm credentials — published malicious version that exfiltrated environment variables via pastebin.',
    tags: ['credential-theft', 'network-egress', 'env-exfiltration'],
  },
  {
    id: 'node-pdf-1',
    packageName: 'node-pdf',
    version: '1.0.0',
    predecessorVersion: '0.1.0',
    expectedVerdict: 'block',
    source: 'known-malicious',
    notes: 'Typo-squatting package — downloaded and exfiltrated SSH keys and config files.',
    tags: ['typosquat', 'credential-theft', 'filesystem'],
  },
  {
    id: 'crossenv-1',
    packageName: 'crossenv',
    version: '1.0.0',
    predecessorVersion: '0.0.1',
    expectedVerdict: 'block',
    source: 'known-malicious',
    notes: 'Typo-squat of cross-env — installed malicious postinstall script that exfiltrated env vars.',
    tags: ['typosquat', 'postinstall', 'credential-theft'],
  },
  {
    id: 'rc-1',
    packageName: 'rc',
    version: '1.2.9',
    predecessorVersion: '1.2.8',
    expectedVerdict: 'quarantine',
    cveId: 'CVE-2022-38900',
    source: 'incident',
    notes: 'Malicious version published via compromised maintainer. Exfiltrated environment variables from CI systems.',
    tags: ['credential-theft', 'env-exfiltration', 'compromised-maintainer'],
  },

  // ── Known malicious packages ──────────────────────────────

  {
    id: 'nobundle-1',
    packageName: 'nobundle',
    version: '0.5.9',
    expectedVerdict: 'block',
    source: 'known-malicious',
    notes: 'Malicious postinstall script — deleted files and displayed ransom message.',
    tags: ['postinstall', 'destructive'],
  },
  {
    id: 'ssl-pak-1',
    packageName: 'ssl-pak',
    version: '1.0.0',
    predecessorVersion: '0.0.1',
    expectedVerdict: 'block',
    source: 'known-malicious',
    notes: 'Typo-squat of ssl-pack — included binary that exfiltrated system info.',
    tags: ['typosquat', 'binary', 'network-egress'],
  },

  // ── Benign controls (should not block) ────────────────────

  {
    id: 'lodash-benign',
    packageName: 'lodash',
    version: '4.17.21',
    expectedVerdict: 'allow',
    source: 'benign',
    notes: 'Widely used utility library. Benign version-diff against predecessor.',
    tags: ['control', 'benign'],
  },
  {
    id: 'express-benign',
    packageName: 'express',
    version: '4.18.2',
    predecessorVersion: '4.18.1',
    expectedVerdict: 'allow',
    source: 'benign',
    notes: 'Popular web framework. Minor patch update.',
    tags: ['control', 'benign'],
  },
  {
    id: 'chalk-benign',
    packageName: 'chalk',
    version: '5.3.0',
    predecessorVersion: '5.2.0',
    expectedVerdict: 'allow',
    source: 'benign',
    notes: 'Terminal styling library. No security concerns.',
    tags: ['control', 'benign'],
  },

  // ── Golden fixtures from capability-delta tests ───────────

  {
    id: 'fixture-malicious-v2',
    packageName: 'fixture-malicious',
    version: '2.0.0',
    predecessorVersion: '1.0.0',
    expectedVerdict: 'block',
    source: 'fixture',
    notes: 'Test fixture: v2 adds network access + eval + file writes + process execution.',
    tags: ['fixture', 'multi-capability'],
  },
  {
    id: 'fixture-benign-v1',
    packageName: 'fixture-benign',
    version: '1.0.0',
    expectedVerdict: 'allow',
    source: 'fixture',
    notes: 'Test fixture: clean utility package with no dangerous capabilities.',
    tags: ['fixture', 'benign'],
  },
  {
    id: 'fixture-benign-diff-v2',
    packageName: 'fixture-benign-diff',
    version: '2.0.0',
    predecessorVersion: '1.0.0',
    expectedVerdict: 'allow',
    source: 'fixture',
    notes: 'Test fixture: v2 only adds a benign dependency (chalk). No capability changes.',
    tags: ['fixture', 'benign-diff'],
  },
  {
    id: 'fixture-obfuscated',
    packageName: 'fixture-obfuscated',
    version: '1.0.0',
    expectedVerdict: 'quarantine',
    source: 'fixture',
    notes: 'Test fixture: obfuscated code with base64, hex encoding, eval, fetch usage.',
    tags: ['fixture', 'obfuscation'],
  },
  {
    id: 'fixture-dependency-only-v2',
    packageName: 'fixture-dependency-only',
    version: '2.0.0',
    predecessorVersion: '1.0.0',
    expectedVerdict: 'quarantine',
    source: 'fixture',
    notes: 'Test fixture: v2 adds postinstall-exec dependency with no code changes.',
    tags: ['fixture', 'dependency-indirection'],
  },
];

/**
 * Filter corpus by criteria.
 */
export function filterCorpus(options: {
  source?: string[];
  tags?: string[];
  expectedVerdict?: ExpectedVerdict;
  packageName?: string;
}): CorpusEntry[] {
  let entries = EVALUATION_CORPUS;
  if (options.source) entries = entries.filter((e) => options.source!.includes(e.source));
  if (options.tags) entries = entries.filter((e) => e.tags?.some((t) => options.tags!.includes(t)));
  if (options.expectedVerdict) entries = entries.filter((e) => e.expectedVerdict === options.expectedVerdict);
  if (options.packageName) entries = entries.filter((e) => e.packageName.includes(options.packageName!));
  return entries;
}

/**
 * Get statistics about the corpus.
 */
export function getCorpusStats(): {
  total: number;
  bySource: Record<string, number>;
  byExpectedVerdict: Record<string, number>;
} {
  const bySource: Record<string, number> = {};
  const byVerdict: Record<string, number> = {};
  for (const entry of EVALUATION_CORPUS) {
    bySource[entry.source] = (bySource[entry.source] ?? 0) + 1;
    byVerdict[entry.expectedVerdict] = (byVerdict[entry.expectedVerdict] ?? 0) + 1;
  }
  return { total: EVALUATION_CORPUS.length, bySource, byExpectedVerdict: byVerdict };
}
