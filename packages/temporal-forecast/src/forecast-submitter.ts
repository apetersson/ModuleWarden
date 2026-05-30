// ── Forecast request body builder ─────────────────────────────────
// Builds Sybillion v1 forecast request bodies per metric type.
// Each metric gets tuned keywords and a properly-structured timeseries.

import type {
  ForecastRequestV1,
  MetricType,
  Timeseries,
  TimeseriesMetadata,
} from './types.js';
import { validateTimeseries, seriesMean } from './time-series.js';

/** Per-metric keyword sets for Sybillion driver selection. */
const METRIC_KEYWORDS: Record<MetricType, string[]> = {
  commits: [
    'open source',
    'software maintenance',
    'git commits',
    'developer activity',
    'code changes',
    'software development',
    'version control',
  ],
  contributors: [
    'open source',
    'contributors',
    'developer community',
    'software maintenance',
    'project health',
    'collaboration',
    'developer ecosystem',
  ],
  code_quality: [
    'continuous integration',
    'software testing',
    'code quality',
    'automated builds',
    'devops',
    'software engineering',
    'test coverage',
  ],
  downloads: [
    'npm',
    'package registry',
    'software adoption',
    'dependency management',
    'javascript ecosystem',
    'package downloads',
    'open source usage',
  ],
};

/** Per-metric title templates. */
const METRIC_TITLES: Record<MetricType, (pkgName: string) => string> = {
  commits: (n) => `Monthly commit count for npm package ${n}`,
  contributors: (n) => `Monthly active contributors for npm package ${n}`,
  code_quality: (n) => `Code quality signal fraction for npm package ${n}`,
  downloads: (n) => `Monthly npm download count for package ${n}`,
};

/** Default forecast parameters (aligned with the epic plan). */
const DEFAULT_PARAMS = {
  pipeline_version: 'v1' as const,
  frequency: 'monthly' as const,
  soft_horizon: 3,
  hard_horizon: 1,
  backtest: false,
  strictly_positive: true,
  recency_factor: 0.5,
};

export interface ForecastSubmitterOptions {
  softHorizon?: number;
  hardHorizon?: number;
  backtest?: boolean;
  strictlyPositive?: boolean;
  recencyFactor?: number;
}

/**
 * Builds v1 forecast request bodies for submission to the Sybillion API.
 */
export class ForecastSubmitter {
  private readonly options: Required<ForecastSubmitterOptions>;

  constructor(options: ForecastSubmitterOptions = {}) {
    this.options = {
      softHorizon: options.softHorizon ?? DEFAULT_PARAMS.soft_horizon,
      hardHorizon: options.hardHorizon ?? DEFAULT_PARAMS.hard_horizon,
      backtest: options.backtest ?? DEFAULT_PARAMS.backtest,
      strictlyPositive: options.strictlyPositive ?? DEFAULT_PARAMS.strictly_positive,
      recencyFactor: options.recencyFactor ?? DEFAULT_PARAMS.recency_factor,
    };
  }

  /**
   * Build a forecast request for a single metric and package.
   *
   * @param pkgName - npm package name
   * @param metric - the metric type
   * @param timeseries - pre-validated monthly time series
   * @returns a ForecastRequestV1 ready for SybillionClient
   */
  buildRequest(
    pkgName: string,
    metric: MetricType,
    timeseries: Timeseries,
  ): ForecastRequestV1 {
    const keywords = METRIC_KEYWORDS[metric];
    const title = METRIC_TITLES[metric](pkgName);

    // Validate the timeseries before building.
    const horizonMax = Math.max(this.options.softHorizon, this.options.hardHorizon);
    const { errors } = validateTimeseries(timeseries, {
      frequency: 'monthly',
      horizonMax,
      strictlyPositive: this.options.strictlyPositive,
    });

    if (errors.length > 0) {
      throw new Error(
        `Timeseries validation failed for ${pkgName}:${metric}: ${errors.join('; ')}`,
      );
    }

    const mean = seriesMean(timeseries);

    const metadata: TimeseriesMetadata = {
      title,
      description: `Monthly ${metric} time series for npm package ${pkgName}. Mean: ${mean.toFixed(2)}.`,
      keywords: keywords.length > 0 ? keywords : undefined,
    };

    return {
      pipeline_version: DEFAULT_PARAMS.pipeline_version,
      frequency: DEFAULT_PARAMS.frequency,
      soft_horizon: this.options.softHorizon,
      hard_horizon: this.options.hardHorizon,
      backtest: this.options.backtest,
      strictly_positive: this.options.strictlyPositive,
      recency_factor: this.options.recencyFactor,
      timeseries_metadata: metadata,
      timeseries,
    };
  }
}
