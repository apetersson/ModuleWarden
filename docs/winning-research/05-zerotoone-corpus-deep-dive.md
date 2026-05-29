# ZeroToOne_Data corpus: deep dive and fit assessment

Consolidates the live enumeration, a Trident consult, and two agent analyses
(`03-corpus-fit.md` repo side, `04-safe-feature-extraction.md` technique side).

## What the corpus actually is (enumerated live via WebDAV, metadata only)

On Nextcloud at `ZeroToOne_Data/finetune-data/raw-bundles/`, split into
`benign/` and `vulnerable/` trees of real npm `.tgz` tarballs. Actively
downloading: ~14 GiB present, growing toward the ~60 GB Andreas described.

From the manifests (`download-summary.json`, `artifact-index.jsonl`):

- 8,510 input cases (from `scraped-cases-overnight.jsonl`)
- 6,587 unique artifacts downloaded: **3,778 vulnerable + 2,809 benign**
- Per-artifact schema `modulewarden.raw_bundle_artifact.v1`: bucket
  (benign|vulnerable), role (`affected` vs `first_patched`), package, version,
  url, integrity, shasum, unpacked_size, file_count, case_ids, advisory_ids
- Produced by the repo's OWN `finetune/scripts/download-raw-bundles.mjs`
  (registry allowlist, sha+SRI verification, no execution) and synced via
  `nextcloud-sync.sh`.

## How it relates to the repo

This is not external data we have to bridge to. It is the artifact half of the
repo's own pipeline. Today `corpus_walker -> version_pair_extractor.extract_one()`
downloads tarballs LIVE from npm at training-prep time. This corpus is those
same tarballs, already fetched, labeled, and indexed. The artifact-index fields
slot directly into existing dossier fields (`integrity ->
package.candidate_integrity`, download `sha256 -> candidate_tarball_sha256`).

## Right fit? Yes, decisively, for one specific reason

The fine-tune's measured weakness is `block_recall = 0` with `block_total = 0`
in the eval: all 386 training records are malicious, so there are no benign
negatives and the model defaults to "quarantine." This corpus supplies **2,809
benign artifacts** (the `first_patched` clean side of real incidents). Running
the existing capability detectors over them yields empty/low `capability_deltas`,
which is exactly the ALLOW training signal the model has never seen.

It also unlocks the thing the GHSA-text corpus could not support: a real
malicious-vs-benign signal on STATIC features. The current benchmark
(arXiv:2603.27549, the figshare 13,708-package set) shows GuardDog-class static
features reach 93.32% F1, but that benchmark is malware-vs-benign typosquat
detection, a different problem. Measured on THIS corpus (GHSA advisory pairs,
where benign is the first-patched release of the same package), a static
cold-package classifier floors at AUROC 0.54: the absolute capability
inventories are near-identical between buckets, so the learnable signal is in
the version DELTA, not the cold package (see CLASSIFIER-FLOOR-FINDINGS.md and
decision-10). Our 3,778/2,809 split is a moderate imbalance; the delta is where
the signal lives.

Trident consult (codex/gemini/grok): endorsed. Gemini - "a fantastic
high-value dataset; transitioning from text-based GHSA advisories to actual
artifact data is exactly how you bridge the gap." The text-to-artifact
transition is the high-leverage move.

## What to build to use and expand it (leverage-ranked, hackathon-tractable)

The gap is data-flow, not schema. Three additive scripts, all read-only:

1. `extract-tarball-features.py` (2-3h) - static `.tgz` scan reusing the
   existing `dossier_builder` regexes (`_detect_caps_in_text`,
   `_detect_lifecycle_script_delta`) and `_safe_tar_extract`. Emits a
   `capability_signals` distribution across both buckets - the first empirical
   answer to "does the corpus separate malicious from benign?" ~30 min to scan
   6,587 tarballs.
2. `build-benign-sft-records.py` (2h) - walk the benign bucket, cold-start
   dossiers, ALLOW verdicts. The minimum viable fix for `block_recall = null`.
   Even 200-300 benign records should break the always-quarantine collapse.
3. `build-dossiers-from-corpus.py` (4-5h) - full `affected` vs `first_patched`
   version-diff pairs from local tarballs, feeding `decepticon_augmentor` richer
   contrastive records.

Optional real-classifier arm (figshare-benchmark path): the 20-feature static
extractor + GuardDog rule flags -> XGBoost/RandomForest, AUROC on a 20% holdout.
This is the honest "real malicious-vs-benign number" the text corpus could not
produce.

Further expansion: the figshare set (arXiv:2603.27549, 13,708 labeled, task-32
adapter) and the OSSF malicious-packages feed extend both buckets with more
benign and more confirmed-malware.

Reusable as-is: `_safe_tar_extract`, `_diff_trees`, `_package_json_changes`,
`build_dossier`, `decepticon_augmentor`, `normalize_dossier`.

## Safety (the throughline - the vulnerable bucket is live malware)

- Never `tarfile.extractall()`; iterate `getmembers()` with the existing
  reject filter (absolute paths, `..`, symlinks).
- Never shell out to `node`/`npm` or any subprocess on tarball contents; no
  `npm install`, no lifecycle scripts. Static read only.
- Call `normalize_dossier()` on every dossier (strips invisible-unicode
  injection from free-text fields before it reaches the model).
- Skip `.partial` files; add a `--local-corpus-only` flag so corpus ingestion
  can never fall back to the live registry.
- If using GuardDog/Packj or any container: mount the corpus read-only
  (`-v /corpus:/corpus:ro`), `--network none`, non-root user. GuardDog is
  static-only (safe); avoid any tool that executes the package.
- `unpacked_size` / `file_count` in the index are registry-declared metadata,
  not measured from the extracted tree - measure them at extraction if used as
  features.
