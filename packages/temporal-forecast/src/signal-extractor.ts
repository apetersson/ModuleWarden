// ── Signal extraction from forecast.json artifacts ────────────────
// Parses Sybillion forecast artifacts and extracts three signals:
// collapse_risk, uncertainty, recent_anomaly.

import type { ForecastArtifact, MetricSignal, MetricType } from './types.js';

/** Floor values below which collapse_risk triggers, per metric type. */
const COLLAPSE_FLOORS: Record<MetricType, number> = {
  commits: 0.5,
  contributors: 0.5,
  code_quality: 0.1,
  downloads: 100, // TBD based on package scale — low floor for now
};

/** Threshold above which uncertainty is considered "high". */
const UNCERTAINTY_THRESHOLD = 0.5;

/**
 * Extract three temporal signals from a forecast.json artifact.
 */
export class SignalExtractor {
  /**
   * Extract signals for a single metric from its forecast artifact.
   *
   * @param artifact - parsed forecast.json artifact
   * @param metric - the metric type (used for collapse floor lookup)
   * @param seriesMean - the mean of the original input time series
   * @param latestActual - the most recent actual observation
   * @returns MetricSignal with all three flags
   */
  extract(
    artifact: ForecastArtifact,
    metric: MetricType,
    seriesMean: number,
    latestActual: number,
  ): MetricSignal {
    const data = artifact.data;
    const floor = COLLAPSE_FLOORS[metric];

    const minForecast = this._minPointForecast(data);
    const collapseRisk = minForecast < floor;

    const uncertaintyScore = this._computeUncertainty(data, seriesMean);
    const uncertaintyHigh = uncertaintyScore > UNCERTAINTY_THRESHOLD;

    const anomalyDetected = this._checkRecentAnomaly(data, latestActual);

    return {
      collapse_risk: collapseRisk,
      uncertainty_high: uncertaintyHigh,
      recent_anomaly: anomalyDetected,
      min_forecast: minForecast,
      uncertainty_score: uncertaintyScore,
      anomaly_detected: anomalyDetected,
    };
  }

  /** Find the minimum point forecast across all horizon months. */
  private _minPointForecast(data: ForecastArtifact['data']): number {
    const series = data.forecast_series;
    const values = Object.values(series).map((entry) => entry.forecast);
    if (values.length === 0) return 0;
    return Math.min(...values);
  }

  /**
   * Compute normalized uncertainty: width of 90th–10th quantile band
   * at horizon midpoint, divided by series mean.
   */
  private _computeUncertainty(
    data: ForecastArtifact['data'],
    seriesMean: number,
  ): number {
    const series = data.forecast_series;
    const keys = Object.keys(series);
    if (keys.length === 0) return 0;

    // Use the middle horizon month (or the first if only one).
    const midKey = keys[Math.floor(keys.length / 2)]!;
    const entry = series[midKey];

    if (!entry?.quantile_forecast) {
      // No quantile bands available — can't compute uncertainty.
      return 0;
    }

    const bandWidth = entry.quantile_forecast['0.9'] - entry.quantile_forecast['0.1'];

    if (seriesMean === 0) {
      // If the mean is 0, use absolute band width as uncertainty.
      return bandWidth;
    }

    return bandWidth / Math.abs(seriesMean);
  }

  /**
   * Check if the latest actual observation falls outside the q10–q90
   * band for the first forecast month.
   */
  private _checkRecentAnomaly(
    data: ForecastArtifact['data'],
    latestActual: number,
  ): boolean {
    const series = data.forecast_series;
    const keys = Object.keys(series);
    if (keys.length === 0) return false;

    const firstKey = keys[0]!;
    const entry = series[firstKey];

    if (!entry?.quantile_forecast) {
      // No quantile bands — can't detect anomaly.
      return false;
    }

    const q10 = entry.quantile_forecast['0.1'];
    const q90 = entry.quantile_forecast['0.9'];

    return latestActual < q10 || latestActual > q90;
  }
}
