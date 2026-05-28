import { describe, it, expect } from 'vitest';
import { EVALUATION_CORPUS, filterCorpus, getCorpusStats } from '../services/evaluation-corpus.js';
import { buildReport, type EvaluationResult } from '../services/evaluation-runner.js';

describe('evaluation corpus', () => {
  it('contains entries across all sources', () => {
    const stats = getCorpusStats();
    expect(stats.total).toBeGreaterThan(10);
    expect(stats.bySource.incident).toBeGreaterThanOrEqual(3);
    expect(stats.bySource.fixture).toBeGreaterThanOrEqual(5);
    expect(stats.bySource.benign).toBeGreaterThanOrEqual(3);
  });

  it('has known-malicious packages', () => {
    const malicious = filterCorpus({ source: ['known-malicious'] });
    expect(malicious.length).toBeGreaterThanOrEqual(2);
  });

  it('can filter by expected verdict', () => {
    const blocked = filterCorpus({ expectedVerdict: 'block' });
    const allowed = filterCorpus({ expectedVerdict: 'allow' });
    expect(blocked.length).toBeGreaterThan(0);
    expect(allowed.length).toBeGreaterThan(0);
  });

  it('can filter by tags', () => {
    const networkTags = filterCorpus({ tags: ['network-egress'] });
    expect(networkTags.length).toBeGreaterThanOrEqual(1);
  });

  it('has all entries with valid IDs', () => {
    for (const entry of EVALUATION_CORPUS) {
      expect(entry.id).toBeTruthy();
      expect(entry.packageName).toBeTruthy();
      expect(entry.version).toBeTruthy();
    }
  });
});

describe('evaluation runner', () => {
  it('builds a report with correct metrics', () => {
    const results: EvaluationResult[] = [
      {
        entryId: 'event-stream-1', packageName: 'event-stream', version: '4.0.1',
        actualVerdict: 'BLOCK', matchResult: 'caught', riskSummary: 'Malicious payload',
        findingCount: 3, evidenceCount: 2, durationMs: 1000,
        detectedCapabilities: ['network', 'filesystem'],
      },
      {
        entryId: 'lodash-benign', packageName: 'lodash', version: '4.17.21',
        actualVerdict: 'ALLOW', matchResult: 'correct-allow', riskSummary: 'Clean',
        findingCount: 0, evidenceCount: 1, durationMs: 500,
        detectedCapabilities: [],
      },
      {
        entryId: 'fixture-benign-v1', packageName: 'fixture-benign', version: '1.0.0',
        actualVerdict: 'QUARANTINE', matchResult: 'false-positive-quarantine', riskSummary: 'Suspicious',
        findingCount: 1, evidenceCount: 1, durationMs: 800,
        detectedCapabilities: ['network'],
      },
    ];

    const report = buildReport(results, { mode: 'tool-only', corpusName: 'test' });

    expect(report.summary.caught).toBe(1);
    expect(report.summary.correctAllow).toBe(1);
    expect(report.summary.falsePositiveQuarantine).toBe(1);
    expect(report.summary.errors).toBe(0);

    // Catch rate: 1 caught / 1 expected (only event-stream is expected block)
    expect(report.metrics.catchRate).toBe(1);
    expect(report.metrics.falsePositiveRate).toBe(0.5); // 1 false positive / 2 benign entries
    expect(report.metrics.avgDurationMs).toBeCloseTo(766.67, 0);
  });
});
