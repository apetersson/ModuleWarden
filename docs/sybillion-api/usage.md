# GET /api/v1/usage - Usage History

Source: https://sybilion.dev/docs/usage
Fetched: 2026-05-30

---

Paginated, read-only usage history scoped to the authenticated user. Each row is
one billed event (an async settlement or a synchronous endpoint charge).

## Query parameters

| Param | Default | Notes |
|-------|---------|-------|
| `page` | `1` | 1-based. |
| `limit` | `50` | 1-200; invalid returns `400`. |
| `sort` | `id` | `id`, `created_at`, `eur_cents_charged`, `credits_charged`, `units`. |
| `order` | `desc` | `asc` / `desc`. |

## Response

```json
{
  "usage_events": [
    {
      "id": 4821,
      "endpoint": "forecast",
      "units": 1,
      "credits_charged": 3,
      "eur_cents_charged": 3,
      "created_at": "2026-04-30T10:05:42Z",
      "async_job_id": "1f2a8b3e-4c5d-46d7-9a01-2b3c4d5e6f70"
    }
  ],
  "pagination": {"page": 1, "limit": 20, "total": 142, "total_pages": 8,
                 "sort": "created_at", "order": "desc"}
}
```

## Field reference

- `endpoint` - billing route key: `forecast`, `drivers`, `alerts` (may be `null`
  on older rows). This confirms the three billed endpoints.
- `units` - metered quantity; item count for per-result billing, `1` for flat-fee.
- `credits_charged` / `eur_cents_charged` - what was debited.
- `async_job_id` - linked async job UUID, or `null` for synchronous calls.

It does NOT return remaining balance or quota, only history. Balance shows on the
portal; the `402` error is the live signal that balance fell below the ceiling.

## Why this matters for us

Confirms the billed surface (`forecast` / `drivers` / `alerts`) and lets us
reconcile demo spend after the fact. Pair with `GET /api/v1/jobs.eur_cents_final`
for the live budget number.

## Errors

| Code | Cause |
|------|-------|
| `400` | Invalid query parameter. |
| `401` | Missing or invalid bearer token. |
