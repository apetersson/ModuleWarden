# Real trajectory-ranked review queue

The headline claim, "the Sybilion forecast ranks your dependencies by growth and
blast-radius trajectory so you review the climbing ones first," as a real
artifact instead of a mockup. Built by forecasting real npm adoption series
through Sybilion and ranking by forecasted 6-month growth scaled by log current
volume (the blast-radius proxy). Every number is from a real forecast response
(2026-05-30). Reproduce with `demo/forecast_review_queue.py`.

| # | package | current M/mo | forecast 6m growth | band width | 6m MAPE | action |
|---|---------|-------------:|-------------------:|-----------:|--------:|--------|
| 1 | react      | 526.3  | +31% | 1.70 | 14.3% | route to human (wide band) |
| 2 | jquery     | 84.0   | +18% | 0.72 | 1.7%  | queue by rank |
| 3 | lodash     | 612.4  | +10% | 1.39 | 15.6% | route to human (wide band) |
| 4 | underscore | 92.9   | +4%  | 1.22 | 10.2% | route to human (wide band) |
| 5 | request    | 67.1   | -2%  | 0.81 | 17.5% | queue by rank |
| 6 | moment     | 134.7  | -2%  | 1.08 | 9.2%  | route to human (wide band) |
| 7 | async      | 373.8  | -3%  | 0.81 | 22.2% | queue by rank |
| 8 | q          | 56.8   | -10% | 0.19 | 9.3%  | queue by rank |
| 9 | grunt      | 4.5    | -20% | 0.46 | 4.4%  | queue by rank |
| 10 | chalk     | 1773.0 | -22% | 0.60 | 7.6%  | queue by rank |
| 11 | bluebird  | 184.4  | -30% | 1.57 | 16.6% | route to human (wide band) |
| 12 | date-fns  | 328.2  | -60% | 3.24 | 27.9% | route to human (wide band) |

## What it shows

- Across twelve real packages the forecast cleanly separates climbing from
  declining: the growers lead (react +31, jquery +18, lodash +10, underscore +4)
  and the veterans in decline trail (grunt -20, chalk -22, bluebird -30, and
  date-fns -60, its median reverting from a recent spike). A reviewer works
  top-down and vets the rising ones first. That is the thesis, on real data, not
  a mockup.
- When the 0.05-0.95 band is wider than the median, the package routes to a
  human instead of a guess. The forecast prioritizes, it does not pretend
  precision. The packages with tight bands (jquery, q, grunt, chalk) queue
  purely by rank.
- The backtest MAPE is real and spans 1.7 percent (jquery, a smooth predictable
  series) to 27.9 percent (date-fns, volatile). We show the spread rather than
  the best case; the gate, not the forecast, owns the verdict.

## Unfittable is itself a signal (from the Decepticon red-team)

The sharpest objection is the explosive-climber blind spot: if the forecast
fails on the steepest-growth packages, the ranking misses exactly the
dependencies with the fastest-rising blast radius. The honest answer is not to
hide them, it is to treat the failure as information. A package the forecast
cannot even fit (zod's ~440,000x range) is, by that fact, volatile enough to
deserve immediate review. So a forecast-unfittable package is not dropped from
the queue, it is promoted to a hard-priority "route to the gate plus a human
now" tier. The forecast failing to fit a package is a top-priority flag, not a
gap. This keeps the thesis intact: the forecast prioritizes what it can fit, and
its own failure prioritizes the rest.

The other red-team points we concede plainly: this is a prototype run of six
packages, not a validated ranking against review yield, and the log-volume
weight is there to stop a giant from masking a mid-tier climber, not as a proven
optimum. The band width is the signal we act on, wide band routes to a human.

## Honest notes

- Cost: twelve real forecasts make this queue; balance 4.57 EUR of the 50 EUR
  trial left after the runs (the broad set drained the credit deliberately).
  Real per-forecast cost 0.35-1.94 EUR, not the docs example. See
  `LIVE-DISCOVERY.md`.
- Four packages did not make the queue, and chasing them surfaced a real
  limitation worth stating:
  - zod, vite, tailwindcss are explosive young climbers. zod's series spans
    1,517 to 665,000,000 downloads per month, a ~440,000x dynamic range. Sybilion's
    forecast pipeline fails on them server-side with no terminal_reason, and it
    still fails with strictly_positive off, so it is the extreme range, not our
    payload. Failed forecasts are not billed, so this cost nothing. The honest
    read: the forecast handles moderate trajectories; the most explosive
    young packages route straight to the gate plus a human, which is the thesis,
    not a workaround.
  - express only yields 55 clean monthly points from npm here, below the 60-point
    floor for a 6-month horizon. Not forecastable at this horizon.
- Robustness fix that did land: npm zero-fills months before a package existed,
  and with strictly_positive that broke validation, so the driver now trims the
  leading zero run (`trim_leading_zeros`). And it persists the job_id on a poll
  timeout so a slow-but-valid job is never lost to the poll window.
- This is an illustration set, not a full project tree. A real package.json's
  whole dependency tree is the next step; it scales linearly with forecast cost,
  so it waits on the credit top-up (see `CREDIT-ROADMAP.md`).
