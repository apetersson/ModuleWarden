---
id: TASK-35
title: Ship served-path prompt defense (spotlight + instruction hierarchy)
status: Done
assignee: []
created_date: '2026-05-29 12:55'
labels: []
dependencies: []
ordinal: 51000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
The defense that runs on the served model (vLLM/llama.cpp, no residual hooks) - the missing third layer alongside train-time SFT and HF-path steering. serving/prompt_defense.py: build_audit_prompt normalizes + datamarks untrusted free-text and fences it under an instruction-hierarchy preamble; structural evidence intact. Versioned PromptDefensePolicy = update-without-retrain surface. make_defended_verdict_fn + undefended_policy plug into eval/injection_robustness for the same ASR-delta metric. 7 tests, suite green (59).
<!-- SECTION:DESCRIPTION:END -->
