# GET /api/v1/regions and GET /api/v1/categories — Catalog

Source: https://sybilion.dev/docs/catalog
Fetched: 2026-05-29

---

Two read-only endpoints that return the full integer-id catalog used by `filters.regions[]` and `filters.categories[]` on forecasts and drivers. They are **discovery only** — submitting an id that isn't in the listing is not an error; the only enforced rule is integer range `1`–`9999`.

Both endpoints require `Authorization: Bearer` with an API key and share the same response shape and error codes.

For walkthroughs with curl / Python / Go, see the feature page: [Regions & categories](https://sybilion.dev/docs/features/regions-and-categories).

## Call the endpoint

### `GET /api/v1/regions`

Returns all regions, sorted by integer `id` ascending.

#### curl

```bash
curl -sS -H "Authorization: Bearer $SYBILION_API_TOKEN" \
  https://api.sybilion.dev/api/v1/regions \
  | jq '.items | length'
```

#### Python

```python
import os

from sybilion import Client

client = Client(token=os.environ["SYBILION_API_TOKEN"])

regions = client.list_regions()
print(len(regions.items), "regions; first:", regions.items[0])
```

#### Go

```go
package main

import (
	"context"
	"fmt"
	"log"
	"os"

	"go.sybilion.dev/sybilion"
)

func main() {
	c := sybilion.New(sybilion.Options{
		Token: os.Getenv("SYBILION_API_TOKEN"),
	})

	resp, err := c.ListRegions(context.Background())
	if err != nil {
		log.Fatal(err)
	}
	fmt.Println(len(resp.Items), "regions")
}
```

### `GET /api/v1/categories`

Returns all categories, sorted by integer `id` ascending.

#### curl

```bash
curl -sS -H "Authorization: Bearer $SYBILION_API_TOKEN" \
  https://api.sybilion.dev/api/v1/categories \
  | jq '.items[0]'
```

#### Python

```python
categories = client.list_categories()
print(len(categories.items), "categories; first:", categories.items[0])
```

#### Go

```go
resp, err := c.ListCategories(context.Background())
if err != nil {
	log.Fatal(err)
}
fmt.Println(len(resp.Items), "categories")
```

## Response

```json
{
  "items": [
    {
      "id": 42,
      "name": "Example",
      "code": 100,
      "parent_id": null,
      "path": "/…",
      "latitude": 0.0,
      "longitude": 0.0
    }
  ]
}
```

`items` is the **complete** listing — no pagination. Every entry includes integer `id` plus dimension-specific fields (names, codes, hierarchy).

## Field reference

| Field                | Meaning                                                                 |
|----------------------|-------------------------------------------------------------------------|
| `id`                 | Integer id used in `filters.regions[]` or `filters.categories[]`.       |
| `name`               | Human-readable label.                                                   |
| `code`               | Numeric classification code (dimension-specific).                       |
| `parent_id`          | Parent entry id for hierarchical dimensions, or `null`.                 |
| `path`               | Slash-separated hierarchy path string.                                  |
| `latitude`, `longitude` | Geographic coordinates (regions only; `0.0` when not applicable).    |

## Common errors

| Code     | Cause                                        | What to do       |
|----------|----------------------------------------------|------------------|
| **`401`** | Missing or invalid bearer token.            | Check the API key. |
| **`502`** | Dimensions backend unreachable.             | Retry; contact support if it persists. |
| **`503`** | Dimensions backend not enabled for this account. | Contact support. |
