# Integration claims, pinned exact

Every number the integration and the demo claims rest on, with its source doc.
Anything the public docs do not publish (portal-only) is flagged CONFIRM-LIVE
and must be read off the account before pitch day. Sources are the captured
pages in this folder (fetched 2026-05-29 / 2026-05-30).

## Auth

- `Authorization: Bearer <API key>` on every call (`catalog.md`, `forecasts-submit.md`).
- Balances live on `GET /api/v1/me`: `available_eur_cents` and `balance_eur_cents`,
  both in EUR cents (`forecasts-submit.md`, `me` page). `available` is balance
  minus in-flight holds.

## Documented endpoints we map

| Endpoint | Method | Billed | Captured in |
|---|---|---|---|
| `/api/v1/forecasts` | POST | yes | forecasts-submit.md |
| `/api/v1/forecasts/:id` | GET | no | forecasts-status.md |
| `/api/v1/forecasts/:id/artifacts/:name` | GET | no | forecasts-artifacts.md |
| `/api/v1/drivers` | POST | yes | drivers.md, drivers-api.md |
| `/api/v1/alerts` | POST | yes | alerts.md |
| `/api/v1/jobs` | GET | no | jobs.md |
| `/api/v1/usage` | GET | no | usage.md |
| `/api/v1/regions` | GET | no | catalog.md |
| `/api/v1/categories` | GET | no | catalog.md |
| `/api/v1/me` | GET | no | (me page) |
| `/health` | GET | no, unauth | (health page) |

## History floor (the "60-month" rule), exact

Minimum monthly points needed to forecast, keyed on
`horizonMax = max(soft_horizon, hard_horizon)` (`forecasts-submit.md`):

| horizonMax (months) | Minimum monthly points |
|---|---|
| 1-3 | 40 |
| 4-6 | 60 |
| 7-12 | 120 |

So the "60-month floor" is the 4-6 month horizon row: a 6-month forecast needs
at least 60 monthly observations (5 years of monthly history). Plus:

- Frequency is `monthly` only in v1; keys must be the first calendar day of the
  month (`YYYY-MM-01`), no gaps in the grid.
- Recency: the latest observation must be within the past 12 months (UTC).
- Intermittent demand (ADI >= 1.32 = total_periods / non_zero_periods): at least
  60 monthly points, at least 20 percent non-zero (max intermittency 0.8), and
  the top-of-ladder horizon restricted to 3 or 6.

Demo consequence, stated honestly: a dependency whose adoption series is shorter
than 60 monthly points cannot get a 6-month forecast. A package younger than
five years is below the floor for the horizon we would want. We say that rather
than imply every dependency is forecastable.

## Concurrency and holds (the tier-0 question), exact

From `errors.md`:

- There is a concurrent-forecast-job cap that counts in-flight async jobs
  (`status` in `queued` or `running`). Exceeding it returns `429` with message
  `too many concurrent jobs`, applied BEFORE the balance hold.
- Separately, `POST /forecasts` places a balance HOLD (an estimate of max cost)
  that reduces `available_eur_cents`; the hold is released and replaced by the
  actual charge on settle. Insufficient available balance returns `402`.
- The two are independent: you can hit `429` for concurrency on a positive
  balance, or `402` on balance with zero running jobs while holds settle.

CONFIRM-LIVE: the actual concurrent-job cap NUMBER and the per-minute submit cap
are tier-bound and published only on the portal (`/tiers`), not in the docs. Read
our account's tier-0 (Free) concurrency cap off the portal before claiming a
number on a slide. The behavior above is documented; the integer is not.

## Quantile-band fields, exact

`forecast.json` `data` (`forecasts-artifacts.md`), per date in `forecast_series`:

- `forecast` - the point estimate (always present).
- `quantile_forecast` - present ONLY on probabilistic runs; the documented
  example keys are `"0.1"`, `"0.5"`, `"0.9"` (P10 / median / P90).
- top level: `forecast_horizon`, `forecast_start`, `forecast_end`.

RESOLVED on a live run (2026-05-30): the API returns 19 quantiles, 0.05 to 0.95
in 0.05 steps, not the docs' 0.1 / 0.5 / 0.9 example. Backtest metric keys are
uppercase (MAE / MAPE / MASE / RMSE / RMSSE). See `LIVE-DISCOVERY.md`.

`external_signals.json` per driver: `importance` (per-horizon and overall),
`direction` (signed correlation per horizon), `pearson_correlation` (per-lag
`lag_6` / `lag_12` plus overall). Two fields are intentionally omitted:
`normalized_series` and `granger_correlation`.

`backtest_metrics.json` (only when `backtest: true`): MAPE and RMSE over rolling
6m / 12m / 24m / 60m windows. `backtest_trajectories.json`: per-fold actual vs
forecast, last 12 months retained.

## What must be set to get the probabilistic surface

- `backtest: true` on submit is the gate for `backtest_metrics.json` and
  `backtest_trajectories.json`. Without it there is no historical-accuracy
  artifact at all. Our honesty pillar leans on the backtest MAPE, so the demo
  forecast must be submitted with `backtest: true`.
- `quantile_forecast` is returned on a probabilistic run; read and store it
  rather than collapsing to the point `forecast`.

## Account state, read from the portal (2026-05-30)

- Tier: Level 0 (Free). Auto-recharge: disabled.
- Trial credit active: 26.59 EUR remaining of a 50 EUR grant, expires
  2026-06-14. Real measured cost (not the docs example): a forecast settles
  around 0.35-1.80 EUR, an alert about 0.06 EUR, an unbounded drivers call about
  4.85 EUR. So the trial is roughly 15-70 forecasts, not hundreds. See
  `LIVE-DISCOVERY.md`. No auto-spend.

## CONFIRM-LIVE checklist before pitch day

- [ ] Tier-0 concurrent-job cap and per-minute submit cap (portal `/tiers` page,
      not shown on the Overview; still unread).
- [x] Exact quantile set: 19 quantiles 0.05-0.95, confirmed live (date-fns run).
- [x] Demo dependency series clears the floor: date-fns gives 88 monthly points
      (2019-2026) via `sybilion_forecast.py`, above the 60 floor for a 6-month
      horizon.
- [x] Balance covers the demo: 26.59 EUR remaining, a forecast settles at about
      3 cents (`jobs.md`).
