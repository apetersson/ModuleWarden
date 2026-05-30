// ── Sybillion API TypeScript types ──────────────────────────────
// Mirrors the v1 API surface documented in docs/sybillion-api/*.md
// Source: https://sybilion.dev/docs/forecasts-submit

/** Valid frequency values. Only "monthly" is supported in v1. */
export type Frequency = 'monthly';

/** Valid pipeline version. Must be exactly "v1". */
export type PipelineVersion = 'v1';

/** Valid forecast job status values. */
export type JobStatus =
  | 'queued'
  | 'running'
  | 'completed'
  | 'failed'
  | 'canceled';

/** Supported metric types for time-series extraction. */
export type MetricType = 'commits' | 'contributors' | 'code_quality' | 'downloads';

/** A time-series object mapping YYYY-MM-01 keys to finite numbers. */
export type Timeseries = Record<string, number>;

/** Timeseries metadata required by Sybillion. */
export interface TimeseriesMetadata {
  /** Required string, byte length ≥ 20 and ≤ 511. */
  title: string;
  /** Optional, ≤ 2048 bytes. */
  description?: string;
  /** Optional array, ≤ 20 items, each ≤ 255 bytes. */
  keywords?: string[] | undefined;
}

/** Filters object (optional on forecasts/drivers). */
export interface SybillionFilters {
  /** Integer dimension ids in 1–9999. */
  categories?: number[];
  /** Integer dimension ids in 1–9999. */
  regions?: number[];
  /** 0–1000, forwarded to pipeline. */
  limit?: number;
}

/** Full request body for POST /api/v1/forecasts. */
export interface ForecastRequestV1 {
  pipeline_version: PipelineVersion;
  frequency: Frequency;
  soft_horizon?: number;
  hard_horizon?: number;
  backtest?: boolean;
  strictly_positive?: boolean;
  recency_factor: number;
  timeseries_metadata: TimeseriesMetadata;
  timeseries: Timeseries;
  filters?: SybillionFilters;
}

/** Response from POST /api/v1/forecasts (202 Accepted). */
export interface ForecastSubmitResponse {
  job_id: string;
  poll_url: string;
  /** Opaque internal id — not part of public API contract. */
  workflow?: string;
  /** Opaque internal id — not part of public API contract. */
  run_id?: string;
}

/** Single artifact descriptor from job status response. */
export interface ArtifactDescriptor {
  name: string;
  size: number;
  content_type: string;
  href: string;
}

/** Pipeline error object (present on failed/canceled). */
export interface PipelineError {
  code: string;
  detail: string;
}

/** Response from GET /api/v1/forecasts/:id. */
export interface JobStatusResponse {
  job_id: string;
  pipeline_type: string;
  status: JobStatus;
  created_at: string;
  settled_at: string | null;
  settled: boolean;
  eur_cents_final: number | null;
  terminal_reason?: string;
  pipeline_error?: PipelineError;
  artifacts?: ArtifactDescriptor[];
  workflow_id?: string;
  run_id?: string;
}

/** Single quantile band entry. */
export interface QuantileForecast {
  '0.1': number;
  '0.5': number;
  '0.9': number;
}

/** Per-month forecast entry in forecast.json. */
export interface ForecastMonthEntry {
  forecast: number;
  quantile_forecast?: QuantileForecast;
}

/** The data block inside forecast.json. */
export interface ForecastData {
  forecast_horizon: number;
  forecast_start: string;
  forecast_end: string;
  forecast_series: Record<string, ForecastMonthEntry>;
}

/** Envelope for forecast.json artifact (version 1.1). */
export interface ForecastArtifact {
  version: string;
  data: ForecastData;
}

/** Single signal extracted from a forecast for one metric. */
export interface MetricSignal {
  /** Is the minimum point forecast below the per-metric floor? */
  collapse_risk: boolean;
  /** Is the quantile band unusually wide (high uncertainty)? */
  uncertainty_high: boolean;
  /** Is the latest actual observation outside the 80% forecast band? */
  recent_anomaly: boolean;
  /** Minimum point forecast value (for the collapse_risk check). */
  min_forecast: number;
  /** Normalized uncertainty score (band width / series mean). */
  uncertainty_score: number;
  /** Whether the latest actual was outside the q10–q90 range. */
  anomaly_detected: boolean;
}

/** Per-metric result including raw signal and forecast details. */
export interface MetricResult {
  metric: MetricType;
  signal: MetricSignal;
  /** The Sybillion job_id for this metric's forecast. */
  job_id: string;
}

/** Composite temporal evidence injected into the audit dossier. */
export interface TemporalEvidence {
  /** Weighted aggregation of all metric flags, 0–1. */
  temporal_risk: number;
  /** Per-metric breakdown for LLM evidence. */
  metrics: Record<MetricType, {
    collapse_risk: boolean;
    uncertainty_high: boolean;
    recent_anomaly: boolean;
    min_forecast: number;
    uncertainty_score: number;
    anomaly_detected: boolean;
    job_id: string;
  }>;
  /** All Sybillion job IDs used. */
  forecast_job_ids: string[];
}

/** Configuration for the Sybillion client. */
export interface SybillionClientConfig {
  baseUrl: string;
  token: string;
  /** HTTP request timeout in milliseconds. */
  timeoutMs: number;
  /** Polling interval in milliseconds. */
  pollIntervalMs: number;
}

/** Typed error from the Sybillion API. */
export class SybillionError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number,
    public readonly code?: string,
    public readonly details?: Array<{ field: string; message: string }>,
  ) {
    super(message);
    this.name = 'SybillionError';
  }
}
