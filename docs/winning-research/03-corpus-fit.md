# 03 Corpus Fit: 60 GB npm-Tarball Corpus into the ModuleWarden Training Pipeline

*Analyst: deep-analyst agent, 2026-05-29*

---

## 1. How the Corpus Is Produced and Synced

### download-raw-bundles.mjs

The script reads `scraped-cases-overnight.jsonl` (8,510 input cases) and produces two buckets of .tgz tarballs:

- `raw-bundles/vulnerable/<package>/<version>.tgz` - likely_affected versions
- `raw-bundles/benign/<package>/<version>.tgz` - first_patched versions

Planning phase: for each scraped case, the script fetches the npm packument once, resolves the `likely_affected` and `first_patched` versions, computes the tarball URL, and writes an entry into `artifact-index.jsonl`.

Download phase: fetches real .tgz tarballs from registry.npmjs.org or registry.yarnpkg.com only (SSRF allowlist enforced). Validates integrity (sha1 + SRI sha512) before promoting `.partial` to final. Supports resume and concurrency-8 by default.

The artifact index schema (`modulewarden.raw_bundle_artifact.v1`) carries: `bucket`, `role`, `package`, `version`, `path`, `url`, `integrity`, `shasum`, `unpacked_size`, `file_count`, `case_ids`, `advisory_ids`.

`unpacked_size` and `file_count` come from the npm packument's `dist` block - they are registry-declared metadata, not actually computed from the tgz contents.

### nextcloud-sync.sh

Thin curl wrapper over WebDAV for `ls`, `pull`, and `push` subcommands. Credentials from `.env`. Writes to `finetune/corpus/<basename>` by default. The actual tarballs live at `ZeroToOne_Data/finetune-data/raw-bundles/` on Nextcloud. No logic - it is purely a transfer utility.

---

## 2. Schema Mapping: artifact-index.v1 to the Existing Contracts

### Current pipeline (what already works)

```
scraped-cases.jsonl
 -> corpus_walker.py
 -> version_pair_extractor.extract_one() [fetches FRESH from registry]
 -> dossier_builder.build_dossier() [regex caps, file diffs]
 -> report_template.build_report()
 -> sft_pair_builder.build_sft_record()
 -> sft-records.jsonl
 -> decepticon_augmentor.py [injects ATT&CK kill chain]
 -> sft-records.attck.jsonl
```

### What the artifact-index.v1 provides vs what the pipeline needs

| Dossier Field | Current Source | What Corpus Could Provide |
|---|---|---|
| `package.candidate_tarball_sha256` | Hardcoded "sha256-unspecified" | Real sha256 from download event log |
| `package.candidate_integrity` | Hardcoded "sha512-unspecified" | Real SRI `integrity` from artifact-index |
| `diff_summary.files_added/modified/removed` | Live diff of fetched tarballs | Pre-computed from extracted tarball contents |
| `capability_deltas` | Regex over live-fetched diff | Same regex, but against local .tgz instead of live download |
| `baseline.tarball_sha256` | null | Real sha256 of the vulnerable .tgz |
| `release_context.source_tarball_mismatch` | Always False | Could be verified: sha256(local .tgz) vs packument integrity |
| `dynamic_observations.install_trace_refs` | Always empty | Could hold static install-script presence flags |
| `evidence_index` items of kind `static_capability` | From diff of live tarballs | From diff of local pre-downloaded tarballs |

The `file_count` and `unpacked_size` from artifact-index are registry-declared (not measured from the actual extracted tree). They map loosely to `diff_summary` totals but are not identical.

### The missing glue: a tarball-feature-extractor

The corpus has the tarballs on disk. The pipeline currently re-downloads them live via `version_pair_extractor.extract_one()`. The natural glue is a new step:

```
artifact-index.jsonl + local .tgz files
 -> tarball_feature_extractor.py (NEW)
 -> extract package.json, scan install scripts, run regex caps
 -> emit: tarball_features.jsonl (one row per artifact)
 -> schema: package, version, bucket, sha256, file_count_actual,
 unpacked_size_actual, install_scripts_present,
 install_script_bodies (truncated), capability_signals (dict)

artifact-index.jsonl + tarball_features.jsonl + scraped-cases.jsonl
 -> dossier_from_tarball.py (NEW)
 -> replaces version_pair_extractor.extract_one() for corpus artifacts
 -> reads local .tgz instead of live registry download
 -> passes FileChange list + package_json_changes to build_dossier()
 -> populates real candidate_integrity and candidate_tarball_sha256
```

The `dossier_builder.build_dossier()` API already accepts a `VersionPair` - it only needs the pair to be constructed from the local tarball rather than a fresh registry download.

---

## 3. The Key Opportunity: Benign Negatives

### Why block_recall is 0

The eval metrics (`finetune-metrics.attck.json`) show:

```
fine_tuned: block_total=0, block_recall_pct=null
```

`block_total=0` means the validation split had zero records with a ground-truth `block` or `quarantine` verdict. The fine-tune had 386 training records but `block_recall_pct` is null because the denominator is 0. This is the direct consequence of having only vulnerable/incident-replay cases with no genuine benign negative examples.

The 20 manually seeded packages in `finetune/python/data/benign-packages/extracted/` are well-known packages (axios, chalk, express, etc.) - useful for the synthetic injector as baselines but not large enough to drive a real benign signal through training.

### What the corpus enables

**A. Real malicious-vs-benign binary classifier (static features)**

The 2,809 benign artifacts are `first_patched` versions from real CVE/GHSA cases - the exact same packages, one version after the vulnerability. This is the ideal negative class: same package, realistic code, just without the attack. Running the existing capability-detection regexes (`_detect_caps_in_text`, `_detect_lifecycle_script_delta`) over the benign tarballs should produce a qualitatively different capability_deltas distribution from the vulnerable bucket. That contrast is the training signal.

Concretely: a benign SFT record has a dossier where `capability_deltas` is empty or low-severity and `policy_context.cold_start=false`, and the report verdict is `allow`. Training on this alongside the malicious records should push block_recall above 0 for the first time.

**B. Vulnerable-vs-first_patched contrastive pairs (what decepticon_augmentor wants)**

The decepticon_augmentor injects ATT&CK kill-chain narratives into records where `capability_deltas` is non-empty. For the augmentor to fire, the dossier needs real capability signals. The vulnerable tarballs should produce those signals; the first_patched tarballs should not (or produce lower-severity ones). Building paired dossiers from both gives the augmentor the contrastive training target it needs: vulnerable version -> BLOCK with kill chain; patched version -> ALLOW with no or reduced kill chain.

The artifact-index already links `case_ids` bidirectionally: every benign artifact maps back to the advisory cases that also have vulnerable counterparts. This linkage is the structural backbone of the contrastive pair.

**C. What the corpus cannot directly provide**

The `audit_mode: version_diff` path in `build_dossier()` needs a `VersionPair` with `unpatched_version` and `patched_version` and the diff between them. The corpus stores the two versions separately (not as a diff). A `dossier_from_tarball` builder needs to diff the local vulnerable .tgz against the local benign .tgz - exactly the same operation as `version_pair_extractor._diff_trees()` but reading from disk instead of a live download.

---

## 4. Files to Add: What Exists vs What's Missing

### Already exists (reusable without change)

| File | What it provides |
|---|---|
| `finetune/python/pipeline/version_pair_extractor.py` | `_safe_tar_extract`, `_diff_trees`, `_package_json_changes`, `_walk_textual_files` - all the extraction logic |
| `finetune/python/pipeline/dossier_builder.py` | `build_dossier(scraped_case, pair)` - accepts any VersionPair, not just live-fetched ones |
| `finetune/python/pipeline/corpus_walker.py` | Orchestration pattern, split assignment, output JSONL format |
| `finetune/python/decepticon/mapper.py` | ATT&CK mapping - fires on any capability_deltas list |
| `finetune/python/pipeline/decepticon_augmentor.py` | ATT&CK augmentation pass - works on any sft-records.jsonl |
| `finetune/scripts/download-raw-bundles.mjs` | Already downloaded and indexed the tarballs |
| `artifact-index.jsonl` | Maps every local .tgz to its case_ids and advisory_ids |

### Missing (needs to be created)

**File 1: `finetune/scripts/extract-tarball-features.py`** (or .mjs)

*Purpose*: Walk artifact-index.jsonl, for each .tgz at its local `path`, extract and scan statically.

*What it does (statically only, no execution)*:
- Open .tgz with `tarfile.open` using the existing `_safe_tar_extract` pattern (reject absolute paths, traversal, symlinks)
- Read `package/package.json` to extract: `name`, `version`, `scripts` (lifecycle hooks), `dependencies`, `devDependencies`, `main`, `bin`
- Walk all text files (`.js`, `.mjs`, `.json`, `.sh`, `.ts`) collecting content for regex scan
- Run all existing `_detect_caps_in_text` and `_detect_lifecycle_script_delta` regexes from `dossier_builder.py`
- Compute actual sha256 of the .tgz file (the downloader wrote sha1+sha256 to the event log already)
- Emit one row per artifact to `tarball-features.jsonl`

*Output schema (proposed `modulewarden.tarball_features.v1`)*:
```json
{
 "schema_version": "modulewarden.tarball_features.v1",
 "package": "lodash",
 "version": "4.17.20",
 "bucket": "vulnerable",
 "path": "/path/to/vulnerable/lodash/4.17.20.tgz",
 "tgz_sha256": "abc...",
 "tgz_sha1": "def...",
 "file_count_actual": 42,
 "unpacked_size_actual": 138000,
 "lifecycle_hooks_present": ["postinstall"],
 "lifecycle_script_bodies": {"postinstall": "node setup.js"},
 "capability_signals": {
 "lifecycle_script": true,
 "network_access": true,
 "credential_or_env_access": false,
 "process_execution": false,
 "dynamic_code_execution": false,
 "obfuscation": false,
 "filesystem_sensitive_access": false,
 "native_or_wasm": false
 },
 "capability_deltas": [...],
 "package_json_summary": {
 "has_install_script": true,
 "dep_count": 0,
 "dev_dep_count": 5
 },
 "advisory_ids": ["GHSA-xxx"],
 "case_ids": ["case_001"]
}
```

*Safety*: reads .tgz bytes only, no `tf.extractall`, no subprocess, no npm/node execution.

*Estimated effort*: ~200 LOC, ~2-3 hours. High reuse of existing patterns.

---

**File 2: `finetune/scripts/build-dossiers-from-corpus.py`**

*Purpose*: Build dossier+SFT record pairs from the pre-downloaded tarball corpus, replacing live registry calls in `corpus_walker.py` for cases where both bucket artifacts exist locally.

*What it does*:
- Read `artifact-index.jsonl` grouped by `case_ids`
- For each case that has both a vulnerable .tgz and a benign .tgz:
 - Extract both into a tempdir (using `_safe_tar_extract`)
 - Call `_diff_trees(unpatched_root, patched_root)` and `_package_json_changes()`
 - Construct a `VersionPair` with `extraction_method="local_tarball_diff"`
 - Call `build_dossier(scraped_case, pair)` with real sha256 and integrity values populated
 - Call `build_report()` and `build_sft_record()`
- For benign-only cases (no vulnerable counterpart): build a cold_start dossier from the benign .tgz alone

*Key difference from corpus_walker.py*: no live HTTP calls, no httpx dependency, processes from local files.

*Estimated effort*: ~300 LOC, ~4-5 hours. Largely a copy-adapt of corpus_walker.py with local-file I/O replacing `extract_one()`.

---

**File 3: `finetune/scripts/build-benign-sft-records.py`** (hackathon priority short-cut)

If building full dossier pairs is too slow for a hackathon, a faster path exists: build benign-only SFT records as `audit_mode: cold_start` using only the benign .tgz contents from `tarball_features.jsonl`. These records have empty or low-severity capability_deltas and a ground-truth ALLOW verdict. No diff needed. No scraped-case matching needed.

This is the minimum viable path to getting `block_total > 0` in the eval matrix.

*Estimated effort*: ~150 LOC, ~2 hours.

---

## 5. Safety Analysis

### The vulnerable tarballs are real malware. Static-only extraction discipline.

The existing tooling is already safe for the benign tarballs. For the vulnerable tarballs:

**Safe (already enforced in existing code)**:
- `tarfile.open` + manual member iteration - no `extractall`
- Path traversal filter (absolute paths, `..`, symlinks, hardlinks rejected)
- 50 MiB tarball cap (`MAX_TARBALL_BYTES`)
- 2 MiB per-file cap before treating as binary
- Regex scan on text content only - no eval, no exec, no subprocess

**Risks to flag**:

1. **Install scripts are NOT run**: `version_pair_extractor.py` never calls `npm install` or executes package.json scripts. The capability detection reads the script body as text and matches patterns. This is safe. The risk is that an analyst or operator might try to actually install a package from the corpus to "verify" behavior - that must never happen.

2. **Symlink extraction**: `_safe_tar_extract` rejects `issym()` and `islnk()` members. Some malicious packages use symlinks to escape the package directory. The current filter handles this.

3. **corpus_walker.py calls `httpx` live**: the existing walker re-downloads from npm.org. When using the local corpus, the new `build-dossiers-from-corpus.py` should NOT fall back to live download for corpus artifacts. This needs to be an explicit flag: `--local-corpus-only` to prevent accidental re-fetch of a malicious tarball from a registry.

4. **`.partial` files**: any incomplete download leaves a `.partial` file. The extractor should skip `.partial` files. The artifact-index only lists final (validated) paths, so reading from artifact-index is safe.

5. **Tarball content injection via package.json free-text fields**: the existing `normalize_dossier` call in `corpus_walker.py` strips invisible-unicode from free-text fields before they reach the model. The new corpus-based builder must call `normalize_dossier` too.

6. **No `node`, `npm`, `npx` calls anywhere in the ingestion path**: the new files must not shell out. The existing Python tooling is clean on this; any new MJS scripts should equally avoid executing package code.

---

## 6. Leverage-Ranked Implementation Order

| Priority | File | Effort | Unlocks | Hackathon fit |
|---|---|---|---|---|
| 1 (HIGH) | `extract-tarball-features.py` | 2-3h | tarball_features.jsonl; populates real capability_signals for 6,587 artifacts; feeds everything downstream | Day 1 morning |
| 2 (HIGH) | `build-benign-sft-records.py` | 2h | First benign SFT records; `block_total > 0` in eval; directly fixes block_recall=null | Day 1 afternoon |
| 3 (MEDIUM) | `build-dossiers-from-corpus.py` | 4-5h | Full version-diff dossiers with real sha256/integrity; contrastive vulnerable-vs-patched pairs at scale; feeds decepticon_augmentor with more augmentable records | Day 2 |
| 4 (LOW) | Schema version bump `modulewarden.tarball_features.v1` + JSON schema contract | 1h | Makes tarball_features.jsonl a first-class corpus artifact; enables future tooling to consume it | After Day 2 |

### Why this order

Step 1 is a read-only scan that produces no training data directly but proves the static extraction path works at scale and flags any corrupt .tgz files early. It also produces the `capability_signals` distribution across both buckets, which is the first empirical answer to "does the corpus separate malicious from benign?"

Step 2 is the minimum viable fix for block_recall=null. Even 200-300 benign cold_start records mixed into the training set should give the model enough signal to learn that not every package should be quarantined.

Step 3 enables the contrastive training path that the decepticon_augmentor was designed for but has never had real data for.

---

## 7. What the Corpus Does NOT Provide (Gaps)

- **Dynamic observations**: `install_trace_refs`, `network_trace_refs` remain empty. The corpus captures static snapshots only. Real dynamic traces require sandbox execution (Docker + strace/tcpdump) which is explicitly out of scope for static ingestion.
- **Cold-start benign diversity**: the 2,809 benign artifacts are all `first_patched` versions of previously-vulnerable packages. They are not a representative sample of the full npm ecosystem. The 20 manually seeded packages (axios, chalk, express, etc.) remain the only truly "never vulnerable" benign examples.
- **Typosquatting / name-confusion cases**: the corpus is built from GHSA/OSV advisories. Supply-chain cases that were caught before receiving an advisory are not represented.
- **Package version continuity**: for some packages the vulnerable and benign versions may differ by weeks; for others they differ by one patch commit. The corpus does not annotate this gap, which affects the signal quality of the diff.

---

## Summary

The 60 GB corpus maps cleanly onto the existing pipeline. The download tooling already enforces the safety guarantees (tarball allowlist, sha verification, no execution). The missing glue is two Python files totaling under 500 LOC that adapt the existing `version_pair_extractor` and `dossier_builder` logic to read from local disk instead of live registry calls. The single highest-leverage action for a hackathon is `build-benign-sft-records.py`: it directly converts the 2,809 benign first_patched tarballs into SFT records with ALLOW verdicts, which is the specific training signal that eliminates the block_recall=null failure observed in `finetune-metrics.attck.json`.
