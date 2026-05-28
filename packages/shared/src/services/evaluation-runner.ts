/**
 * Evaluation runner for replay testing.
 *
 * Runs evaluation corpus entries through the audit pipeline and
 * produces quality metrics reports.
 */

import type { CorpusEntry, ExpectedVerdict } from './evaluation-corpus.js';

/**
 * Result from running a single corpus entry through the audit pipeline.
 */
export interface EvaluationResult {
  /** Corpus entry ID */
  entryId: string;
  /** Package audited */
  packageName: string;
  version: string;
  /** What the audit concluded */
  actualVerdict: string | null;
  /** Whether it matched expectations */
  matchResult: 'caught' | 'quarantined' | 'missed' | 'false-positive-block' | 'false-positive-quarantine' | 'correct-allow' | 'error';
  /** Risk summary from the audit */
  riskSummary: string | null;
  /** Finding count */
  findingCount: number;
  /** Evidence artifacts count */
  evidenceCount: number;
  /** Duration in ms */
  durationMs: number;
  /** Error message if the run failed */
  error?: string;
  /** Capability categories detected */
  detectedCapabilities: string[];
}

/**
 * Aggregate evaluation report for a batch of runs.
 */
export interface EvaluationReport {
  /** Date of evaluation */
  date: string;
  /** Corpus used */
  corpusUsed: string;
  /** Run mode */
  mode: 'tool-only' | 'full-pipeline';
  /** Summary counts */
  summary: {
    total: number;
    caught: number;
    quarantined: number;
    missed: number;
    falsePositiveBlock: number;
    falsePositiveQuarantine: number;
    correctAllow: number;
    errors: number;
  };
  /** Per-entry results */
  results: EvaluationResult[];
  /** Quality metrics */
  metrics: {
    catchRate: number;        // Caught / (blocked + quarantined expected)
    quarantineRate: number;   // Quarantined / total
    falsePositiveRate: number; // False positives / total benign
    avgDurationMs: number;
  };
}

/**
 * Convert a verdict to an expected match result.
 */
function classifyMatch(
  expected: ExpectedVerdict,
  actual: string | null
): EvaluationResult['matchResult'] {
  if (!actual) return 'error';
  const a = actual.toLowerCase();

  if (expected === 'block') {
    if (a === 'block') return 'caught';
    if (a === 'quarantine') return 'quarantined';
    return 'missed';
  }

  if (expected === 'quarantine') {
    if (a === 'block' || a === 'quarantine') return 'caught';
    return 'missed';
  }

  if (expected === 'allow') {
    if (a === 'block') return 'false-positive-block';
    if (a === 'quarantine') return 'false-positive-quarantine';
    if (a === 'allow') return 'correct-allow';
    return 'error';
  }

  if (expected === 'unknown') {
    if (a === 'allow') return 'correct-allow';
    return 'quarantined';
  }

  return 'error';
}

/**
 * Collect evaluation results into a report.
 */
export function buildReport(
  results: EvaluationResult[],
  options: { mode: 'tool-only' | 'full-pipeline'; corpusName: string }
): EvaluationReport {
  const summary = {
    total: results.length,
    caught: results.filter((r) => r.matchResult === 'caught').length,
    quarantined: results.filter((r) => r.matchResult === 'quarantined').length,
    missed: results.filter((r) => r.matchResult === 'missed').length,
    falsePositiveBlock: results.filter((r) => r.matchResult === 'false-positive-block').length,
    falsePositiveQuarantine: results.filter((r) => r.matchResult === 'false-positive-quarantine').length,
    correctAllow: results.filter((r) => r.matchResult === 'correct-allow').length,
    errors: results.filter((r) => r.matchResult === 'error').length,
  };

  const totalExpectedBlock = results.filter((r) => {
    const entry = EVALUATION_CORPUS.find((e) => e.id === r.entryId);
    return entry?.expectedVerdict === 'block' || entry?.expectedVerdict === 'quarantine';
  }).length;

  const totalBenign = results.filter((r) => {
    const entry = EVALUATION_CORPUS.find((e) => e.id === r.entryId);
    return entry?.expectedVerdict === 'allow';
  }).length;

  const totalDurationsMs = results.reduce((a, r) => a + r.durationMs, 0);

  const metrics = {
    catchRate: totalExpectedBlock > 0 ? summary.caught / totalExpectedBlock : 0,
    quarantineRate: results.length > 0 ? summary.quarantined / results.length : 0,
    falsePositiveRate: totalBenign > 0
      ? (summary.falsePositiveBlock + summary.falsePositiveQuarantine) / totalBenign
      : 0,
    avgDurationMs: results.length > 0 ? totalDurationsMs / results.length : 0,
  };

  return {
    date: new Date().toISOString(),
    corpusUsed: options.corpusName,
    mode: options.mode,
    summary,
    results,
    metrics,
  };
}

// Local reference for classifyMatch
import { EVALUATION_CORPUS } from './evaluation-corpus.js';
