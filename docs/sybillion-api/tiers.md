# Tiers - Pricing and Rate Limits

Source: https://sybilion.dev/docs/tiers
Fetched: 2026-05-30

---

Five tiers. The first four upgrade automatically as you buy credits; Enterprise
is contracted.

| Tier | For |
|------|-----|
| Free | New accounts trying the API. |
| Starter | Active developers running small integrations. |
| Pro | Teams running steady production workloads. |
| Growth | High-volume integrations. |
| Enterprise | Contracted customers with custom limits, SLAs, support. |

- Free / Starter / Pro / Growth move up automatically as more credits are
  purchased, no action needed.
- Enterprise requires contacting Sybilion with a use case and expected volume.

## Numeric limits

The docs page does NOT publish the per-minute budgets, per-period caps, or
exact prices. The live numbers for the current account are on the portal at
https://sybilion.dev/tiers (CONFIRM-LIVE before pitch day).

## Why this matters for us

The `429` per-minute cap is tier-bound. Before the demo, read the live tier page
for our account's per-minute cap so we pace forecast/drivers/alerts calls under
it. Auto-upgrade-by-credit means a top-up also raises the cap.
