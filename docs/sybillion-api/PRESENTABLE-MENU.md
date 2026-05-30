# What else we can present with, from the documented API

An extensive Decepticon pass (2026-05-30) over the documented Sybilion surface,
filtered for honesty and corrected against the captured docs. Decepticon
hallucinated parts of the API contract (a `.com` base, an array-shaped
`timeseries`, invented metadata fields, a `?seed=` cache-buster); those are
rejected per our rule, documented signal only. The real contract is in
`forecasts-submit.md` and is what the feeder uses.

## Real account state (from the portal, 2026-05-30)

- Tier: Level 0 (Free). Auto-recharge: disabled.
- Trial credit active: 26.59 EUR remaining of a 50 EUR grant, expires 2026-06-14.
- Real measured cost (see `LIVE-DISCOVERY.md`, not the docs example): a forecast
  settles around 0.35-1.80 EUR, an alert about 0.06 EUR, an unbounded drivers
  call about 4.85 EUR. So the trial is roughly 15-70 forecasts, enough for the
  demo if we forecast only floor-clearing deps on a trigger. We never enable
  auto-recharge; a human authorizes any top-up.

## Ranked presentable moves

| # | Move | What we show on stage | Endpoints | Effort | Status |
|---|------|----------------------|-----------|--------|--------|
| 1 | Live forecast fan chart | Take a real npm package, build its monthly adoption series, submit, render the 0.1/0.5/0.9 band plus the backtest MAPE, live | POST /forecasts (backtest), GET /forecasts/:id, artifacts | M | BUILT, dry-run proven |
| 2 | Backtest reliability routing | Parse backtest MAPE into a reliability badge; low MAPE rides the gate, high MAPE routes to human review | POST /forecasts, backtest_metrics.json | S | design |
| 3 | ~~Driver-shift comparison~~ | DROPPED after a live test: /drivers returned 970 "Global risk - country" macro signals for an npm series, no software relevance, and cost 4.85 EUR. Not credible for software | - | - | dropped (see LIVE-DISCOVERY) |
| 4 | Budget and cost HUD | Live panel polling /me and /usage: trial credit left, cost per forecast, queue | GET /me, /usage, /jobs | S | partial (sybilion_budget) |
| 5 | Alert-triggered refresh | A trending alert auto-triggers a re-forecast; the band updates | POST /alerts, POST /forecasts | S | partial (sybilion_alerts) |
| 6 | Horizon confidence ladder | Overlay 1 / 3 / 6 / 12-month horizons; the quantile spread widens with horizon | POST /forecasts (soft/hard horizon) | S | design |
| 7 | OpenAPI + artifact audit trail | Validate the response against the live schema, then download raw artifacts | GET /openapi.yaml, artifacts | S | design |

Move 1 is the headline and it is built: `finetune/python/serving/sybilion_forecast.py`.
Dry run already pulls a real series (date-fns: 88 monthly points, 2019-2026,
clears the floor) and builds the exact documented payload. One gated
`--submit --yes-i-will-spend` turns it into a live forecast inside the trial.

## Hardening the live demo (red-team of our own demo)

Four holes a forecast-track judge would poke, with the honest mitigation we have.

1. **npm downloads are CI-noisy, a giant's forecast is flat.** Forecast a
   mid-tier climber (the feeder defaults to `date-fns`, not `lodash`) so the
   band shows real slope and volatility. Say plainly: we forecast adoption
   trajectory, not absolute volume.
2. **Live vs cache credibility.** Prove liveness with the documented `job_id`
   and `created_at` from the response, shown on screen. If the API stalls, dump
   the raw JSON with its timestamp rather than a pre-rendered chart. No silent
   fallback that could read as the cache.
3. **Forecasting a download curve is not catching malware.** Bridge it out loud:
   the forecast ranks which deps to review first by trajectory; the gate catches
   the malicious delta. The forecast finds the climbers, the gate owns the
   verdict. Concede it does not detect.
4. **A smooth series gives a suspiciously low MAPE (cherry-picking).** Run a
   volatile mid-tier package too, frame MAPE as band coverage not precision, and
   show the 0.1/0.9 quantiles actually covering the backtest line. Honesty about
   uncertainty beats a tight line.

## Not claimed

- We do not call the band "calibrated". The docs return quantiles; calibration
  is a measurement we have not made on this data.
- We do not claim a quantile set wider than the documented 0.1/0.5/0.9 until a
  live run shows it (CONFIRM-LIVE).
- The forecast still does not detect. Every move above informs review order,
  scan depth, reliability, or cost. The gate decides.
