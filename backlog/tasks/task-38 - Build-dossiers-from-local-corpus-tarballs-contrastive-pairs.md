---
id: TASK-38
title: Build dossiers from local corpus tarballs (contrastive version pairs)
status: To Do
assignee: []
created_date: '2026-05-29 19:47'
labels: [corpus, finetune]
dependencies: [TASK-36]
ordinal: 54000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Build `finetune/scripts/build-dossiers-from-corpus.py`: full `affected` vs `first_patched` version-diff dossiers from the LOCAL corpus tarballs instead of live npm downloads. Match vulnerable + benign artifacts by `case_id` across `artifact-index.jsonl`, adapt `version_pair_extractor._diff_trees` / `_package_json_changes` to read local paths, produce real contrastive pairs (real sha256/integrity in the dossier), and feed `decepticon_augmentor` the richer records. Replaces the live-registry fetch in `corpus_walker -> extract_one()` with local reads (add `--local-corpus-only`).

Leverage: MEDIUM, ~4-5h, hackathon Day 2. The contrastive bad/good pair is the strongest training signal. SAFETY: static-only, `getmembers` not `extractall`, never execute, `normalize_dossier`. Depends on the task-36 extractor.
<!-- SECTION:DESCRIPTION:END -->
