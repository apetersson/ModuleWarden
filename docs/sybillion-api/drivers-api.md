# POST /api/v1/drivers — Sync Driver Recommendations

Source: https://sybilion.dev/docs/drivers
Fetched: 2026-05-29

---

**Synchronous** endpoint that validates the body, runs the drivers / signal recommendations engine, and returns the response **verbatim**.

## Request (`RecommendRequestV1`)

| Field                 | Rules                                                                                                           |
|-----------------------|-----------------------------------------------------------------------------------------------------------------|
| `version`             | Must be **`"v1"`**. Used **only** to pick the validator — **stripped** before the upstream call.                |
| `recency_factor`      | **Optional.** When present, **`0.0`–`1.0`**. When omitted, defaults to **`0.5`**.                               |
| `timeseries_metadata` | Same title/description/keywords rules as forecasts (`title` 20–511 bytes, etc.).                                |
| `filters`             | Optional — same JSON shape and validation as forecast [`filters`](https://sybilion.dev/docs/forecasts-submit#filters-optional-top-level). For browsing ids see [Regions & categories](https://sybilion.dev/docs/catalog); values are **not** cross-checked on submit. |
| `timeseries`          | Optional. If present: valid `YYYY-MM-DD` keys, finite values. **Frequency-agnostic** (no monthly grid / minimum length like forecasts). If omitted, not sent upstream. |

### recency_factor

Controls how strongly recent news is used to augment the dataset search with related context. The scale is `0.0`–`1.0`:

-   A value closer to **`0.0`** uses a broader historical news window, up to the last six years.
-   A value closer to **`1.0`** places stronger emphasis on recent news, up to the latest week.

### timeseries_metadata.keywords

Keywords should include both direct dataset terms and broader domain knowledge. This embeds expert understanding into the search process by capturing factors known to influence the dataset under analysis.

**Example — Aluminium Price:** aluminium price, aluminium demand, bauxite, alumina, smelting costs, electricity prices, energy-intensive production, Chinese industrial demand, construction activity, automotive demand, inventories, production cuts, sanctions, trade flows, freight costs, macroeconomic indicators

**Example — Textile Demand:** textile demand, apparel demand, clothing sales, retail sales, consumer confidence, disposable income, inflation, fashion retail, e-commerce sales, clothing inventories, import/export flows, manufacturing activity, cotton prices, polyester prices, freight costs, energy costs

Both `recency_factor` and `keywords` have a significant impact on the drivers selected and, consequently, on forecast performance.

## Example request

### curl

```bash
cat > drivers_body.json <<'EOF'
{
  "version": "v1",
  "recency_factor": 0.5,
  "timeseries_metadata": {
    "title": "Aluminum price in Europe USD/KG",
    "keywords": ["aluminum", "metals", "commodities"]
  },
  "filters": {
    "categories": [101],
    "regions": [42],
    "limit": 25
  }
}
EOF

curl -sS -X POST https://api.sybilion.dev/api/v1/drivers \
  -H "Authorization: Bearer $SYBILION_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d @drivers_body.json
```

### Python

```python
import os

from sybilion import Client

client = Client(token=os.environ["SYBILION_API_TOKEN"])

body = {
    "version": "v1",
    "recency_factor": 0.5,
    "timeseries_metadata": {
        "title": "Aluminum price in Europe USD/KG",
        "keywords": ["aluminum", "metals", "commodities"],
    },
    "filters": {
        "categories": [101],
        "regions": [42],
        "limit": 25,
    },
}

resp = client.get_drivers(body)
```

### Go

```go
package main

import (
	"context"
	"fmt"
	"log"
	"os"

	"go.sybilion.dev/sybilion"
	api "go.sybilion.dev/sybilion/api"
)

func main() {
	c := sybilion.New(sybilion.Options{
		Token: os.Getenv("SYBILION_API_TOKEN"),
	})

	meta := api.NewTimeseriesMetadata("Aluminum price in Europe USD/KG")
	meta.SetKeywords([]string{"aluminum", "metals", "commodities"})

	filters := api.NewFilters()
	filters.SetCategories([]int32{101})
	filters.SetRegions([]int32{42})
	filters.SetLimit(25)

	body := api.NewRecommendRequestV1("v1", 0.5, *meta)
	body.SetFilters(*filters)

	resp, err := c.GetDrivers(context.Background(), *body)
	if err != nil {
		log.Fatal(err)
	}
	fmt.Println(resp)
}
```

### Filter ids

`filters.regions[]` and `filters.categories[]` are integer ids in `1`–`9999`. Browse valid ids using [Regions & categories](https://sybilion.dev/docs/catalog). The endpoint does **not** cross-check ids against those listings.

## Response

```json
{
  "status": 200,
  "message": "ok",
  "data": {
    "drivers": [
      {
        "hash_id": "a1b2c3d4e5f6",
        "driver_name": "EU industrial production index",
        "score": 87.4
      }
    ]
  }
}
```

## Field reference

### `data.drivers[]`

| Field         | Meaning                                                              |
|---------------|----------------------------------------------------------------------|
| `hash_id`     | Stable identifier for the driver dataset.                            |
| `driver_name` | Human-readable name of the driver.                                   |
| `score`       | Relevance score indicating how strongly this driver is associated with the submitted series. |

## Common errors

| Code     | Cause                                                  | What to do                                                                  |
|----------|--------------------------------------------------------|------------------------------------------------------------------------------|
| **`402`** | Available balance below the worst-case ceiling.      | Top up, or reduce `filters.limit` so the pre-check fits the available balance. |
| **`422`** | Validation failure (one detail per response).        | Inspect `details[0]`.                                                        |
| **`429`** | Per-minute cap on synchronous billed calls exceeded. | Wait before retrying. Check tier limits on [`/tiers`](https://sybilion.dev/docs/openapi). |
| **`502`** | Transport error talking to the engine.               | Retry with the same `X-Request-ID`.                                          |
| **`503`** | Drivers feature not enabled for this account.        | Contact support.                                                              |

For the full error envelope, see [Errors & limits](https://sybilion.dev/docs/errors).
