# Forecasting suite (Sybilion FORECAST track)

Three modules that express ModuleWarden as a probabilistic forecast plus an
acting agent, for the Sybilion forecasting track. All three are pure python,
no model or network needed (model-dependent inputs come in as pluggable
callables), and all are tested without a GPU.

The reframe: a verdict is a point estimate, a forecast adds a probability and a
trajectory over an internal submission, plus an agent that acts on it. The
Sybilion forecast ranks dependencies by growth and blast-radius trajectory so
the team reviews the rising-critical ones first; it prioritizes, it does not
detect (a backtest showed the band and slope do not separate declining from
healthy packages, and we concede that). The deterministic gate detects and owns
the verdict. The threat personas are the disgruntled employee (intentional) and
the lazy employee who pulls an unvetted GitHub dependency tree (negligent).

A note on the word forecast, so nothing is conflated. The Sybilion demand
forecast ranks review order by trajectory and is the only thing that consumes
the time-series API. The three modules below express the deterministic gate's
verdict as a calibrated probability and roll it up across a dependency tree.
They are the gate's signal in probabilistic form, not the Sybilion forecast and
not a maliciousness classifier.

## 1. Calibration - `finetune/python/eval/forecast_calibration.py`

Turns the deterministic gate's audit verdict into a calibrated probability and
measures the calibration. This is the gate verdict in probabilistic form, not
the Sybilion demand forecast.

- `forecast_probability(verdict, confidence)` - monotone map to P(compromise). block > quarantine > allow; confidence sharpens toward 0/1.
- `brier_score(probs, labels)`, `expected_calibration_error(probs, labels)`, `reliability_curve(probs, labels)` - the calibration metrics forecasting judges expect.
- `evaluate_calibration(records, predict_fn, label_fn)` - run over the held-out corpus; pluggable predict/label so it serves stubs now and the trained model later. Returns brier, ece, reliability, base_rate.

## 2. Dependency-tree forecast - `finetune/python/serving/dependency_forecast.py`

The lazy-employee demo. Scores a whole dependency set and rolls per-dep
probabilities into one submission-level risk number.

- `parse_dependencies(deps)` - accepts `name@version` strings, `{name,version}` dicts, or a `package.json` `{"dependencies": {...}}`.
- `forecast_dependency_tree(deps, score_fn)` - returns `submission_risk` (probability at least one dep is compromised, `1 - prod(1-p_i)`), `expected_compromised` (sum of probabilities, an expected count), the riskiest deps named, and per-dep probabilities. `score_fn(dep)` is the pluggable per-dep model.
- `summarize(result)` - one human paragraph naming the riskiest deps.

## 3. Acting agent - `finetune/python/serving/acting_agent.py`

The agent that acts on the forecast (Sybilion: forecasting AND the agent layer
that acts on it).

- `ActionPolicy(allow_below=0.15, escalate_above=0.60)` - the threshold policy; the quarantine band sits between.
- `decide_action(probability, dossier, policy)` - returns `{action, probability, reason, attack_path}`. action is allow / quarantine / escalate by threshold. On escalate or quarantine, if the dossier carries capability_deltas it attaches the MITRE ATT&CK kill chain (via `decepticon.mapper.kill_chain_narrative`) so a reviewer sees how the compromise would work.
- `summarize_decision(decision)` - one memo line, with the ATT&CK chain when present.

## 4. Consuming the quantile band, not just the point

The first three modules use point estimates. These four additions make the
forecast's uncertainty actually change what happens, which is what a forecast
track rewards.

### 4a. Interval roll-up - `dependency_forecast.forecast_dependency_tree(deps, score_fn, band_fn=...)`

Pass an optional `band_fn(dep) -> (p_low, p_high)` (the per-dep quantile bounds)
and the submission-level number becomes an interval, not a point. The result
gains `submission_risk_interval` = `{low, high, width}`, computed by rolling up
`1 - prod(1 - p_i)` at the low bounds and again at the high bounds. Each
dependency carries `p_low`, `p_high`, `band_width`, and `route_to_human`. Any
dep whose band is at least `wide_band_threshold` (default 0.30) is collected in
`high_volatility` and routed to a human, because the forecast cannot call it
tightly. With no `band_fn` the interval collapses onto the point, so old
callers are unchanged. This is the honest number: a band, not a point wearing a
band's clothes.

### 4b. Review routing - `acting_agent.decide_action(prob, dossier, policy, band=...)`

Pass the `(low, high)` band and the decision gains `review_urgency`
(routine / elevated / urgent) and `route_to_human`. A wide band raises the
urgency and can send a borderline case to a human. It NEVER changes the action:
the threshold policy on the point estimate still owns allow / quarantine /
escalate. The forecast sets review ORDER; the gate sets the verdict. That
division is the whole thesis, expressed in one signature.

### 4c. Drift trigger - `forecast_drift.act_on_drift(forecast_data, dossier=...)`

The other half of "an agent that acts on the forecast". It reads the documented
Sybilion `forecast.json` trajectory and fires on three signals: a level
crossing (the latest point passes a historical upper bound), slope acceleration
(the latest step is at least 1.5x the prior average and rising), or band
widening (the quantile interval is fanning out). On drift it recommends
pre-fetching and pinning the version delta so the deterministic gate audits a
warm artifact the moment the install lands, instead of cold-starting under time
pressure. It warms the gate; it does not pass a verdict.

### 4d. Volatility to scan depth - `dependency_forecast.scan_depth_for_volatility(short_horizon_mape)`

The conceded negative result, turned into an engineered feature. The forecast
does not detect a dying or compromised package. What it tracks is volatility,
and a volatile series means frequent version bumps, which means a larger
cumulative version-delta surface for an attacker to hide in. So we do not ask
the forecast to judge the package. We let its short-horizon MAPE set how deep
the gate scans the delta: shallow / standard / deep, with a `scan_multiplier`.
Depth scales scrutiny; it never decides the verdict. "We do not predict death.
We predict update velocity, and we scale the gate's scrutiny to it."

## 5. Consuming Sybilion's native signals

We found two documented endpoints we were not using and wired both. The rule
held: each one informs review order, scan depth, or cost, never the verdict.

### 5a. Alerts as the forecast-native trigger - `serving/sybilion_alerts.py`

`POST /api/v1/alerts` returns, per dataset, a `pct_change`, a `trending` flag,
and the `news[]` that moved it. That is the same signal `forecast_drift.py`
computes from the series, handed over directly with the cause attached, so we
prefer it where it is available.

- `alert_drift(alert)` - mirrors the `forecast_drift` output: drift fires when
  the alert is trending or the absolute `pct_change` clears a threshold, and the
  news titles ride along as the cited cause.
- `make_alert_band_fn(alerts)` - a `band_fn` for `forecast_dependency_tree`; the
  per-dep band widens in proportion to the documented move (a larger move means
  a wider band means route-to-human), centered on the dep's own probability.
- `alert_scan_depth(alert, short_horizon_mape=...)` - folds the alert into scan
  depth alongside the backtest MAPE; the deeper of the two wins, so a live alert
  can escalate scrutiny above what the backtest alone would pick. A trending
  alert floors the depth at standard.
- `narration_context(alert)` - short citable news lines the trained auditor uses
  to explain the move ("trending because: maintainer handed off repo (source)").

There are no per-category multipliers. The docs do not enumerate the category
set or publish any weighting, so the signal is `pct_change` and `trending`, and
`news` is context the model cites, never a score.

### 5b. Cost-aware budgeting - `serving/sybilion_budget.py`

`GET /api/v1/jobs` carries `eur_cents_final` per job (a forecast settled at
about 3 cents in the docs) and `GET /api/v1/usage` carries the billed-event
history.

- `spend_summary(jobs_payload, usage_payload)` - total spend, spend by endpoint
  (forecast / drivers / alerts), and the mean forecast cost.
- `throttle_plan(ranked_deps, remaining_budget_cents, per_minute_cap, ...)` -
  walks the trajectory-ranked deps and admits each while it stays within the
  remaining budget and under the per-minute cap (with safety headroom), defers
  the rest. It is ordering only. It never tops up balance and never requests a
  tier upgrade; a human authorizes any spend.

## End to end

```python
from finetune.python.eval.forecast_calibration import forecast_probability
from finetune.python.serving.dependency_forecast import forecast_dependency_tree, summarize
from finetune.python.serving.acting_agent import decide_action, summarize_decision

# verdict -> calibrated probability
p = forecast_probability("block", "high")

# lazy-employee: score an imported dependency tree
res = forecast_dependency_tree({"dependencies": {"event-stream": "3.3.6"}},
                               score_fn=my_model_or_stub)
print(summarize(res))

# the agent acts, attaching the attack path on escalation
decision = decide_action(p, dossier)
print(summarize_decision(decision))
```

## Next step

`evaluate_calibration` and `forecast_dependency_tree` take pluggable callables
today. Wire the trained model's verdict+confidence (or a probability head) into
those callables to report the real Brier / ECE on the held-out corpus and to
score real dependency trees. The corpus of 6,587 vulnerable-vs-patched pairs on
Nextcloud is the calibration set.
