# GET /api/v1/forecasts/:id/artifacts/:name — Artifact Download

Source: https://sybilion.dev/docs/forecasts-artifacts
Fetched: 2026-05-29

---

Streams a **single artifact** for the job through the API — callers do not receive direct storage URLs.

Use names exactly as listed in the **`artifacts`** array from `GET /api/v1/forecasts/:id`.

## Call the endpoint

### curl

```bash
JOB_ID="c7f2d8a9-3b4e-5f6a-7c8d-9e0f1a2b3c4d"
curl -sS -H "Authorization: Bearer $SYBILION_API_TOKEN" \
  "https://api.sybilion.dev/api/v1/forecasts/$JOB_ID/artifacts/forecast.json"
```

### Python

```python
data = client.get_forecast_artifact(job_id, "forecast.json")
```

### Go

```go
buf, err := c.GetForecastArtifact(context.Background(), jobID, "forecast.json")
if err != nil { log.Fatal(err) }
```

## Artifact set

A successful forecast produces four files:

| File                         | Always present?       | Notes                                                                 |
|------------------------------|----------------------|-----------------------------------------------------------------------|
| `forecast.json`              | Yes                  | Point + interval forecasts.                                           |
| `external_signals.json`      | Yes                  | Driver / external-signal metadata.                                    |
| `backtest_trajectories.json` | Only when `backtest=true` | Filtered to the **last 12 months** of trajectories — full history is intentionally truncated. |
| `backtest_metrics.json`      | Only when `backtest=true` | Aggregated metrics over rolling 6m / 12m / 24m / 60m windows.         |

Every file has the same envelope:

```json
{ "version": "1.1", "data": {...} }
```

Treat `version` as a contract version; new fields may appear inside `data` at the same major version.

## `forecast.json` — `data` shape

```json
{
  "forecast_series": {
    "2026-05-01": {
      "forecast": 1234.56,
      "quantile_forecast": { "0.1": 1100.0, "0.5": 1234.5, "0.9": 1380.7 }
    }
  },
  "forecast_horizon": 12,
  "forecast_start": "2026-05-01",
  "forecast_end": "2027-04-01"
}
```

`quantile_forecast` is present only for probabilistic runs.

## `external_signals.json` — `data` shape

A map of driver UUID → entry:

```json
{
  "f0e1d2c3-...": {
    "driver_name": "EU industrial production index",
    "importance": {
      "horizon_1": { "0.0": 87.4, "1.0": 65.2 },
      "horizon_2": { "0.0": 80.1 },
      "overall":   { "mean": 73.5, "min": 41.0, "max": 87.4 }
    },
    "direction": {
      "horizon_0": { "0.0": 0.62 },
      "horizon_1": { "0.0": 0.58, "1.0": 0.41 },
      "overall":   { "mean": 0.55, "min": 0.41, "max": 0.62 }
    },
    "pearson_correlation": {
      "overall": { "mean": 0.47, "min": 0.31, "max": 0.59 },
      "lag_6":   0.59,
      "lag_12":  0.31
    }
  }
}
```

Per-entry fields: `driver_name` (human-readable label injected from the recommender), `importance` (per-horizon and overall normalized scores), `direction` (signed correlation per horizon and lag), `pearson_correlation` (per-lag and aggregated). Two fields are intentionally **omitted** to keep payloads small: `normalized_series` and `granger_correlation`.

## `backtest_metrics.json` — `data` shape

```json
{
  "6m":  { "metrics": {...}, "tests": {}, "forecast_start": "...", "forecast_end": "..." },
  "12m": { "metrics": {...}, "tests": {}, "forecast_start": "...", "forecast_end": "..." },
  "24m": { "metrics": {...}, "tests": {}, "forecast_start": "...", "forecast_end": "..." },
  "60m": { "metrics": {...}, "tests": {}, "forecast_start": "...", "forecast_end": "..." }
}
```

Windows with no completed folds are omitted. `metrics` averages each named metric across folds; nested metrics are averaged per sub-key.

## `backtest_trajectories.json` — `data` shape

Array of trajectory objects (one per backtest split), sorted by `forecast_start` ascending:

```json
[
  {
    "forecast_start": "2025-05-01",
    "forecast_end":   "2025-10-01",
    "metrics":        { "mape": 0.061, "rmse": 142.7 },
    "forecast_series": {
      "2025-05-01": { "actual": 1180.0, "forecast": 1163.4 },
      "2025-06-01": { "actual": 1212.5, "forecast": 1207.9 }
    }
  }
]
```

When `backtest=true` was submitted with a probabilistic run, each per-date entry has `quantile_forecast` instead of `forecast` (same shape as in `forecast.json`). `actual` is `null` if no observation existed for that date. Only trajectories whose `forecast_start` falls within the last 12 months of training data are included.

## Common errors

| Code   | Cause                                               | What to do                                                               |
|--------|-----------------------------------------------------|--------------------------------------------------------------------------|
| **`401`** | Missing or invalid bearer token.                  | Check the API key.                                                       |
| **`404`** | Job not found or artifact not available.          | Confirm job status is `completed` before downloading.                    |
| **`409`** | Job has not completed yet.                         | Poll [`GET /api/v1/forecasts/:id`](https://sybilion.dev/docs/forecasts-status) until `status == "completed"`. |
| **`413`** | Artifact exceeds the 100 MiB stream limit.         | Contact support.                                                         |
