---
id: TASK-37
title: Build benign SFT records from the corpus to fix block-recall
status: In Progress
assignee: []
created_date: '2026-05-29 19:46'
labels: [corpus, finetune, model]
dependencies: []
ordinal: 53000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Build `finetune/scripts/build-benign-sft-records.py`: the minimum viable fix for the fine-tune's `block_recall = 0`. The model defaults to "quarantine" because all 386 training records are malicious (no benign negatives). Walk the benign bucket (2,809 `first_patched` artifacts) from `artifact-index.jsonl`, run static capability detection (reuse the task-36 extractor / `dossier_builder`), build cold-start dossiers (`audit_mode="cold_start"`, no diff needed), set report verdict to ALLOW, call `normalize_dossier` then `build_sft_record`. Even 200-300 benign ALLOW records should break the always-quarantine collapse.

Leverage: HIGH, ~2h, hackathon Day 1. The honest result this enables is the first non-zero block-recall and a verdict distribution the model actually learns. SAFETY: static-only, never execute; `normalize_dossier` on every record. Pairs with decision-8.
<!-- SECTION:DESCRIPTION:END -->
