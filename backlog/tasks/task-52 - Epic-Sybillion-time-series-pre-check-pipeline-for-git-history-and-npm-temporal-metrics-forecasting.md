---
id: TASK-52
title: >-
  Epic: Sybillion time-series pre-check pipeline for git-history and npm
  temporal metrics forecasting
status: In Progress
assignee: []
created_date: '2026-05-30 11:07'
updated_date: '2026-05-30 11:23'
labels:
  - epic
  - forecast-track
  - sybillion-api
  - temporal-evidence
  - typescript
dependencies: []
priority: high
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Implement a Sybillion time-series pre-check pipeline that extracts git-history metrics (commits, contributors, code-quality signals) and npm download counts as monthly time series, submits them to the Sybillion forecast API, and injects derived temporal risk signals into the ModuleWarden audit dossier. The worker pre-extracts git metrics once per package version into Postgres; the audit container reads cached series, fires Sybillion forecasts (blocking, minutes of latency), and feeds composite temporal risk scores into the LLM as structured evidence.

## Forecast decision rules (deterministic, feeds model)

For each metric time series, extract three signals from the Sybillion forecast output:

| Signal | Computation | Flag if |
|---|---|---|
| Collapse risk | Lowest point forecast across horizon months | Below per-metric floor (e.g., <0.5 commits/month) |
| Uncertainty | Width of 90th-10th quantile band at horizon midpoint, normalized by series mean | Above threshold (model has no idea) |
| Recent anomaly | Latest actual observation outside 80% forecast band for that month | Yes → regime change happened |

Composite temporal risk score: weighted sum of flags per metric, normalized to 0-1, injected into audit dossier as `temporal_evidence`.

## Sybillion forecast parameters

- soft_horizon: 3, hard_horizon: 1
- backtest: false
- strictly_positive: true
- recency_factor: 0.5
- frequency: "monthly"
- pipeline_version: "v1"

## Extraction surface

**Worker pre-extracts (cached in Postgres, per package version):**
- Monthly commit count (git log --since/--until)
- Monthly active contributor count (unique authors per month)
- Monthly code-quality signal changes: CI config presence (boolean → fraction of months with CI), linter config presence, test directory presence

**Audit container live-fetches (npm registry, single API call):**
- Monthly download counts (npm downloads API point-values per month)

## Integration points

1. New TypeScript package: `packages/temporal-forecast/` — Sybillion API client, forecast submission, polling, artifact parsing, signal extraction
2. New Prisma schema models for git metric cache
3. Worker pre-extraction handler (triggered on first-seen package version)
4. Audit container: reads cached git metrics, live-fetches npm downloads, fires forecasts, produces temporal_evidence for dossier
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 packages/temporal-forecast/ scaffolds: package.json, tsconfig.json, src/index.ts, src/sybillion-client.ts, src/forecast-submitter.ts, src/signal-extractor.ts
- [ ] #2 SybillionClient: POST /api/v1/forecasts submit, GET /{id} poll with configurable interval/timeout, GET /{id}/artifacts/{name} download, error handling for 402/422/429/409/404
- [ ] #3 ForecastSubmitter: builds forecast request body per metric (pipeline_version, frequency, soft/hard_horizon, recency_factor, strictly_positive, timeseries_metadata with keywords, timeseries object with YYYY-MM-01 keys)
- [ ] #4 SignalExtractor: parses forecast.json to extract collapse_risk (min point forecast), uncertainty (quantile band width / series mean), recent_anomaly (latest actual vs 80% band); parses backtest_metrics.json when available
- [ ] #5 CompositeRiskScorer: weighted-sum aggregation of per-metric flags into a single temporal_risk score 0-1, with per-metric breakdown included for LLM evidence
- [ ] #6 Prisma schema: GitMetricCache model (packageName, packageVersion, metricType, timeseries JSONB, extractedAt, repoUrl, commitCount), unique constraint on (packageName, packageVersion, metricType)
- [ ] #7 Worker git-extraction handler: triggered on first-seen package version; shallow-clones repo, runs git log analysis for commits/contributors/quality-signals per month, stores in GitMetricCache
- [ ] #8 Worker handler respects GitHub rate limits with exponential backoff; repo URL resolved from npm registry metadata (repository field)
- [ ] #9 Audit container integration: reads cached git series from Prisma, live-fetches npm download counts via npm API, assembles all time series, fires Sybillion forecasts sequentially, produces temporal_evidence block for dossier
- [ ] #10 temporal_evidence dossier block schema: { temporal_risk: number, metrics: { [metricName]: { collapse_risk: bool, uncertainty_high: bool, recent_anomaly: bool, forecast_details: {...} } }, forecast_job_ids: string[] }
- [ ] #11 Error grace: Sybillion 402/429/5xx → temporal_evidence omitted from dossier, audit proceeds without temporal signal; metrics cached in GitMetricCache survive retry on next audit
- [ ] #12 Tests: SybillionClient unit tests with nock for submit/poll/download/errors; ForecastSubmitter tests with static time series; SignalExtractor tests against fixture forecast.json artifacts; CompositeRiskScorer edge-case tests (empty, single-flag, all-flag)
- [ ] #13 Integration test: end-to-end with a small test package (pre-cached git metrics + mocked Sybillion responses), worker → audit container → temporal_evidence in dossier
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
## Overview

Build a `packages/temporal-forecast/` TypeScript package that integrates the Sybillion time-series forecast API into the ModuleWarden audit pipeline. The package provides: (1) a Sybillion API client for async forecast submission/polling/download, (2) time-series construction from cached git metrics + live npm data, (3) deterministic signal extraction from forecast artifacts, and (4) a composite risk scorer. A new Prisma model caches git-extracted metrics. The worker pre-extracts on first-seen package version. The audit container reads cache, fires forecasts (blocking), and injects temporal_evidence into the dossier.

## Phase 1: Scaffold packages/temporal-forecast/

1. Create package directory with package.json (name: @modulewarden/temporal-forecast)
2. tsconfig.json extending ../../tsconfig.base.json
3. Dependencies: the existing @modulewarden/shared for types, ky or undici for HTTP
4. Module structure:
   - src/index.ts — barrel exports
   - src/sybillion-client.ts — SybillionClient class
   - src/forecast-submitter.ts — ForecastSubmitter (builds request bodies)
   - src/signal-extractor.ts — SignalExtractor (parses forecast.json)
   - src/composite-scorer.ts — CompositeRiskScorer (aggregates per-metric flags)
   - src/time-series.ts — helper to validate/format monthly time series
   - src/types.ts — TypeScript types for all Sybillion API shapes and internal types

## Phase 2: SybillionClient

2.1. Constructor takes config: { baseUrl: string, token: string, timeoutMs: number, pollIntervalMs: number }
2.2. submitForecast(body: ForecastRequestV1): Promise<{ jobId: string, pollUrl: string }>
2.3. getJobStatus(jobId: string): Promise<JobStatus> — polls once
2.4. waitForCompletion(jobId: string, timeoutMs?: number): Promise<JobStatus> — polls on interval until settled, returns terminal status; throws on timeout
2.5. downloadArtifact(jobId: string, artifactName: string): Promise<Buffer>
2.6. Error handling: 402 → insufficient balance, 422 → validation with details[0], 429 → rate limited, 404 → not found (or outside visibility window), 409 → not yet completed, 5xx → retryable. All errors surfaced as typed SybillionError with code and detail.

## Phase 3: ForecastSubmitter

3.1. Builds the request body per the Sybillion v1 schema (see docs/sybillion-api/forecasts-submit.md)
3.2. Per-metric keyword sets:
   - commits: ["open source", "software maintenance", "git commits", "developer activity", "code changes"]
   - contributors: ["open source", "contributors", "developer community", "software maintenance", "project health"]
   - code_quality: ["continuous integration", "software testing", "code quality", "automated builds", "devops"]
   - downloads: ["npm", "package registry", "software adoption", "dependency management", "javascript ecosystem"]
3.3. Time series helper validates: YYYY-MM-01 alignment, no gaps, minimum length per horizon (40 for horizon 3), finite values, recency (latest within 12 months)
3.4. Returns ForecastRequestV1 objects ready for SybillionClient

## Phase 4: SignalExtractor

4.1. Parses forecast.json artifact (version 1.1 shape per docs)
4.2. collapseRisk(forecastData): number — minimum point forecast across all horizon months
4.3. uncertainty(forecastData, seriesMean): number — width of 90th-10th quantile band at horizon midpoint, divided by seriesMean for normalization
4.4. recentAnomaly(forecastData, latestActual): boolean — is latestActual outside the q10-q90 band for the first forecast month?
4.5. Per-metric floors (tunable constants): commits < 0.5/month → collapse, contributors < 0.5/month → collapse, downloads floor TBD based on package scale

## Phase 5: CompositeRiskScorer

5.1. Input: Record<metricName, { collapse_risk, uncertainty_high, recent_anomaly }>
5.2. Weights (initial, tunable): collapse_risk=0.4, uncertainty_high=0.2, recent_anomaly=0.4
5.3. Output: temporal_risk 0-1 plus per-metric breakdown
5.4. Empty metrics set → temporal_risk=0, breakdown empty

## Phase 6: Prisma schema

6.1. Add to packages/prisma-client/prisma/schema.prisma:
    model GitMetricCache {
      id            String   @id @default(uuid())
      packageName   String
      packageVersion String
      metricType    String   // "commits" | "contributors" | "code_quality"
      timeseries    Json     // { "YYYY-MM-01": number, ... }
      repoUrl       String?
      commitCount   Int?
      extractedAt   DateTime @default(now())
      
      @@unique([packageName, packageVersion, metricType])
      @@index([packageName, packageVersion])
    }
6.2. Run prisma generate + prisma migrate dev

## Phase 7: Worker git-extraction handler

7.1. Trigger: when worker receives a first-time audit for a package version, check GitMetricCache; if miss, queue extraction job
7.2. Extraction:
    a. Resolve repo URL from npm registry metadata (package.repository.url)
    b. Shallow clone: git clone --depth 1 --single-branch (fast, just needs log)
    c. For commit count: git log --since="YYYY-MM-01" --until="YYYY-MM-01" --format="%H" | wc -l per month going back from latest commit
    d. For contributors: git log --since/--until --format="%aE" | sort -u | wc -l per month
    e. For code_quality: check file existence at each monthly boundary — .github/workflows/*.yml for CI, .eslintrc* for linting, __tests__/ or *.test.* for tests. Store as fraction (0-1) of quality signals present.
7.3. Rate limiting: exponential backoff on GitHub API 429/403, configurable max retries
7.4. Write results to GitMetricCache

## Phase 8: Audit container integration

8.1. On audit start, for the package being audited:
    a. Read all GitMetricCache rows for (packageName, packageVersion)
    b. If any metricType is missing → cache miss, proceed without it (do not block on extraction)
    c. Live-fetch npm download counts for the package (npmjs.org API, last 40-120 months)
    d. Assemble time series for each available metric
8.2. For each assembled time series, call ForecastSubmitter → SybillionClient.submitForecast → SybillionClient.waitForCompletion → SybillionClient.downloadArtifact("forecast.json")
8.3. Pass forecast.json to SignalExtractor for each metric
8.4. Pass all signals to CompositeRiskScorer
8.5. Inject temporal_evidence into dossier
8.6. On any Sybillion error (402/429/5xx/timeout): log warning, omit temporal_evidence, continue audit

## Phase 9: Testing

9.1. Unit: nock-based SybillionClient tests covering submit 202, poll queued/running/completed/failed/canceled, download 200/404/409/413, error 402/422/429/5xx
9.2. Unit: ForecastSubmitter tests with known time series, verify correct request body shape
9.3. Unit: SignalExtractor tests against fixture forecast.json artifacts (both normal and edge: empty quantile, single point, all-same values)
9.4. Unit: CompositeRiskScorer edge cases — empty input, all flags, no flags, mixed, single metric
9.5. Unit: Time series validation — gaps, misalignment, NaN/Inf, too short, recency fail
9.6. Integration: worker→cache write test with a small real git repo; audit container reads cache + mocked Sybillion → temporal_evidence in dossier

## Phase 10: Configuration

10.1. Environment variables:
    - SYBILION_API_TOKEN (required for forecasts)
    - SYBILION_API_BASE_URL (default: https://api.sybilion.dev)
    - SYBILION_POLL_INTERVAL_MS (default: 10000)
    - SYBILION_FORECAST_TIMEOUT_MS (default: 600000, 10 min)
    - TEMPORAL_FORECAST_ENABLED (default: true, set false to skip entirely)
10.2. Add to .env.example

## Notes

- Sybillion API base URL: https://api.sybilion.dev (from docs/sybillion-api/*.md)
- Python SDK exists (from sybilion import Client) but we build TypeScript client because audit container is Node.js
- Driverless fallback: Sybillion pipeline falls back to driverless when no quality driver-based run succeeds. We expect this for software metrics. The forecast still returns point estimates + quantile bands.
- Domain mismatch acknowledged: Sybillion drivers are macroeconomic. We do not fight this; we rely on the driverless fallback and use forecast shapes, not driver quality, for signal.
- The existing dependency_forecast.py (Python) is the per-dependency scoring/rollup for the lazy-employee demo. The new TypeScript package is the Sybillion API integration layer. They are complementary: temporal-forecast produces time-series forecasts; dependency_forecast rolls per-dep probabilities into submission risk.
<!-- SECTION:PLAN:END -->

## Definition of Done
<!-- DOD:BEGIN -->
- [ ] #1 pnpm -r build passes in packages/temporal-forecast/
- [ ] #2 pnpm -r test passes with all 13 acceptance criteria test cases green
- [ ] #3 pnpm -r typecheck passes with no errors
- [ ] #4 Integration test: worker extracts git metrics for a real small npm package, audit container reads cache + fires (mocked) Sybillion forecast, temporal_evidence JSON validates against schema
- [ ] #5 Manual smoke: submit one real Sybillion forecast for a known package time series, verify artifacts download and signal extraction produces valid output
<!-- DOD:END -->
