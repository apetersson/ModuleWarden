# POST /api/v1/alerts - Alert Detection

Source: https://sybilion.dev/docs/alerts
Fetched: 2026-05-30

---

Synchronous, billed endpoint. Validates the body, runs alert detection against
the supplied timeseries metadata, and returns the result verbatim. This is the
forecast-native trigger: instead of computing drift ourselves, the API surfaces
the datasets whose trajectory just moved, with the news that moved them.

## Request (`AlertsRequestV1`)

| Field | Rules |
|-------|-------|
| `metadata.title` | Required, 20-511 characters. |
| `metadata.description` | Optional, <= 2048 characters. |
| `metadata.keywords` | Optional, <= 20 items, each <= 255 characters. |
| `context_enriched` | Required boolean. `true` if the metadata is already context-enriched. |
| `date_from` | Optional `YYYY-MM-DD`. Lower bound for detection. |
| `date_to` | Optional `YYYY-MM-DD`. Upper bound. Must be >= `date_from`. |
| `filters` | Optional, same shape as `POST /api/v1/drivers` filters. Ids not cross-checked. |
| `filters.limit` | Optional integer 0-100. How many alerts to return. Default 100. |

## Response

```json
{
  "alerts": [
    {
      "name": "string",
      "pct_change": 0.0,
      "trending": true,
      "news": [
        {
          "title": "string",
          "description": "string",
          "url": "string",
          "published_at": "RFC3339",
          "source_name": "string",
          "category": "string",
          "trending": true
        }
      ]
    }
  ]
}
```

## Field reference

- `alerts[].name` - dataset / index that triggered the alert.
- `alerts[].pct_change` - the percentage change that triggered it. This is the
  trajectory-move signal in one number.
- `alerts[].trending` - whether the alert is currently trending.
- `alerts[].news[]` - the articles associated with the move (title, description,
  url, published_at, source_name, category, trending).

The docs do not publish the exact threshold that fires an alert.

## Why this matters for us

`pct_change` + `trending` is the same trajectory signal `forecast_drift.py`
detects from the forecast series, except the API hands it to us directly and
attaches the news that explains the move. That is a cleaner "agent acts on the
forecast" path: poll alerts on the team's dependency set, and when a dependency
trends, route it up the review queue with the news already attached.

## Errors

| Code | Cause | Action |
|------|-------|--------|
| `402` | Balance below worst-case ceiling. | Top up or reduce `filters.limit`. |
| `422` | Validation failure. | Inspect `details[0]`. |
| `429` | Per-minute cap on synchronous billed calls. | Wait, then retry. See `/tiers`. |
| `502` | Transport error to the engine. | Retry with the same `X-Request-ID`. |
| `503` | Alerts not enabled for this account. | Contact support. |
