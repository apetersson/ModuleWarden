// ── Composite risk scorer ─────────────────────────────────────────
// Aggregates per-metric signals into a single temporal_risk score 0–1.
// Weights are tunable constants.

import type { MetricResult, MetricType, TemporalEvidence } from './types.js';

/** Weights for each signal type (tunable). */
const SIGNAL_WEIGHTS = {
  collapse_risk: 0.4,
  uncertainty_high: 0.2,
  recent_anomaly: 0.4,
};

/**
 * Aggregate per-metric signals into a composite temporal_risk score 0–1
 * and produce the TemporalEvidence block for the audit dossier.
 */
export class CompositeRiskScorer {
  /**
   * Score a set of metric results.
   *
   * @param results - per-metric results from SignalExtractor
   * @returns TemporalEvidence ready for dossier injection
   */
  score(results: MetricResult[]): TemporalEvidence {
    if (results.length === 0) {
      return {
        temporal_risk: 0,
        metrics: {} as Record<MetricType, TemporalEvidence['metrics'][MetricType]>,
        forecast_job_ids: [],
      };
    }

    let weightedSum = 0;
    let totalWeight = 0;

    const metrics = {} as Record<MetricType, TemporalEvidence['metrics'][MetricType]>;
    const jobIds: string[] = [];

    for (const result of results) {
      const { metric, signal, job_id: jobId } = result;
      jobIds.push(jobId);

      // Accumulate weighted flags.
      const flags: Array<keyof typeof SIGNAL_WEIGHTS> = [
        'collapse_risk',
        'uncertainty_high',
        'recent_anomaly',
      ];

      for (const flag of flags) {
        const weight = SIGNAL_WEIGHTS[flag];
        weightedSum += (signal[flag] ? 1 : 0) * weight;
        totalWeight += weight;
      }

      metrics[metric] = {
        collapse_risk: signal.collapse_risk,
        uncertainty_high: signal.uncertainty_high,
        recent_anomaly: signal.recent_anomaly,
        min_forecast: signal.min_forecast,
        uncertainty_score: signal.uncertainty_score,
        anomaly_detected: signal.anomaly_detected,
        job_id: jobId,
      };
    }

    const temporalRisk = totalWeight > 0
      ? Math.min(1, Math.max(0, weightedSum / totalWeight))
      : 0;

    return {
      temporal_risk: Math.round(temporalRisk * 1000) / 1000, // round to 3 decimals
      metrics,
      forecast_job_ids: jobIds,
    };
  }
}
