# Sybilion API edge - one-pager for the deck

What the documented forecast surface gives us that most teams will skim past, and how each piece turns into a slide. Everything here comes from the public docs we captured in this folder (fetched 2026-05-29). No partner internals, no source code. Where a number needs a live confirm before pitch day it is flagged CONFIRM-LIVE.

## The one-line edge

Most teams will call `forecasts/submit`, read the point number off `forecast.json`, and stop. The signal the judges reward is in the three artifacts almost nobody opens: `external_signals.json` (why the forecast moves), `backtest_metrics.json` (how wrong it is, per horizon), and `backtest_trajectories.json` (the honest track record). We build on those, not on the headline number.

## Five things in the documented API worth a slide

1. Driver attribution is already in the payload. `external_signals.json` returns, per driver: `importance` (per-horizon and overall), `direction` (signed correlation per horizon), and `pearson_correlation` per lag (`lag_6`, `lag_12`, plus overall mean/min/max). That means we can say *which* macro signal is pulling a dependency's trajectory up and at what lag, not just that it is rising. Two fields are intentionally omitted to keep payloads small (`normalized_series`, `granger_correlation`), so do not plan a slide around those.

2. The backtest is the honesty pillar, handed to us. `backtest_metrics.json` averages MAPE and RMSE across folds over rolling 6m / 12m / 24m / 60m windows; `backtest_trajectories.json` carries per-split `mape` / `rmse` with `actual` vs `forecast` per date. This is the exact "concede with the data" move our thesis already makes. We show the real per-horizon error next to our claim instead of asserting accuracy. It also directly backs the AUROC 0.54 floor story: same discipline, different metric.

3. `recency_factor` and `keywords` are the tuning knob teams ignore. The drivers endpoint takes `recency_factor` 0.0 to 1.0 (default 0.5; near 1.0 weights the latest week, near 0.0 spans up to six years) and a `keywords` list that injects domain expertise into the dataset search. For our domain that means keywords like npm, maintainer-account, lifecycle-script, CVE, advisory, blast-radius steer driver selection toward supply-chain-relevant signals. The docs say both knobs have a significant impact on driver choice and therefore forecast quality. Most teams leave them at default.

4. Quantile bands, only on probabilistic runs. `quantile_forecast` appears only for probabilistic submissions; the artifact example shows `0.1 / 0.5 / 0.9`. The exact quantile set our key returns is CONFIRM-LIVE before we put a number on a slide. The band, not the point, is what feeds our compounding-risk roll-up (`1 - prod(1 - p_i)`).

5. Budget and rate behavior is a live-demo risk, so design around it. The drivers call is synchronous and billed: `402` when balance is below the worst-case ceiling (reduce `filters.limit` to fit), `429` on the per-minute cap. Forecast artifacts only exist once status is `completed` (`409` if you fetch early, `404` if the artifact name is wrong, `413` over the 100 MiB stream limit). For the live demo: pre-run the forecast, cache the four artifacts to disk, and replay from cache so a `429` or a slow job never stalls the stage.

## How it maps to our submission

- Slide "Review by trajectory": pull `importance` + `direction` from `external_signals.json` so the rising-critical dependency we put first on the review queue shows the actual driver and lag behind its climb. Concrete beats hand-wavy.
- Slide "Honest about uncertainty": put a real `backtest_metrics` MAPE next to our forecast, and show one `backtest_trajectories` actual-vs-forecast line. The judges see we read our own error bars.
- Compounding-risk graph: the quantile band per dependency is the per-dep probability that rolls into submission-level risk. We already have the math; the API gives us the inputs.
- Architecture slide: forecast is a prioritizer (trajectory ranks review order), the deterministic gate detects and owns the verdict, the trained 27B narrates. The API sits cleanly in the prioritizer box, nothing we claim depends on partner internals.

## What we are NOT doing

We use the participant key against the documented `api/v1` surface only. We do not probe for, locate, or pull Sybilion's source code, infrastructure, or dependency list. The edge above is entirely in reading the artifacts other teams ignore, which is the move that wins a forecasting track without putting the team at disqualification risk.

## Pre-pitch checklist

- [ ] CONFIRM-LIVE: exact quantile set returned for a probabilistic run on our key.
- [ ] CONFIRM-LIVE: current account balance and per-minute cap, so the live demo budget is known.
- [ ] Pre-run one real forecast for a demo dependency, cache all four artifacts, rehearse the replay.
- [ ] Pick the keyword set for our supply-chain series and record the driver list it returns.
