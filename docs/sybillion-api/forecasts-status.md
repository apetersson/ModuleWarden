# GET /api/v1/forecasts/:id — Job Status

Source: https://sybilion.dev/docs/forecasts-status
Fetched: 2026-05-29

---

Returns status for the forecast job identified by path **`id`** (UUID returned at submit time).

## Call the endpoint

### curl

```bash
JOB_ID="c7f2d8a9-3b4e-5f6a-7c8d-9e0f1a2b3c4d"
curl -sS -H "Authorization: Bearer $SYBILION_API_TOKEN" \
  "https://api.sybilion.dev/api/v1/forecasts/$JOB_ID"
```

### Python

```python
job = client.get_forecast(job_id)
print(job.status, job.eur_cents_final)
```

### Go

```go
job, err := c.GetForecast(context.Background(), jobID)
if err != nil { log.Fatal(err) }
fmt.Println(job.GetStatus(), job.GetEurCentsFinal())
```

## Response

```json
{
  "job_id": "1f2a8b3e-4c5d-46d7-9a01-2b3c4d5e6f70",
  "pipeline_type": "forecast",
  "status": "completed",
  "created_at": "2026-04-30T10:00:00Z",
  "settled_at": "2026-04-30T10:05:42Z",
  "settled": true,
  "eur_cents_final": 3,
  "artifacts": [
    {
      "name": "forecast.json",
      "size": 18342,
      "content_type": "application/json",
      "href": "/api/v1/forecasts/1f2a8b3e-4c5d-46d7-9a01-2b3c4d5e6f70/artifacts/forecast.json"
    }
  ]
}
```

## Field reference

| Field              | Meaning                                                                                                                                                  |
|--------------------|----------------------------------------------------------------------------------------------------------------------------------------------------------|
| `job_id`           | UUID returned at submit. Always present.                                                                                                                 |
| `pipeline_type`    | Always `"forecast"`. Always present.                                                                                                                     |
| `status`           | One of `queued`, `running`, `completed`, `failed`, `canceled`. Always present.                                                                           |
| `created_at`       | RFC3339 timestamp of submit. Always present.                                                                                                             |
| `settled_at`       | RFC3339 timestamp when billing settlement finished, or `null` until then. Always present.                                                                |
| `settled`          | `true` once `settled_at` is set. Always present.                                                                                                         |
| `eur_cents_final`  | Final amount charged after settlement, in EUR cents, or `null` before settlement. Always present.                                                        |
| `terminal_reason`  | Failure / cancellation reason. **Omitted** unless the job ended in `failed` or `canceled` with a reason set.                                              |
| `pipeline_error`   | Optional JSON object with failure details. **Omitted** unless `settled == true`, `status` is `failed` or `canceled`, and a bounded error payload is available (typically up to **64 KiB** JSON). |
| `artifacts`        | Array of `{name, size, content_type, href}`. **Omitted** unless `status == "completed"`, `settled == true`, and at least one artifact is available for download. |
| `workflow_id`, `run_id` | Opaque internal identifiers — **not part of the public API contract**. Do not build logic that depends on their presence or format. You may include them in support requests when asked. |

Use **`GET /api/v1/forecasts/:id/artifacts/:name`** to download bytes (see [Artifacts](https://sybilion.dev/docs/forecasts-artifacts)).

## Common errors

| Code   | Cause                                                            | What to do               |
|--------|------------------------------------------------------------------|--------------------------|
| **`401`** | Missing or invalid bearer token.                               | Check the API key.       |
| **`404`** | Unknown id, not owned by caller, or outside visibility window. | See [Why 404?](#why-404) below. |

## Freshness

Status responses are updated as the job progresses; a terminal state may appear on the next poll shortly after the job finishes.

## Why `404`?

-   Wrong UUID or another user's job.
-   Completed jobs may be hidden from the public API after a **retention / visibility window**. In that case read endpoints return **`404`** even though historical data may still exist on the support side.
