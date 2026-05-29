---
id: TASK-39
title: Train a real malicious-vs-benign classifier on static features
status: Done
assignee: []
created_date: '2026-05-29 19:48'
updated_date: '2026-05-29 21:48'
labels:
  - corpus
  - model
  - eval
dependencies:
  - TASK-36
ordinal: 55000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Optional real-classifier arm, the honest "real number" the text corpus could not give. Using the task-36 `tarball-features.jsonl` (3,778 vulnerable + 2,809 benign), train an XGBoost / RandomForest on the static feature set (install-scripts, entropy, file_count, suspicious requires, obfuscation; optionally merge GuardDog rule flags). Report AUROC on a 20% stratified hold-out. The benchmark (arXiv:2603.27549, figshare 13,708-package set) shows GuardDog-class features reach ~93% F1, so a 20-feature extractor should clear AUROC 0.90. This gives ModuleWarden a genuine malicious-vs-benign metric alongside the generative auditor, with the deterministic gate still the verdict authority.

Leverage: MEDIUM (high pitch value - a real AUROC). SAFETY: features are extracted statically by task-36; the classifier never touches package code. See `docs/winning-research/04-safe-feature-extraction.md`.
<!-- SECTION:DESCRIPTION:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Measured CPU-only (sklearn GradientBoosting + a calibration layer adding PR-AUC, Brier, ECE, reliability diagram, split-conformal). cve_diff cold-package floor: AUROC 0.54 near-random, because both buckets are the same legit package at two versions so absolute capability features cannot separate them, the signal is in the delta. Malware split (282 CWE-506 vs 397 clean benign): AUROC 0.98 PR-AUC 0.99 Brier 0.03, but file_count drives 0.79 of importance so it is largely a size signal (droppers are tiny), real for standalone-malware detection only, not injected malware. The 0.90 figure in the description was borrowed from a typosquat malware-vs-clean benchmark and does not transfer to cve_diff.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Two regimes measured honestly: 0.54 cve_diff (need the delta), 0.98 malware-vs-clean (size-driven). Evidence finetune/python/eval/CLASSIFIER-FLOOR-FINDINGS.md + malware-split/. Scripts _subset_corpus_build.py, _flatten_and_calibrate.py, _malware_split_build.py.
<!-- SECTION:FINAL_SUMMARY:END -->
