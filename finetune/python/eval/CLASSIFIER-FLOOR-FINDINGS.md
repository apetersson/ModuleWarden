# Classifier floor - findings (measured, not assumed)

Measured 2026-05-29 on an 800-artifact balanced subset (400 benign + 400
vulnerable) pulled straight from the npm CDN via the public `url` in
`artifact-index.jsonl`. Raw metrics live in `classifier-floor-report.md`
(auto-regenerated) and `classifier-floor-metrics.json`. This file is the durable
interpretation; it does not get clobbered by re-runs.

## Headline

Static per-version capability features do NOT separate CVE-affected packages from
their patched versions. **Held-out AUROC = 0.54** (160 test samples), i.e. barely
above the 0.50 coin flip. PR-AUC 0.61, Brier 0.31, ECE 0.23. At a high-precision
operating point (thr 0.98) precision is 1.0 but recall is 3.7% - it catches almost
nothing.

## Why (this is the important part, not the number)

This corpus is GHSA advisory PAIRS: `benign` = the first-patched version of a real,
usually legitimate package; `vulnerable` = the affected version of the same kind of
package. It is NOT typosquat-malware vs popular-package. So the two buckets are
largely the same legitimate code at two versions, and their gross capability
inventories are nearly identical:

| signal (% of bucket)     | benign | vulnerable |
|--------------------------|--------|------------|
| network_access           | 99.8   | 93.8       |
| process_execution        | 59.5   | 52.5       |
| native_or_wasm           | 44.2   | 33.2       |
| dynamic_code_execution   | 20.2   | 19.2       |
| obfuscation              | 15.0   | 12.2       |
| credential_or_env_access | 14.2   | 12.8       |
| lifecycle_script         | 13.0   | 10.5       |
| filesystem_sensitive     |  7.5   |  7.8       |

benign is marginally HIGHER on most signals (bigger, more-featured legit packages).
The trained model's importances confirm it leans on package-SIZE proxies, not
maliciousness: entropy 0.44, file_count 0.21, dep counts 0.24 combined; every
actual capability flag is < 0.015. There is no maliciousness signal in the absolute
per-version capability set for this corpus, so the model can only classify "how big
is the package," which is uncorrelated with affected-vs-patched. Hence ~0.54.

Note: benign and vulnerable were sampled INDEPENDENTLY (mostly different packages),
which is the generous case. Matched same-package pairs would be even harder.

## What this disproves

The earlier strategy note (`SYBILION-FORECAST-STRATEGY.md`, Tier 2) claimed
"AUROC ~0.90, grounded in arXiv:2603.27549, GuardDog-class ~93% F1." That benchmark
is malware-vs-benign typosquat detection - a different problem where malware screams
(install hooks + obfuscation + credential theft). It does not transfer to
affected-vs-patched discrimination on legitimate packages. The 0.90 was borrowed
from the wrong setting. Measured floor on THIS corpus with THESE features: 0.54.

## What this validates (the design is right, the feature set was wrong)

ModuleWarden's gate does NOT key on absolute capability presence. It keys on the
version DELTA: `_detect_lifecycle_script_delta` (what scripts were ADDED between
versions) and the capability-DELTA detectors fed by `version_pair_extractor`. That
is the correct design for this threat model and this corpus - the signal is in what
CHANGED, not in what the package can do. The deterministic delta-gate stays the
verdict authority; it does not need a probability to be useful or auditable.

## What to do next

1. The honest forecasting object is the DELTA, not the cold package. The
   embedding layer (task-18) must embed the affected-vs-patched code change and
   score P(exploited) from the movement in embedding space + nearest-known-attack,
   NOT embed the package in isolation. GPU-deferred (a different model holds the GPU
   right now), scaffold ready.
2. Do not chase the 0.54 with more rows. The ceiling for this feature set on this
   corpus is ~0.54; it is a feature-set mismatch, not a data-volume problem.
3. Pitch posture (both tracks): lead with the deterministic delta-gate as the
   verdict authority (auditable, no fabricated score). Present this 0.54 measurement
   honestly as the reason a single opaque static score is the WRONG tool here, which
   is exactly why the gate decides and the model only narrates. Strip every
   "0.90 / calibrated / conformal precision 98%" claim from the decks - they are now
   empirically false.

## Reproduce

```
# 1. balanced subset straight from npm CDN (no 14.5 GB Nextcloud pull, no collision)
python finetune/scripts/_subset_corpus_build.py --n-benign 400 --n-vulnerable 400 --seed 7
# 2. task-36 static feature extraction (read-only, never extractall/execute)
python finetune/scripts/extract-tarball-features.py \
  --artifact-index finetune/corpus/local-artifact-index.jsonl \
  --output finetune/corpus/tarball-features.jsonl
# 3. flatten fix + train (task-39) + calibration/rigor layer
python finetune/scripts/_flatten_and_calibrate.py
```

The flatten step matters: task-39's vectorizer coerces dicts to len(), so
task-36's `capability_signals` would otherwise collapse to the constant 8 and never
reach the model. `_flatten_and_calibrate.py` lifts those to scalar cap_* columns and
drops provenance (advisory_ids/case_ids) before training. Even with the richest
features correctly exposed, the floor is 0.54 - the limitation is the corpus/feature
match, confirmed not a vectorization bug.
