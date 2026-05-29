# Forecasting suite (Track 03)

Three modules that express ModuleWarden as a probabilistic forecast plus an
acting agent, for the Sybilion forecasting track. All three are pure python,
no model or network needed (model-dependent inputs come in as pluggable
callables), and all are tested without a GPU.

The reframe: a verdict is a point estimate, a forecast is a calibrated
probability over an internal submission plus an agent that acts on it. The
threat personas are the disgruntled employee (intentional) and the lazy
employee who pulls an unvetted GitHub dependency tree (negligent).

## 1. Calibration - `finetune/python/eval/forecast_calibration.py`

Turns the audit verdict into a calibrated probability and measures how good
the calibration is. This is the Track-03-native proof.

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
