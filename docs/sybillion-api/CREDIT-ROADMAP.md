# What the forecast credit unlocks, on top of the repo

Worked out against the REAL account state and REAL per-call costs (see
`LIVE-DISCOVERY.md`), not the assumption of unlimited credit. Checked
2026-05-30: 19.29 EUR remaining of the original 50 EUR trial, single tranche, no
organizer top-up has landed, auto-recharge off. Real costs: a forecast 0.35-1.80
EUR, an alert 0.06, an unbounded drivers call 4.85 (dropped, macro noise for
npm). So the credit on hand is roughly 10-40 more forecasts.

The thing more credit buys is forecasting MANY packages instead of one. Single
forecasts we already have (date-fns, lodash, the fan chart). The value is at
tree scale.

## Tier A: within the ~19 EUR we have now

1. **Real trajectory-ranked review queue (in progress).** Forecast a real set of
   ~10 packages spanning trajectories (giants, climbers, slowing veterans), rank
   by forecasted 6-month growth scaled by log current volume, flag wide-band
   deps as route-to-human. Turns the headline claim from a mockup into a real
   table with real bands and real MAPEs. About 10 forecasts, ~5-10 EUR.
   `demo/forecast_review_queue.py`.
2. **A real MAPE honesty table.** The backtest MAPE per package, shown across the
   set, so the spread (lodash 15.6, date-fns 27.9, and the rest) is real and
   visible. Free once the queue forecasts exist (reuses their artifacts).
3. **Alert-driven re-rank, costed.** Poll `/alerts` (0.06 EUR each) on the set,
   show a trending package jumping the queue with its news attached. Cheap, and
   it exercises the `sybilion_alerts` path on live data.

## Tier B: if the top-up lands

4. **A real package.json from a real repo.** Forecast every floor-clearing dep in
   an actual project's lockfile (tens to low hundreds of packages), produce the
   full review queue for that project. The cost scales linearly, so this needs
   the top-up; at ~0.5-1.8 EUR per forecast a 100-dep tree is 50-180 EUR.
5. **A backtest accuracy study.** Forecast the set at 3 / 6 / 12-month horizons
   and tabulate MAPE by horizon, showing where the forecast is trustworthy and
   where it is not. Several forecasts per package; needs the top-up.
6. **A standing alert loop for the demo week.** Run `/alerts` on the tracked set
   on a schedule and log the trajectory moves, so the live demo shows a real
   change captured over days, not a staged one.

## Discipline that does not change with more credit

- Every number comes from a real run. No fabricated multipliers or metrics.
- No auto-spend. Auto-recharge stays off; a human authorizes any top-up. The
  scripts carry a balance floor and a max-submit cap so a loop cannot drain the
  account.
- `/drivers` stays off the menu for npm: 4.85 EUR for macro/geopolitical signals
  that do not fit a software series.
- The forecast still does not detect. Everything above ranks, costs, or measures.
  The deterministic gate owns the verdict.
