// ── CompositeRiskScorer tests ─────────────────────────────────────

import { describe, it, expect } from 'vitest';
import { CompositeRiskScorer } from '../composite-scorer.js';
import type { MetricResult } from '../types.js';

function makeResult(
  metric: 'commits' | 'contributors' | 'code_quality' | 'downloads',
  flags: { collapse_risk?: boolean; uncertainty_high?: boolean; recent_anomaly?: boolean },
): MetricResult {
  return {
    metric,
    signal: {
      collapse_risk: flags.collapse_risk ?? false,
      uncertainty_high: flags.uncertainty_high ?? false,
      recent_anomaly: flags.recent_anomaly ?? false,
      min_forecast: 5,
      uncertainty_score: flags.uncertainty_high ? 0.8 : 0.2,
      anomaly_detected: flags.recent_anomaly ?? false,
    },
    job_id: `job-${metric}-123`,
  };
}

describe('CompositeRiskScorer', () => {
  const scorer = new CompositeRiskScorer();

  it('returns 0 for empty results', () => {
    const evidence = scorer.score([]);
    expect(evidence.temporal_risk).toBe(0);
    expect(Object.keys(evidence.metrics)).toHaveLength(0);
    expect(evidence.forecast_job_ids).toHaveLength(0);
  });

  it('returns 0 when no flags are set', () => {
    const evidence = scorer.score([
      makeResult('commits', {}),
      makeResult('contributors', {}),
    ]);
    expect(evidence.temporal_risk).toBe(0);
  });

  it('returns 1 when all flags are set on all metrics', () => {
    const evidence = scorer.score([
      makeResult('commits', { collapse_risk: true, uncertainty_high: true, recent_anomaly: true }),
      makeResult('contributors', { collapse_risk: true, uncertainty_high: true, recent_anomaly: true }),
    ]);

    // Each metric has 3 flags: weights 0.4+0.2+0.4 = 1.0
    // Two metrics, each fully flagged: (1.0+1.0)/2 = 1.0
    expect(evidence.temporal_risk).toBe(1);
  });

  it('weights collapse_risk and recent_anomaly higher than uncertainty', () => {
    // Only collapse_risk: weight 0.4 / total per metric 1.0 = 0.4
    const evidence = scorer.score([
      makeResult('commits', { collapse_risk: true }),
    ]);
    expect(evidence.temporal_risk).toBeCloseTo(0.4);
  });

  it('handles single metric with partial flags', () => {
    // collapse(0.4) + anomaly(0.4) = 0.8 out of 1.0
    const evidence = scorer.score([
      makeResult('commits', { collapse_risk: true, recent_anomaly: true }),
    ]);
    expect(evidence.temporal_risk).toBeCloseTo(0.8);
  });

  it('handles mixed metrics with different flag counts', () => {
    const results: MetricResult[] = [
      makeResult('commits', { collapse_risk: true, recent_anomaly: true }),
      makeResult('contributors', {}),
      makeResult('code_quality', { uncertainty_high: true }),
    ];

    // Per metric weights: 0.4+0.2+0.4 = 1.0
    // commits: 0.4 + 0.4 = 0.8
    // contributors: 0
    // code_quality: 0.2
    // total weighted = 0.8+0+0.2 = 1.0
    // total weight = 1.0+1.0+1.0 = 3.0
    // risk = 1.0/3.0 ≈ 0.333
    const evidence = scorer.score(results);
    expect(evidence.temporal_risk).toBeCloseTo(0.333, 2);
  });

  it('collects all job IDs', () => {
    const evidence = scorer.score([
      makeResult('commits', {}),
      makeResult('downloads', {}),
    ]);
    expect(evidence.forecast_job_ids).toEqual(['job-commits-123', 'job-downloads-123']);
  });

  it('rounds temporal_risk to 3 decimal places', () => {
    const evidence = scorer.score([
      makeResult('commits', { collapse_risk: true }),
    ]);
    // 0.4 exactly
    expect(evidence.temporal_risk).toBe(0.4);
  });

  it('clamps to max 1 even if weights exceed 1', () => {
    // Force high by giving all flags across multiple metrics
    const results = [
      makeResult('commits', { collapse_risk: true, uncertainty_high: true, recent_anomaly: true }),
      makeResult('contributors', { collapse_risk: true, uncertainty_high: true, recent_anomaly: true }),
      makeResult('downloads', { collapse_risk: true, uncertainty_high: true, recent_anomaly: true }),
    ];
    const evidence = scorer.score(results);
    expect(evidence.temporal_risk).toBe(1);
  });
});
