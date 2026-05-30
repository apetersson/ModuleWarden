// ── SignalExtractor tests ─────────────────────────────────────────

import { describe, it, expect } from 'vitest';
import { SignalExtractor } from '../signal-extractor.js';
import type { ForecastArtifact } from '../types.js';

/** Build a minimal forecast.json artifact with quantile bands. */
function makeArtifact(
  forecastSeries: Record<string, { forecast: number; q10: number; q90: number }>,
  horizon: number = 3,
): ForecastArtifact {
  const forecast_series: ForecastArtifact['data']['forecast_series'] = {};
  for (const [key, vals] of Object.entries(forecastSeries)) {
    forecast_series[key] = {
      forecast: vals.forecast,
      quantile_forecast: { '0.1': vals.q10, '0.5': vals.forecast, '0.9': vals.q90 },
    };
  }
  return {
    version: '1.1',
    data: {
      forecast_horizon: horizon,
      forecast_start: Object.keys(forecastSeries)[0] ?? '2026-01-01',
      forecast_end: Object.keys(forecastSeries).at(-1) ?? '2026-03-01',
      forecast_series,
    },
  };
}

describe('SignalExtractor', () => {
  const extractor = new SignalExtractor();

  it('detects collapse_risk when min forecast is below floor', () => {
    const artifact = makeArtifact({
      '2026-01-01': { forecast: 0.2, q10: 0.0, q90: 0.5 },
      '2026-02-01': { forecast: 0.1, q10: 0.0, q90: 0.3 },
      '2026-03-01': { forecast: 0.0, q10: 0.0, q90: 0.1 },
    });
    const signal = extractor.extract(artifact, 'commits', 10, 10);

    expect(signal.collapse_risk).toBe(true);
    expect(signal.min_forecast).toBe(0);
  });

  it('does not flag collapse_risk when above floor', () => {
    const artifact = makeArtifact({
      '2026-01-01': { forecast: 5.0, q10: 3.0, q90: 7.0 },
      '2026-02-01': { forecast: 5.5, q10: 3.5, q90: 7.5 },
      '2026-03-01': { forecast: 6.0, q10: 4.0, q90: 8.0 },
    });
    const signal = extractor.extract(artifact, 'commits', 10, 10);

    expect(signal.collapse_risk).toBe(false);
    expect(signal.min_forecast).toBeCloseTo(5.0);
  });

  it('detects high uncertainty when band width is large relative to mean', () => {
    const artifact = makeArtifact({
      '2026-01-01': { forecast: 5.0, q10: 0.0, q90: 50.0 },
      '2026-02-01': { forecast: 5.0, q10: 0.0, q90: 50.0 },
      '2026-03-01': { forecast: 5.0, q10: 0.0, q90: 50.0 },
    });
    // mean = 5, band width at mid (2nd month) = 50, normalized = 10
    const signal = extractor.extract(artifact, 'commits', 5, 5);

    expect(signal.uncertainty_high).toBe(true);
    expect(signal.uncertainty_score).toBeCloseTo(10);
  });

  it('does not flag uncertainty when band is narrow', () => {
    const artifact = makeArtifact({
      '2026-01-01': { forecast: 10.0, q10: 9.0, q90: 11.0 },
      '2026-02-01': { forecast: 10.0, q10: 9.0, q90: 11.0 },
      '2026-03-01': { forecast: 10.0, q10: 9.0, q90: 11.0 },
    });
    const signal = extractor.extract(artifact, 'commits', 10, 10);

    expect(signal.uncertainty_high).toBe(false);
    expect(signal.uncertainty_score).toBeCloseTo(0.2); // 2/10
  });

  it('handles zero mean by using absolute band width', () => {
    const artifact = makeArtifact({
      '2026-01-01': { forecast: 0.0, q10: 0.0, q90: 0.0 },
      '2026-02-01': { forecast: 0.0, q10: 0.0, q90: 10.0 },
      '2026-03-01': { forecast: 0.0, q10: 0.0, q90: 0.0 },
    });
    const signal = extractor.extract(artifact, 'commits', 0, 0);

    expect(signal.uncertainty_score).toBe(10); // absolute band width
  });

  it('detects recent anomaly when latest actual is outside q10–q90', () => {
    const artifact = makeArtifact({
      '2026-01-01': { forecast: 5.0, q10: 3.0, q90: 7.0 },
      '2026-02-01': { forecast: 5.0, q10: 3.0, q90: 7.0 },
    });
    // latest actual 10.0 is well above q90 of 7.0 for first month
    const signal = extractor.extract(artifact, 'commits', 5, 10);

    expect(signal.recent_anomaly).toBe(true);
    expect(signal.anomaly_detected).toBe(true);
  });

  it('does not flag anomaly when latest actual is within band', () => {
    const artifact = makeArtifact({
      '2026-01-01': { forecast: 5.0, q10: 3.0, q90: 7.0 },
    });
    const signal = extractor.extract(artifact, 'commits', 5, 5);

    expect(signal.recent_anomaly).toBe(false);
    expect(signal.anomaly_detected).toBe(false);
  });

  it('handles missing quantile bands gracefully', () => {
    const artifact: ForecastArtifact = {
      version: '1.1',
      data: {
        forecast_horizon: 1,
        forecast_start: '2026-01-01',
        forecast_end: '2026-01-01',
        forecast_series: {
          '2026-01-01': { forecast: 5.0 },
        },
      },
    };
    const signal = extractor.extract(artifact, 'commits', 5, 5);

    expect(signal.uncertainty_high).toBe(false);
    expect(signal.uncertainty_score).toBe(0);
    expect(signal.recent_anomaly).toBe(false);
    // collapse_risk still works (based on point forecast)
  });

  it('uses correct floor per metric type', () => {
    const artifact = makeArtifact({
      '2026-01-01': { forecast: 0.3, q10: 0.1, q90: 0.5 },
    });
    // commits floor is 0.5 → collapse_risk=true
    const commitSignal = extractor.extract(artifact, 'commits', 1, 0.3);
    expect(commitSignal.collapse_risk).toBe(true);

    // code_quality floor is 0.1 → collapse_risk=false
    const cqSignal = extractor.extract(artifact, 'code_quality', 1, 0.3);
    expect(cqSignal.collapse_risk).toBe(false);
  });

  it('handles empty forecast_series', () => {
    const artifact: ForecastArtifact = {
      version: '1.1',
      data: {
        forecast_horizon: 0,
        forecast_start: '',
        forecast_end: '',
        forecast_series: {},
      },
    };
    const signal = extractor.extract(artifact, 'commits', 10, 10);

    expect(signal.min_forecast).toBe(0);
    expect(signal.collapse_risk).toBe(true); // 0 < 0.5
    expect(signal.uncertainty_score).toBe(0);
  });
});
