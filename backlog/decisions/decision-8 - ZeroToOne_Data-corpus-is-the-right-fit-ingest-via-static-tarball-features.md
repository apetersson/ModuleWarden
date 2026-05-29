---
id: decision-8
title: >-
  ZeroToOne_Data 60GB corpus is the right fit; ingest via static tarball
  features (never execute the malware)
date: '2026-05-29 19:45'
status: accepted
---
## Context

Andreas provided a ~60GB corpus on Nextcloud at
`ZeroToOne_Data/finetune-data/raw-bundles/` (actively downloading, ~14GiB so
far) of real npm package tarballs, split benign vs vulnerable. Enumerated live
over WebDAV (metadata only): 6,587 artifacts, 3,778 vulnerable + 2,809 benign,
schema `modulewarden.raw_bundle_artifact.v1`, produced by the repo's own
`finetune/scripts/download-raw-bundles.mjs`.

Full deep dive: `docs/winning-research/05-zerotoone-corpus-deep-dive.md`
(verdict), `03-corpus-fit.md` (repo mapping + build plan), and
`04-safe-feature-extraction.md` (features, safe tooling). Trident consulted
(codex/gemini/grok): endorsed the text-to-artifact transition.

## Decision

Use the corpus. It is the right fit for one specific, measured reason: the
fine-tune's `block_recall` is 0 because all 386 training records are malicious
with no benign negatives. The 2,809 benign `first_patched` artifacts are
exactly the ALLOW signal the model has never seen. The corpus also unlocks a
real malicious-vs-benign static-feature signal (benchmark arXiv:2603.27549:
GuardDog-class features 93% F1).

Ingest path is data-flow glue, not schema work: the artifact-index fields slot
into existing dossier fields, and `dossier_builder` regexes + `_safe_tar_extract`
+ `build_dossier` + `decepticon_augmentor` are reused as-is. Tracked as
tasks 36-39, leverage-ranked.

## Consequences

- Ingestion is STATIC-ONLY. The vulnerable bucket is live malware. Never
  `tarfile.extractall`, never shell to node/npm, never run install-scripts;
  always `normalize_dossier` (strips unicode injection); read-only mount +
  `--network none` for any container; GuardDog (static) over any executing tool.
- The honest "real model number" the text corpus could not produce (block
  detection, a real AUROC) becomes possible once the benign negatives are in.
- The 60GB must be synced locally before the extractor runs; the download is
  in progress. Scripts are written to read local paths with a
  `--local-corpus-only` flag (no live-registry fallback for corpus artifacts).
