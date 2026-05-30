// ── Temporal forecast orchestration service ───────────────────────
// Orchestrates the full pipeline: read cached git metrics, live-fetch
// npm downloads, submit Sybillion forecasts, extract signals, and
// produce a temporal_evidence block for the audit dossier.

import { getPrisma } from '@modulewarden/prisma-client';
import { logger } from '@modulewarden/shared/services/logger';
import {
  SybillionClient,
  ForecastSubmitter,
  SignalExtractor,
  CompositeRiskScorer,
  seriesMean,
  SybillionError,
} from '@modulewarden/temporal-forecast';
import type {
  TemporalEvidence,
  MetricType,
  Timeseries,
  ForecastArtifact,
} from '@modulewarden/temporal-forecast';

const NPM_DOWNLOADS_API = 'https://api.npmjs.org/downloads/range';
const METRIC_TYPES: MetricType[] = ['commits', 'contributors', 'code_quality'];

export interface TemporalForecastConfig {
  sybillionToken: string;
  sybillionBaseUrl: string;
  pollIntervalMs: number;
  forecastTimeoutMs: number;
  enabled: boolean;
}

function isEnabled(config: TemporalForecastConfig): boolean {
  return config.enabled && !!config.sybillionToken;
}

/**
 * Fetch monthly npm download counts for a package.
 * Returns a time series of { "YYYY-MM-01": count, ... }.
 */
async function fetchNpmDownloads(
  packageName: string,
): Promise<Timeseries | null> {
  try {
    // Fetch last 5 years of monthly download data
    const endDate = new Date();
    const startDate = new Date(endDate);
    startDate.setFullYear(startDate.getFullYear() - 5);

    const startStr = startDate.toISOString().slice(0, 10);
    const endStr = endDate.toISOString().slice(0, 10);

    const url = `${NPM_DOWNLOADS_API}/${startStr}:${endStr}/${encodeURIComponent(packageName)}`;

    const response = await fetch(url, {
      headers: { Accept: 'application/json' },
    });

    if (!response.ok) {
      logger.warn('npm downloads API returned non-200', {
        packageName,
        status: response.status,
      });
      return null;
    }

    const data = (await response.json()) as {
      downloads?: Array<{ day: string; downloads: number }>;
    };

    if (!data.downloads || data.downloads.length === 0) {
      return null;
    }

    // Aggregate daily downloads into monthly totals
    const monthly: Record<string, number> = {};
    for (const entry of data.downloads) {
      const monthKey = entry.day.slice(0, 7) + '-01';
      monthly[monthKey] = (monthly[monthKey] ?? 0) + entry.downloads;
    }

    return monthly;
  } catch (err) {
    logger.warn('npm downloads fetch failed', {
      packageName,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

/**
 * Run the temporal forecast pipeline for a package version.
 *
 * BLOCKING: waits for Sybillion forecasts to complete (minutes).
 * On any failure, returns null (audit proceeds without temporal signal).
 */
export async function runTemporalForecast(
  packageName: string,
  packageVersion: string,
  config: TemporalForecastConfig,
): Promise<TemporalEvidence | null> {
  if (!isEnabled(config)) {
    logger.info('Temporal forecast disabled, skipping', { packageName });
    return null;
  }

  const prisma = getPrisma();

  // 1. Read cached git metric series
  const cachedMetrics = await prisma.gitMetricCache.findMany({
    where: { packageName, packageVersion },
  });

  // 2. Live-fetch npm downloads
  const downloads = await fetchNpmDownloads(packageName);

  // 3. Assemble available time series
  const availableSeries: Array<{ metric: MetricType; series: Timeseries }> = [];

  for (const cached of cachedMetrics) {
    const metric = cached.metricType as MetricType;
    if (METRIC_TYPES.includes(metric) || metric === 'downloads') {
      const ts = cached.timeseries as Timeseries;
      if (ts && Object.keys(ts).length >= 40) {
        availableSeries.push({ metric, series: ts });
      }
    }
  }

  if (downloads && Object.keys(downloads).length >= 40) {
    availableSeries.push({ metric: 'downloads', series: downloads });
  }

  if (availableSeries.length === 0) {
    logger.info('No valid time series available for temporal forecast', {
      packageName,
      packageVersion,
    });
    return null;
  }

  // 4. Initialize Sybillion pipeline
  const client = new SybillionClient({
    baseUrl: config.sybillionBaseUrl,
    token: config.sybillionToken,
    timeoutMs: config.forecastTimeoutMs,
    pollIntervalMs: config.pollIntervalMs,
  });

  const submitter = new ForecastSubmitter();
  const extractor = new SignalExtractor();
  const scorer = new CompositeRiskScorer();

  // 5. Submit and wait for forecasts (blocking)
  const results: Array<{
    metric: MetricType;
    signal: ReturnType<SignalExtractor['extract']>;
    jobId: string;
  }> = [];

  for (const { metric, series } of availableSeries) {
    try {
      const body = submitter.buildRequest(packageName, metric, series);
      const submitResult = await client.submitForecast(body);

      logger.info('Sybillion forecast submitted', {
        packageName,
        metric,
        jobId: submitResult.job_id,
      });

      const status = await client.waitForCompletion(submitResult.job_id);

      if (status.status !== 'completed') {
        logger.warn('Sybillion forecast did not complete', {
          packageName,
          metric,
          jobId: submitResult.job_id,
          status: status.status,
        });
        continue;
      }

      const artifactBuf = await client.downloadArtifact(
        submitResult.job_id,
        'forecast.json',
      );

      const artifact: ForecastArtifact = JSON.parse(artifactBuf.toString());
      const mean = seriesMean(series);
      const values = Object.values(series);
      const latestActual = values[values.length - 1] ?? 0;

      const signal = extractor.extract(artifact, metric, mean, latestActual);

      results.push({ metric, signal, jobId: submitResult.job_id });

      logger.info('Sybillion forecast completed', {
        packageName,
        metric,
        jobId: submitResult.job_id,
        collapseRisk: signal.collapse_risk,
        uncertaintyHigh: signal.uncertainty_high,
        recentAnomaly: signal.recent_anomaly,
      });
    } catch (err) {
      const message = err instanceof SybillionError
        ? `[${err.code}] ${err.message}`
        : err instanceof Error
          ? err.message
          : String(err);

      logger.warn('Sybillion forecast failed for metric', {
        packageName,
        metric,
        error: message,
      });
      // Continue with remaining metrics
    }
  }

  // 6. Score and return
  if (results.length === 0) {
    logger.info('No Sybillion forecasts completed', { packageName });
    return null;
  }

  const evidence = scorer.score(
    results.map((r) => ({
      metric: r.metric,
      signal: r.signal,
      job_id: r.jobId,
    })),
  );

  logger.info('Temporal forecast evidence produced', {
    packageName,
    temporalRisk: evidence.temporal_risk,
    metricsWithData: Object.keys(evidence.metrics).length,
  });

  return evidence;
}
