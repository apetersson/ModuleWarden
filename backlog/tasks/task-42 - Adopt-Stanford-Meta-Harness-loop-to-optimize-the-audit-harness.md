---
id: TASK-42
title: Adopt Stanford Meta-Harness loop to optimize the audit harness
status: To Do
assignee: []
created_date: '2026-05-29 20:13'
labels: [meta-harness, eval, model]
dependencies: []
ordinal: 58000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Wire the Stanford Meta-Harness loop (arXiv:2603.28052, github.com/stanford-iris-lab/meta-harness; fit analysis in `docs/winning-research/07-meta-harness-fit.md`) to auto-optimize ModuleWarden's audit harness against its own eval. We already have 3 of 4 required pieces: scorer (local_finetune_eval.py emits verdict_match/block_recall), task set (validation split = search, test split = held-out), harness files (chat/prompts/system.md + the PromptDefensePolicy + dossier/report logic). Missing two, both 1-3h:
1. Per-case trace files: patch `_evaluate()` to write one JSON per case to `finetune/python/eval/traces/` (prompt_used, gold_verdict, model_verdict, raw_output, schema_valid).
2. `meta_harness_loop.sh`: copy harness files to `candidates/candidate-N/`, run eval, invoke `claude -p` over the candidates+traces filesystem, apply proposed edits, commit between iterations.

Objective: `0.6 * verdict_match_pct + 0.4 * block_recall_pct` (block-recall weighted higher - a missed block is the safety-critical failure). Build-now ~6-10h. Honest scope: the meta-harness headline numbers come from much larger runs; scope our claim to "self-improving audit harness, N iterations on the validation split."
<!-- SECTION:DESCRIPTION:END -->
