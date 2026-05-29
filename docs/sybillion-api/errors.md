# Errors & Limits

Source: https://sybilion.dev/docs/errors
Fetched: 2026-05-29

---

## Validation (`422`)

Write endpoints (`POST /api/v1/forecasts`, `POST /api/v1/drivers`, `POST /api/v1/alerts`) return:

```json
{
  "error": "validation_failed",
  "details": [{ "field": "soft_horizon", "message": "soft_horizon must be between 1 and 12" }]
}
```

Only **one** detail entry is returned per request (**fail-fast**).

> **Note:** JSON type errors (e.g., passing a string for a boolean field like `backtest` or `strictly_positive`) are caught by the JSON decoder before validation runs and return **`400`**, not `422`.

## Payments / balance

Public balance fields are returned in **EUR cents** (`available_eur_cents`, `balance_eur_cents` on [`GET /api/v1/me`](https://sybilion.dev/docs/me)). Some **`402`** bodies use the word **"credits"** in the error text — interpret that as insufficient **available** balance in EUR cents terms.

| Code     | Typical cause                                                                                                                                                                                                                                       | Body                                                                                       |
|----------|-----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|--------------------------------------------------------------------------------------------|
| **`402`** | Your available balance is below the amount the API **reserves (holds)** before running the forecast. The hold is an estimate of the maximum cost; it is released and replaced by the actual charge once the job settles. Top up your balance or wait for in-flight forecast holds to settle. (`POST /api/v1/forecasts`) | `{"error":"insufficient available credits for hold"}` |
| **`402`** | Available balance too low for **drivers** pre-check (`POST /api/v1/drivers`).                                                                                                                                                                       | `{"error":"insufficient credits"}` or `{"error":"insufficient credits: need up to N, have M"}` |
| **`402`** | Available balance too low for **alerts** pre-check (`POST /api/v1/alerts`).                                                                                                                                                                         | `{"error":"insufficient credits"}` or `{"error":"insufficient credits: need up to N, have M"}` |

## Rate limiting & concurrency (`429`)

Each account sits on a [pricing tier](https://sybilion.dev/docs/tiers) that sets three independent caps:

| Cap                                   | Scope      | Where it applies                                                                   |
|---------------------------------------|------------|------------------------------------------------------------------------------------|
| Requests per minute (general)         | Per-minute | Every authenticated `/api/v1/*` request other than `forecasts` and `drivers`.      |
| Requests per minute (sync billed)     | Per-minute | `POST /api/v1/drivers` and `POST /api/v1/alerts`.                                  |
| Concurrent forecast jobs              | Concurrent | In-flight async forecast jobs (`status` in `queued`, `running`).                   |

When a cap is exceeded the API returns **`429`**. For forecast submit:

1.  Per-minute submit rate — message contains **`rate limit`**.
2.  Concurrent-job cap — message **`too many concurrent jobs`**, applied **before** the balance hold succeeds.

**Job list polling (`GET /api/v1/jobs`):** may return **`429`** — wait and/or check your tier in the [Developers Portal](https://sybilion.dev/tiers).

## Holds vs concurrent cap

**Concurrent cap** counts in-flight job statuses (`queued` / `running`). **Balance holds** reduce **`available_eur_cents`** separately — you can hit **`429`** for concurrency while still showing a positive balance, or **`402`** on available balance with zero running jobs if holds are still settling.

## Other status codes

| Code     | When                                                                                                                  |
|----------|-----------------------------------------------------------------------------------------------------------------------|
| **`400`** | Malformed JSON, invalid query params, body validation outside the 422 envelope.                                       |
| **`401`** | Missing or invalid bearer token.                                                                                      |
| **`404`** | Resource not found, not owned by caller, or outside the **post-settlement visibility** window (forecasts / jobs / artifacts). |
| **`409`** | Job not yet completed (artifact download).                                                                            |
| **`413`** | Request body or artifact stream exceeds the size cap (forecast bodies up to **`2 MiB`**; artifact streams up to **`100 MiB`**). |
| **`502`** | Upstream transport failure on `POST /api/v1/drivers` or `POST /api/v1/alerts`.                                        |
| **`503`** | A required backend integration is temporarily unavailable.                                                            |
