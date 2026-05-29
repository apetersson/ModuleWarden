# POST /api/v1/forecasts — Submit

Source: https://sybilion.dev/docs/forecasts-submit
Fetched: 2026-05-29

---

Starts an **async** forecast job. Returns **`202 Accepted`** with `job_id` (UUID) and `poll_url`.

Before charging: rate limits, concurrent-job cap, and the user's **available balance** for the hold may return **`429`** or **`402`** — see [Errors & limits](https://sybilion.dev/docs/errors). Balances on [`GET /api/v1/me`](https://sybilion.dev/docs/me) (`available_eur_cents`, `balance_eur_cents`) are in EUR cents.

## Request body

Required top-level fields: `pipeline_version`, `frequency`, `recency_factor`, `timeseries_metadata`, `timeseries`. At least one of **`soft_horizon`** or **`hard_horizon`** must be present. Optional: `backtest`, `strictly_positive`, `filters`.

### `pipeline_version`

Must be exactly **`"v1"`** (case-sensitive). No `"latest"` alias.

### `soft_horizon`

Integer **`1`–`12`** inclusive. Optional, but at least one of `soft_horizon` or `hard_horizon` must be present.

The **ideal** forecast horizon in months. The pipeline tries this length first, then steps down one month at a time toward `hard_horizon` (when set) while seeking a quality forecast. When only `soft_horizon` is given and no quality run succeeds, the pipeline falls back to a driverless forecast at `soft_horizon`.

### `hard_horizon`

Integer **`1`–`12`** inclusive. Optional, but at least one of `soft_horizon` or `hard_horizon` must be present.

The **minimum acceptable** horizon in months for the quality step-down ladder. When `hard_horizon` is reached and the pipeline still cannot produce a quality run, it emits a driverless forecast at `hard_horizon`.

When both fields are provided, `hard_horizon` must be **less than or equal to** `soft_horizon` — submitting `hard_horizon > soft_horizon` returns **`422`**.

### `frequency`

Only **`"monthly"`** is supported in v1. `"daily"` / `"weekly"` return a clear **not supported** error; other values return **unknown frequency**.

### `backtest`

Boolean, optional, defaults to **`false`**.

When **`true`**, the pipeline runs a rolling-window backtest evaluation alongside the forecast. Two additional artifacts become available on the settled job:

-   **`backtest_trajectories.json`** — per-fold actual vs forecast series (last 12 months retained).
-   **`backtest_metrics.json`** — aggregated MAPE and RMSE metrics over rolling 6m / 12m / 24m / 60m windows.

### `strictly_positive`

Boolean, optional, defaults to **`false`**.

When **`true`**, the request must satisfy two halves of the same contract:

-   **Input rule (validator):** every value in `timeseries` must be **`>= 0`** (zero is allowed). A single negative observation rejects the request with **`422`**, fail-fast — only the first offending key is reported, with field `timeseries["YYYY-MM-DD"]` and a message naming the value and the flag.
-   **Output behavior (pipeline):** the forecasting pipeline clamps the produced forecast at zero so no output point can be negative.

When **`false`** (or omitted) neither the input rule nor the output clamp is applied; negative observations are accepted and negative forecast points are returned unchanged.

### `recency_factor`

Number **`0.0`–`1.0`** inclusive.

Controls how strongly recent news is used to augment the dataset search with related context. A value closer to **`0.0`** uses a broader historical news window, up to January 2020. A value closer to **`1.0`** places stronger emphasis on recent news, up to the **latest week**.

This has a significant impact on the drivers selected by the system and, consequently, on forecast quality.

### `timeseries_metadata`

| Field         | Rules                                                                 |
|---------------|-----------------------------------------------------------------------|
| `title`       | Required string, byte length **≥ 20** and **≤ 511** (not trimmed).   |
| `description` | Optional; if present, **≤ 2048** bytes.                              |
| `keywords`    | Optional array; if present, **≤ 20** items; each non-empty, each **≤ 255** bytes. |

**Keywords dramatically affect forecast quality**

`keywords` has a significant impact on the drivers selected by the system and, consequently, on the quality of the forecast. Include both direct dataset terms and broader domain knowledge — the more relevant context you provide, the better the driver selection.

**Example — Aluminium Price:**
`aluminium price, aluminium demand, bauxite, alumina, smelting costs, electricity prices, energy-intensive production, Chinese industrial demand, construction activity, automotive demand, inventories, production cuts, sanctions, trade flows, freight costs, macroeconomic indicators`

**Example — Textile Demand:**
`textile demand, apparel demand, clothing sales, retail sales, consumer confidence, disposable income, inflation, fashion retail, e-commerce sales, clothing inventories, import/export flows, manufacturing activity, cotton prices, polyester prices, freight costs, energy costs`

### `filters` (optional, top-level)

If omitted or `null`, the whole object is ignored. When present:

-   **`categories[]` / `regions[]`**: integer dimension ids — see [Regions & categories](https://sybilion.dev/docs/catalog) for valid ids. The API does **not** cross-check them on submit.
-   **`limit`**: optional integer **`0`–`1000`**. Defaults to the maximum when omitted. Has no direct effect on forecast billing; it is forwarded to the pipeline to control how many drivers are considered.

### `timeseries`

Object mapping **`YYYY-MM-DD`** keys → finite numbers.

#### Calendar

Dates use the **Gregorian** calendar. For **`monthly`** frequency, each key must be the **first calendar day of the month** (`YYYY-MM-01`); the API error text refers to this as month alignment. Recency checks compare against **UTC** dates, so accounts in non-UTC timezones see consistent weighting.

1.  Must be **non-empty**.
2.  Values must be **finite** (no NaN/Inf).
3.  Keys must be valid calendar dates; for **`monthly`** frequency, keys must be **aligned** (first day of month — see API error text).
4.  Series must have **no gaps** in the monthly grid (first issue wins).
5.  **Minimum length** depends on **`horizonMax`** (monthly points), where `horizonMax = max(soft_horizon, hard_horizon)`; when only one is given, `horizonMax` equals that value:

| horizonMax | Minimum monthly points |
|------------|----------------------|
| `1`–`3`    | **40**               |
| `4`–`6`    | **60**               |
| `7`–`12`   | **120**              |

6.  **Recency:** the latest observation must be within the **past 12 months** (UTC-relative comparison in the validator).
    
7.  **Intermittent demand:** if the series is classified intermittent (ADI ≥ **`1.32`**, computed as `total_periods / non_zero_periods`), extra rules apply:
    
    -   At least **`60`** monthly points.
    -   At least **`20%`** non-zero values (max intermittency **`0.8`**).
    -   The **top-of-ladder horizon** (`soft_horizon` if set, else `hard_horizon`) restricted to **`3`** or **`6`** only.
    -   Zero detection uses strict equality: small positive floors (e.g. `1e-6` substituted for true zeros) count as non-zero and may bypass this classification.

Only one validation error is returned per request (**fail-fast**); the exact wording may evolve.

## Call the endpoint

Save the request body as `forecast_body.json`, then submit:

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

## Example request body

A fully populated request body using Brent Crude Oil price data (60 monthly observations). Replace `timeseries` with your own data and adjust `timeseries_metadata` accordingly.

```json
{
  "pipeline_version": "v1",
  "frequency": "monthly",
  "soft_horizon": 6,
  "hard_horizon": 3,
  "backtest": true,
  "recency_factor": 0.6,
  "strictly_positive": false,
  "timeseries_metadata": {
    "title": "Brent Crude Oil Price Monthly",
    "description": "Monthly average Brent crude oil spot price in USD/barrel, sourced from EIA.",
    "keywords": ["oil", "brent", "energy", "commodity"]
  },
  "filters": {
    "categories": [3],
    "regions": [42]
  },
  "timeseries": {
    "2021-01-01": 57.64,
    "2021-02-01": 65.02,
    "2021-03-01": 67.24,
    "2021-04-01": 71.07,
    "2021-05-01": 70.25,
    "2021-06-01": 65.50,
    "2021-07-01": 64.25,
    "2021-08-01": 58.96,
    "2021-09-01": 62.01,
    "2021-10-01": 59.87,
    "2021-11-01": 63.43,
    "2021-12-01": 66.52,
    "2022-01-01": 63.65,
    "2022-02-01": 55.66,
    "2022-03-01": 33.73,
    "2022-04-01": 26.63,
    "2022-05-01": 29.85,
    "2022-06-01": 40.80,
    "2022-07-01": 43.51,
    "2022-08-01": 44.98,
    "2022-09-01": 42.96,
    "2022-10-01": 41.53,
    "2022-11-01": 43.72,
    "2022-12-01": 51.22,
    "2023-01-01": 55.30,
    "2023-02-01": 61.19,
    "2023-03-01": 65.36,
    "2023-04-01": 65.79,
    "2023-05-01": 67.77,
    "2023-06-01": 73.93,
    "2023-07-01": 75.53,
    "2023-08-01": 70.82,
    "2023-09-01": 73.54,
    "2023-10-01": 84.36,
    "2023-11-01": 82.60,
    "2023-12-01": 74.62,
    "2024-01-01": 83.39,
    "2024-02-01": 96.84,
    "2024-03-01": 117.25,
    "2024-04-01": 104.64,
    "2024-05-01": 113.03,
    "2024-06-01": 119.18,
    "2024-07-01": 105.58,
    "2024-08-01": 97.88,
    "2024-09-01": 91.68,
    "2024-10-01": 93.60,
    "2024-11-01": 93.47,
    "2024-12-01": 82.66,
    "2025-01-01": 81.14,
    "2025-02-01": 82.80,
    "2025-03-01": 77.91,
    "2025-04-01": 84.94,
    "2025-05-01": 75.52,
    "2025-06-01": 75.29,
    "2025-07-01": 79.60,
    "2025-08-01": 84.77,
    "2025-09-01": 93.39,
    "2025-10-01": 91.05,
    "2025-11-01": 81.77,
    "2025-12-01": 76.10
  }
}
```

## Response

```json
{
  "job_id": "c7f2d8a9-3b4e-5f6a-7c8d-9e0f1a2b3c4d",
  "poll_url": "/api/v1/forecasts/c7f2d8a9-3b4e-5f6a-7c8d-9e0f1a2b3c4d"
}
```

## Field reference

| Field       | Meaning                                                                                    |
|-------------|--------------------------------------------------------------------------------------------|
| `job_id`    | UUID of the submitted job. Use this to poll status and download artifacts.                |
| `poll_url`  | Convenience path equivalent to `GET /api/v1/forecasts/{job_id}`.                           |

`workflow` and `run_id` may also appear in the response — they are opaque internal identifiers, not part of the public API contract.

## Common errors

| Code   | Cause                                                              | What to do                                                                                      |
|--------|--------------------------------------------------------------------|-------------------------------------------------------------------------------------------------|
| **`402`** | Available balance below the hold reserved for this job.          | Top up in the Developers Portal and recheck `available_eur_cents` on [`/me`](https://sybilion.dev/docs/me). |
| **`422`** | Validation failure.                                              | Inspect the `details[0]` field and fix the request.                                             |
| **`429`** | Per-minute submit cap or concurrent-job cap exceeded.            | Wait before retrying. Check tier limits on [`/tiers`](https://sybilion.dev/docs/openapi) or reduce submission frequency. |
| **`413`** | Body over 2 MiB.                                                 | Trim metadata or shorten the time series.                                                       |

For the full catalog of error codes and the JSON envelope, see [Errors & limits](https://sybilion.dev/docs/errors).

## See also

- [GET forecast status](https://sybilion.dev/docs/forecasts-status)
- [Artifacts](https://sybilion.dev/docs/forecasts-artifacts)
- [POST /api/v1/drivers](https://sybilion.dev/docs/drivers) — accepts the same `filters` object
- [Regions & categories](https://sybilion.dev/docs/catalog) — browse valid dimension ids
- [Errors & limits](https://sybilion.dev/docs/errors)
