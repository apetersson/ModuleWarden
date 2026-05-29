# Drivers

Source: https://sybilion.dev/docs/features/drivers
Fetched: 2026-05-29

---

**Drivers** are external macroeconomic signals identified by the Sybilion pipeline as the most relevant influences on a given time series. They quantify which signals shaped a projection and by how much, appearing as attributions in a forecast's `external_signals.json` artifact.

Driver recommendations can also be retrieved independently, without running a full forecast. Submitting to `POST /api/v1/drivers` returns a ranked list of drivers with importance and direction scores immediately without any polling.

Result quality of the drivers is driven by several key factors: the `keywords` that embed domain knowledge into the driver selection, a `recency factor` that shifts the news window used to augment the search, and `filters` that narrow the candidate universe by region and category.

For the full request shape and per-field validation, see [POST /api/v1/drivers](https://sybilion.dev/docs/drivers).

## Use cases

-   Getting **driver recommendations** for suggestions or exploratory analysis.
-   Skipping the full forecast pipeline when only a ranked driver list with importance and direction is needed.
-   Filtering by region or category to scope the recommendation universe.

For a forecast that also embeds driver attributions, submit a [forecast](https://sybilion.dev/docs/features/forecasts) instead. Its `external_signals.json` artifact carries the same kind of information.

## Pricing

Billing applies **only on `2xx`** responses. The cost includes a base fee plus scales with how many result items are returned. The cost of the request is shown on the [Developers Portal](https://sybilion.dev/billing) pricing page.

A pre-charge hold is applied based on the maximum number of drivers that can be returned. If the available balance cannot cover the hold, the operation is blocked.

## See also

-   API reference: [POST /api/v1/drivers](https://sybilion.dev/docs/drivers).
-   Main feature that bundles driver attributions: [Forecasts](https://sybilion.dev/docs/features/forecasts).
-   Find valid filter ids: [Regions & categories](https://sybilion.dev/docs/features/regions-and-categories).
-   Clients: [Using curl](https://sybilion.dev/docs/using-curl) · [Python SDK](https://sybilion.dev/docs/sdk-python) · [Go SDK](https://sybilion.dev/docs/sdk-go).
