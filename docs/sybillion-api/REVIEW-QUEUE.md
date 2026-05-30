# Real trajectory-ranked review queue

The headline claim, "the Sybilion forecast ranks your dependencies by growth and
blast-radius trajectory so you review the climbing ones first," as a real
artifact instead of a mockup. Built by forecasting real npm adoption series
through Sybilion and ranking by forecasted 6-month growth scaled by log current
volume (the blast-radius proxy). Every number is from a real forecast response
(2026-05-30). Reproduce with `demo/forecast_review_queue.py`.

| # | package | current M/mo | forecast 6m growth | band width | 6m MAPE | action |
|---|---------|-------------:|-------------------:|-----------:|--------:|--------|
| 1 | react    | 526.3  | +31% | 1.70 | 14.3% | route to human (wide band) |
| 2 | lodash   | 612.4  | +10% | 1.39 | 15.6% | route to human (wide band) |
| 3 | request  | 67.1   | -2%  | 0.81 | 17.5% | queue by rank |
| 4 | moment   | 134.7  | -2%  | 1.08 | 9.2%  | route to human (wide band) |
| 5 | chalk    | 1773.0 | -22% | 0.60 | 7.6%  | queue by rank |
| 6 | date-fns | 328.2  | -60% | 3.24 | 27.9% | route to human (wide band) |

## What it shows

- The forecast puts the climbers first: react (+31 percent forecast growth) and
  lodash (+10 percent) top the queue, the packages a reviewer should vet now.
  The decliners, chalk (-22) and date-fns (-60, its median reverting from a
  recent spike), sink to the bottom. That is the thesis, on real data.
- Four of the six route to a human because the 0.05-0.95 band is wider than the
  median. That is the honest part: the forecast prioritizes, it does not pretend
  precision, and when it cannot call a package tightly it hands it to a person
  rather than guessing. Only request and chalk have tight enough bands to queue
  purely by rank.
- The backtest MAPE is real and varies, 7.6 percent (chalk) to 27.9 percent
  (date-fns). We show the spread; the gate, not the forecast, owns the verdict.

## Honest notes

- Cost: six forecasts in this set, about 6.89 EUR of trial credit, balance 12.40
  EUR after. Real per-forecast cost, not the docs example. See `LIVE-DISCOVERY.md`.
- Four packages (express, zod, vite, tailwindcss) were submitted but their poll
  window expired before completion, and the first version of the driver did not
  save the job_id, so those paid jobs were lost. The driver now persists the
  job_id on a poll timeout so a paid job is never lost again, and those four can
  be completed without re-paying.
- This is a 10-package illustration set, not a full project tree. A real
  package.json's full dependency tree is the next step, and it scales linearly
  with forecast cost, so it waits on the credit top-up (see `CREDIT-ROADMAP.md`).
