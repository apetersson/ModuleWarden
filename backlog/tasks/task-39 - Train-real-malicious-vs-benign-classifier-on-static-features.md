---
id: TASK-39
title: Train a real malicious-vs-benign classifier on static features
status: To Do
assignee: []
created_date: '2026-05-29 19:48'
labels: [corpus, model, eval]
dependencies: [TASK-36]
ordinal: 55000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Optional real-classifier arm, the honest "real number" the text corpus could not give. Using the task-36 `tarball-features.jsonl` (3,778 vulnerable + 2,809 benign), train an XGBoost / RandomForest on the static feature set (install-scripts, entropy, file_count, suspicious requires, obfuscation; optionally merge GuardDog rule flags). Report AUROC on a 20% stratified hold-out. The benchmark (arXiv:2603.27549, figshare 13,708-package set) shows GuardDog-class features reach ~93% F1, so a 20-feature extractor should clear AUROC 0.90. This gives ModuleWarden a genuine malicious-vs-benign metric alongside the generative auditor, with the deterministic gate still the verdict authority.

Leverage: MEDIUM (high pitch value - a real AUROC). SAFETY: features are extracted statically by task-36; the classifier never touches package code. See `docs/winning-research/04-safe-feature-extraction.md`.
<!-- SECTION:DESCRIPTION:END -->
