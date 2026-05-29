---
id: decision-10
title: >-
  Pivot to the Forecast track: forecast the version DELTA (not the cold package);
  deterministic delta-gate is the verdict authority, model narrates
date: '2026-05-29 21:30'
status: proposed
---
## Context

Andrew and Andreas are moving from Track 02 (UNIQA conversational AI) to the
Zero-One Hack Forecast track (partner Sybilion, "probabilistic forecasting and
the agent layer that acts on it"). Concept: forecast the likelihood that a
dependency a developer is about to pull into the company codebase is a
supply-chain attack vector, then act on it at submission time. Threat model is
internal: the lazy submitter (pulls open-source without understanding dependency
risk) and the disgruntled submitter (deliberate compromise). Concept in
`docs/winning-research/08-forecast-track-pivot.md`. This decision is written
against the MEASURED corpus reality, not a borrowed benchmark.

## Decision

1. Forecast the version DELTA, not the cold package. Measured 2026-05-29
   (`finetune/python/eval/CLASSIFIER-FLOOR-FINDINGS.md`): a static classifier on
   the cold package floors at AUROC 0.54 on this corpus, because the corpus is
   GHSA advisory pairs (benign = first-patched release of a real package,
   vulnerable = affected release of the same kind). Absolute capability
   inventories are nearly identical between buckets; the model can only learn
   package size. The signal is in what CHANGED between versions: added lifecycle
   scripts, new capability deltas, new obfuscation, advisory match.

2. The deterministic delta-gate is the verdict authority. It already keys on the
   delta (`_detect_lifecycle_script_delta`, capability-delta detectors,
   `version_pair_extractor`). It is auditable and emits no fabricated score. The
   probabilistic layer is an enrichment that narrates, never the verdict.

3. Strike every "AUROC 0.90 / GuardDog 93 percent F1 / calibrated / conformal 98
   percent" claim from docs and decks. That figure is from malware-vs-benign
   typosquat detection, a different problem. Present the 0.54 cold-package
   measurement honestly as the empirical reason the architecture is
   gate-decides-model-narrates.

4. The probabilistic forecast layer scores the DELTA in embedding space against
   nearest-known-attack (task-18), GPU-deferred; scaffold ready. Do not promise a
   calibrated probability until it is measured on the delta.

## Consequences

- Tasks 36 (feature extract) and 39 (train classifier) are done as a measurement;
  their honest output is the 0.54 floor and the reason for it, not a headline
  number. The local eval artifacts (CLASSIFIER-FLOOR-FINDINGS.md,
  classifier-floor-metrics.json, the flatten+calibrate driver) record this.
- The forecast build now points at the delta-embedding layer (task-18) when the
  GPU is free, not at more cold-package rows.
- The MODEL_CARD and the website pitch need a pass that removes the 0.90 framing
  and leads with the delta-gate and the honest floor finding.
- Track 02 underwriter framing (decision-6) is superseded as the headline; the
  conversational agent and memo machinery are reused as the agent layer.
