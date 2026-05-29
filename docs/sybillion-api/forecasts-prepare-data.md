# Sybilion Forecasts API — Prepare Data

Source: https://sybilion.dev/docs/features/forecasts#prepare-data
Fetched: 2026-05-29

---

A **forecast** is a model-generated projection of a monthly time series. Results include point estimates with quantile bands, per-driver attributions, and optional rolling-window backtest metrics. The Sybilion pipeline selects the most relevant macroeconomic signals, regional and category dimensions, and fits the best model for the series.

Forecast jobs are **asynchronous**. Submitting a request returns a `job_id` immediately while the pipeline runs in the background, typically finishing within a few minutes. Poll the job status until it is completed, then download the resulting artifact files.

The full process:

1.  **Submit** `POST /api/v1/forecasts` with the time series and metadata to receive a `job_id`.
2.  **Poll** `GET /api/v1/forecasts/{id}` until `status: "completed"`.
3.  **Download** the artifact files listed in the completed job response.

In this page, code examples are shown for curl, the Python SDK, and the Go SDK. For full validation rules and field-level reference, see [Forecast submission](https://sybilion.dev/docs/forecasts-submit), [Forecast status](https://sybilion.dev/docs/forecasts-status), and [Artifact download](https://sybilion.dev/docs/forecasts-artifacts).

## Use cases

-   Forecasting a monthly series of **40+** observations (more for longer horizons, see below).
-   Getting point forecasts with optional quantile bands over **1 to 12** months.
-   Understanding which external drivers impact the series and by how much.
-   Validating forecast quality with rolling backtest metrics.

To get driver recommendations synchronously without running a full forecast, use [Drivers](https://sybilion.dev/docs/features/drivers) instead.

## Prepare data

The timeseries is submitted as a JSON object where each key is a date and the value is a numeric observation. Keys must follow the format `YYYY-MM-DD` and must be the **first day of the month** — any other day-of-month is rejected. The most recent observation must fall within the past 12 months. The minimum number of observations depends on the forecast horizon (`soft_horizon` or `hard_horizon`, whichever is larger):

| Horizon (months) | Minimum observations |
|------------------|---------------------|
| 1–3              | 40                  |
| 4–6              | 60                  |
| 7–12             | 120                 |

We recommend storing the full request body in a JSON file. The file structure looks like this :

```json
{
  "pipeline_version": "v1",
  "frequency": "monthly",
  "recency_factor": 0.6,
  "soft_horizon": 6,
  "backtest": true,
  "timeseries_metadata": {
    "title": "Brent Crude Oil Price Monthly",
    "description": "Monthly average Brent crude oil spot price in USD/barrel, sourced from EIA.",
    "keywords": ["oil", "brent", "energy", "commodity"]
  },
  "timeseries": {
    "2021-01-01": 57.64,
    "2021-02-01": 65.02,
    "2021-03-01": 67.24,
    "...": "...",
    "2025-10-01": 91.05,
    "2025-11-01": 81.77,
    "2025-12-01": 76.10
  }
}
```

Save this as **`forecast_body.json`** — the examples in the next step reference it by filename.

## Submit forecast job

Required fields: `pipeline_version`, `frequency`, `recency_factor`, `timeseries_metadata`, `timeseries`, and at least one of `soft_horizon` or `hard_horizon`.

### curl

```bash
curl -sS -X POST https://api.sybilion.dev/api/v1/forecasts \
  -H "Authorization: Bearer $SYBILION_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d @forecast_body.json
```

### Python

```python
import json
import os

from sybilion import Client

client = Client(token=os.environ["SYBILION_API_TOKEN"])

with open("forecast_body.json", encoding="utf-8") as f:
    body = json.load(f)

submit = client._api.api_v1_forecasts_post(forecast_request_v1=body)
print("job_id:", submit.job_id)
```

### Go

```go
package main

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"os"

	"go.sybilion.dev/sybilion"
	api "go.sybilion.dev/sybilion/api"
)

func main() {
	c := sybilion.New(sybilion.Options{Token: os.Getenv("SYBILION_API_TOKEN")})

	data, err := os.ReadFile("forecast_body.json")
	if err != nil { log.Fatal(err) }
	var body api.ForecastRequestV1
	if err := json.Unmarshal(data, &body); err != nil { log.Fatal(err) }

	acc, err := c.SubmitForecast(context.Background(), body)
	if err != nil { log.Fatal(err) }
	fmt.Println("job_id:", acc.GetJobId())
}
```

A successful submission returns **`202 Accepted`**:

```json
{
  "job_id": "c7f2d8a9-3b4e-5f6a-7c8d-9e0f1a2b3c4d",
  "poll_url": "/api/v1/forecasts/c7f2d8a9-3b4e-5f6a-7c8d-9e0f1a2b3c4d"
}
```

Copy the `job_id`, it is needed to check the forecast job status and download artifacts. Validation errors return **`422`** with one `{field, message}` detail; see [Errors & limits](https://sybilion.dev/docs/errors).

### filters.limit

`filters.limit` controls how many drivers the pipeline considers. A higher limit gives the pipeline more candidates to evaluate, which improves forecast quality but also increases the time the job takes to complete.

## Wait for job to complete

Forecasts typically take a few minutes. Poll `GET /api/v1/forecasts/{id}` until `status` is `completed`. All SDKs provide a helper that handles polling automatically.

### curl

```bash
JOB_ID="c7f2d8a9-3b4e-5f6a-7c8d-9e0f1a2b3c4d"
until curl -sS -H "Authorization: Bearer $SYBILION_API_TOKEN" \
  "https://api.sybilion.dev/api/v1/forecasts/$JOB_ID" \
  | grep -q '"status":"completed"'; do
  sleep 10
done
curl -sS -H "Authorization: Bearer $SYBILION_API_TOKEN" \
  "https://api.sybilion.dev/api/v1/forecasts/$JOB_ID"
```

### Python

```python
job = client.wait_forecast(submit.job_id, poll_s=10.0, timeout_s=3600.0)
print("status:", job.status, "cost (cents):", job.eur_cents_final)
for a in job.artifacts or []:
    print(" -", a.name, a.size, "bytes")
```

### Go

```go
ctx := context.Background()
job, err := c.WaitForecast(ctx, acc.GetJobId(), 10*time.Second)
if err != nil { log.Fatal(err) }
fmt.Println("status:", job.GetStatus(), "cost (cents):", job.GetEurCentsFinal())
for _, a := range job.GetArtifacts() {
    fmt.Println(" -", a.GetName(), a.GetSize(), "bytes")
}
```

When `status` is `completed`, the response lists the artifact files ready to download:

```json
{
  "job_id": "c7f2d8a9-3b4e-5f6a-7c8d-9e0f1a2b3c4d",
  "status": "completed",
  "eur_cents_final": 5,
  "artifacts": [
    {
      "name": "forecast.json",
      "href": "/api/v1/forecasts/c7f2d8a9-3b4e-5f6a-7c8d-9e0f1a2b3c4d/artifacts/forecast.json",
      "content_type": "application/json",
      "size": 4096
    },
    {
      "name": "external_signals.json",
      "href": "/api/v1/forecasts/c7f2d8a9-3b4e-5f6a-7c8d-9e0f1a2b3c4d/artifacts/external_signals.json",
      "content_type": "application/json",
      "size": 2048
    },
    {
      "name": "backtest_metrics.json",
      "href": "/api/v1/forecasts/c7f2d8a9-3b4e-5f6a-7c8d-9e0f1a2b3c4d/artifacts/backtest_metrics.json",
      "content_type": "application/json",
      "size": 1280
    },
    {
      "name": "backtest_trajectories.json",
      "href": "/api/v1/forecasts/c7f2d8a9-3b4e-5f6a-7c8d-9e0f1a2b3c4d/artifacts/backtest_trajectories.json",
      "content_type": "application/json",
      "size": 8192
    }
  ]
}
```

If `status` is `failed` or `canceled`, the response includes a `pipeline_error` object with a `code` and a `detail` field explaining what went wrong.

## Download artifacts

Use the `name` values from the `artifacts` array above. Artifacts are available at `GET /api/v1/forecasts/{id}/artifacts/{name}`.

| File                         | When present         | Contents                                                              |
|------------------------------|---------------------|-----------------------------------------------------------------------|
| `forecast.json`              | Always              | Point forecasts and quantile bands for each horizon month.            |
| `external_signals.json`      | Always              | Ranked external drivers with importance, direction, and correlation scores. |
| `backtest_metrics.json`      | When `backtest: true` | Aggregated accuracy metrics (MAPE, RMSE) over rolling 6m / 12m / 24m / 60m windows. |
| `backtest_trajectories.json` | When `backtest: true` | Per-fold actual vs forecast series for the last 12 months of history. |

### curl

```bash
JOB_ID="c7f2d8a9-3b4e-5f6a-7c8d-9e0f1a2b3c4d"
curl -sS -H "Authorization: Bearer $SYBILION_API_TOKEN" \
  "https://api.sybilion.dev/api/v1/forecasts/$JOB_ID/artifacts/forecast.json"
```

### Python

```python
import json

data = client.get_forecast_artifact(submit.job_id, "forecast.json")
forecast = json.loads(data)
print(forecast["data"]["forecast_series"])
```

### Go

```go
import (
    "io"
    "net/http"
)

jobID := acc.GetJobId()
req, _ := http.NewRequestWithContext(ctx, "GET",
    "https://api.sybilion.dev/api/v1/forecasts/"+jobID+"/artifacts/forecast.json",
    nil,
)
req.Header.Set("Authorization", "Bearer "+os.Getenv("SYBILION_API_TOKEN"))
resp, err := http.DefaultClient.Do(req)
if err != nil { log.Fatal(err) }
defer resp.Body.Close()
buf, _ := io.ReadAll(resp.Body)
fmt.Println(string(buf))
```

### Example `forecast.json` response (6-month horizon, one point shown)

```json
{
  "version": "1.1",
  "data": {
    "forecast_horizon": 6,
    "forecast_start": "2026-01-01",
    "forecast_end": "2026-06-01",
    "forecast_series": {
      "2026-01-01": {
        "forecast": 78.40,
        "quantile_forecast": { "0.1": 68.2, "0.5": 78.4, "0.9": 89.1 }
      },
      "2026-02-01": {
        "forecast": 79.15,
        "quantile_forecast": { "0.1": 68.8, "0.5": 79.2, "0.9": 89.9 }
      }
    }
  }
}
```

For the full schema of all artifact files, see [Artifact download](https://sybilion.dev/docs/forecasts-artifacts).

For error codes, validation details, and the full JSON envelope, see [Forecast submission](https://sybilion.dev/docs/forecasts-submit) and [Errors & limits](https://sybilion.dev/docs/errors).

## Pricing

Billing applies **only on `2xx`** responses. The cost includes a base fee plus a variable component that scales with the time the forecast job takes to complete.

A pre-charge hold is applied when the forecast job is successfully submitted. If there is not enough balance to satisfy the pre-charge hold, the operation is blocked.

## See also

-   API reference: [POST /api/v1/forecasts](https://sybilion.dev/docs/forecasts-submit) · [GET /api/v1/forecasts/:id](https://sybilion.dev/docs/forecasts-status) · [GET /api/v1/forecasts/:id/artifacts/:name](https://sybilion.dev/docs/forecasts-artifacts).
-   Find valid filter ids: [Regions & categories](https://sybilion.dev/docs/features/regions-and-categories).
-   Clients: [Using curl](https://sybilion.dev/docs/using-curl) · [Python SDK](https://sybilion.dev/docs/sdk-python) · [Go SDK](https://sybilion.dev/docs/sdk-go).
