# GET /api/v1/jobs - List Async Jobs

Source: https://sybilion.dev/docs/jobs
Fetched: 2026-05-30

---

Lists the caller's async jobs. Payload and artifact manifest are omitted; use
`GET /api/v1/forecasts/:id` for full state. Carries the per-job cost, which is
the budget signal for a live demo.

## Query parameters

| Param | Default | Notes |
|-------|---------|-------|
| `page` | `1` | Page number. |
| `limit` | `50` | 1-200. |
| `sort` | `created_at` | `id`, `created_at`, `settled_at`, `eur_cents_final`. |
| `order` | `desc` | `asc` / `desc`. |
| `status` | (none) | `queued`, `running`, `completed`, `failed`, `canceled`. |
| `pipeline_type` | (none) | `forecast` is the only emitted value. |

## Response

```json
{
  "jobs": [
    {
      "job_id": "1f2a8b3e-4c5d-46d7-9a01-2b3c4d5e6f70",
      "pipeline_type": "forecast",
      "status": "completed",
      "created_at": "2026-04-30T10:00:00Z",
      "settled": true,
      "settled_at": "2026-04-30T10:05:42Z",
      "eur_cents_final": 3,
      "terminal_reason": null
    }
  ],
  "pagination": {"page": 1, "limit": 20, "total": 8, "total_pages": 1,
                 "sort": "created_at", "order": "desc"}
}
```

## Field reference

- `job_id` - UUID, use with `GET /api/v1/forecasts/:id`.
- `status` - `queued` / `running` / `completed` / `failed` / `canceled`.
- `settled` / `settled_at` - terminal-and-billed flag plus timestamp.
- `eur_cents_final` - final charge in EUR cents (a forecast settled at 3 cents in
  the doc example), or `null` before settlement.
- `terminal_reason` - failure / cancellation string, or `null`.

## Why this matters for us

`eur_cents_final` is the real per-forecast cost. For the demo we can state the
honest economics: a forecast run costs a few EUR cents, so ranking the whole
dependency tree is cheap. A post-settlement visibility window can filter older
jobs out of this list (the same row that would 404 on the detail endpoint).

## Errors

| Code | Cause | Action |
|------|-------|--------|
| `400` | Invalid query parameter. | Check the parameter table. |
| `401` | Missing or invalid bearer token. | Check the API key. |
| `429` | Rate limit. | Wait, then retry. See `/tiers`. |
