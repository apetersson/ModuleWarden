---
id: TASK-36
title: Extract static features from the ZeroToOne tarball corpus
status: To Do
assignee: []
created_date: '2026-05-29 19:45'
labels: [corpus, finetune, safety]
dependencies: []
ordinal: 52000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Build `finetune/scripts/extract-tarball-features.py`: a read-only static scan of the ZeroToOne_Data raw-bundles corpus (6,587 .tgz, benign + vulnerable). For each artifact in `artifact-index.jsonl`, open with `tarfile.open(path, "r:*")`, iterate `getmembers()` with the existing reject filter from `version_pair_extractor._safe_tar_extract` (no absolute paths, no `..`, no symlinks), read `package/package.json`, and apply the existing `dossier_builder` regexes (`_detect_caps_in_text`, `_detect_lifecycle_script_delta`) plus entropy + file_count. Emit `tarball-features.jsonl` (one row per artifact) and print the capability-signal distribution across both buckets - the first empirical answer to "does the corpus separate malicious from benign?".

Leverage: HIGH. ~30 min to scan all 6,587. Foundation for tasks 37-39.

SAFETY (vulnerable bucket is live malware): never `tarfile.extractall`; never shell out to node/npm; static read only; add `--local-corpus-only`; skip `.partial` files. See `docs/winning-research/03-corpus-fit.md` and `04-safe-feature-extraction.md`.
<!-- SECTION:DESCRIPTION:END -->
