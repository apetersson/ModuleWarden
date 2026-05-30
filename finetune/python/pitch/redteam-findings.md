# Red-team findings: attacks on our own forecast-track pitch

Adversarial pass over OUR submission (Decepticon, 2026-05-30), then filtered for
honesty. The point is to walk in knowing our weakest claims, not to dress them
up. One of Decepticon's proposed defenses invented a tool name (`npm-art-rank`);
that is rejected per our rule (documented or measured signal only, never an
invented artifact). Where we do not have a real defense, the item is flagged
OPEN rather than spun.

## 1. Monthly-only + the 60-month history floor vs npm reality (HARDEST)

**Judge question:** "Sybilion forecasts monthly series and needs at least 60
monthly points for a 6-month horizon, 40 for a 3-month one. Most npm packages
are younger than five years or only expose daily download counts. So what time
series do you actually feed it, and are you really ranking a whole dependency
tree, or just the dozen old packages that clear the floor?"

**Our weakest point, stated plainly:** Two real gaps.
- There is no forecast-submission feeder in the code today. The forecast suite
  modules (`dependency_forecast`, `acting_agent`, `forecast_drift`) all take
  pluggable score callables; `sybilion_alerts` / `sybilion_budget` consume
  alerts / jobs / usage payloads. Nothing yet submits a package's monthly
  download series to `POST /api/v1/forecasts`. The "rank by trajectory" demo
  rests on a submission path we have not wired.
- Even once wired, the monthly grid and the 40/60/120-point floor mean the
  forecast can only rank established packages. A package younger than five years
  is below the floor for a 6-month horizon. Young, volatile packages, which is
  often where a fresh compromise lands, are exactly the ones the forecast cannot
  see.

**Honest defense we actually have:** We do not claim universal coverage, and we
should say so on the slide. The forecast is a prioritizer for the established,
high-blast-radius dependencies that clear the history floor; the deterministic
gate detects on every install delta regardless of age or history, so the long
tail is covered by the gate, not the forecast. The data source, if we build the
feeder, is npm registry download counts aggregated to a monthly grid; that is a
concrete next build, not something we should imply already runs. NEXT BUILD:
a `submit_forecast(package, monthly_downloads)` path plus an honest
"forecastable vs gate-only" split on the demo dependency list.

## 2. Is the forecast load-bearing, or decoration on a gate that wins alone?

**Judge question:** "If the deterministic gate catches capability deltas,
lifecycle scripts, and obfuscation regardless of rank, what load does the
forecast carry? Isn't it a sorting hat reordering a list the gate scans anyway?"

**Our weakest point:** If the gate is cheap and scans every delta, ranking saves
nothing and the forecast is decorative. We have not published a gate scan cost
or a latency budget that would make triage necessary.

**Honest defense:** The gate is deterministic but not free at depth. A header
scan is cheap; full deobfuscation, WASM and native-addon tracing, and dynamic
observation are not, and a large tree has hundreds of deltas at CI time. The
forecast allocates the expensive scan depth to the rising, high-blast-radius
deps first and routes wide-band ones to a human. It is a triage and
compute-allocation layer, not a detector. The gate still decides; the forecast
decides where to spend the deep scan. We should state the per-tier scan cost so
this is not hand-waved.

## 3. MAPE and quantiles: real value or API-call theater?

**Judge question:** "You pay about 3 cents a forecast to get a quantile band and
a MAPE, then use MAPE to scale scan depth and the band to route to humans. Isn't
that wrapping a threshold check in API calls to look like genuine forecast use?"

**Our weakest point, and it is a fair hit:** MAPE is the forecast's ERROR, not
the package's risk or even directly its volatility. "High MAPE so scan deeper"
is only sound if forecast error tracks update velocity, and that link is
asserted, not measured. Driving scan depth off the forecast's own error is the
softest part of the design.

**Honest defense, with a flagged refinement:** The intended signal is volatility
as update velocity (more bumps means a bigger cumulative version-delta surface),
and a volatile series is both harder to forecast (high MAPE) and more
delta-dense. So MAPE is a proxy, not the thing itself. REFINEMENT TO CONSIDER:
drive scan depth off the variance of the actual download series (a direct
volatility measure) rather than the forecast's MAPE, and keep MAPE only as the
honesty number on the backtest slide. The quantile band's real job is the
interval submission-risk roll-up and the route-to-human on a wide band, which is
defensible on its own; that part is not theater.

## 4. Cost and concurrency at tree scale (secondary)

**Judge question:** "At about 3 cents a forecast, a 500-dep tree is real money
per update, and the tier concurrency cap is undocumented. How do you not
rate-limit your own gate during a CI burst?"

**Honest defense:** Cache forecasts by package name and version, only call
Sybilion on a delta or an alert trigger, and throttle under the per-minute cap
via `sybilion_budget.throttle_plan`. The gate runs locally and never blocks on
the forecast; the forecast is async prioritization. The exact tier-0 cap is
CONFIRM-LIVE off the portal (see `docs/sybillion-api/INTEGRATION-CLAIMS.md`).

## The one slide change this argues for

Add an explicit "what the forecast covers and what it does not" line to slide 6:
the forecast ranks the established deps that clear the monthly history floor; the
gate covers everything else on the delta. Conceding the coverage boundary out
loud is stronger than letting a judge find it.
