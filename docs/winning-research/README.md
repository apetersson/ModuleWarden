# Winning research and corpus analysis

Research and analysis backing the Zero-One Hack submission. Each doc is
self-contained; the backlog (`backlog/decisions`, `backlog/tasks`) tracks the
actionable follow-ups so the `backlog` CLI surfaces them.

| Doc | What it covers |
|-----|----------------|
| `01-how-to-win.md` | Track 02 judging criteria, winning patterns, GitHub resources (OSSF feed, ATT&CK STIX, GHSA API) |
| `02-meta-harness-llm-wiki.md` | Meta-harness + LLM-wiki cultivation; how to prevent the wrong-codebase failure |
| `03-corpus-fit.md` | How the ZeroToOne_Data tarball corpus maps to the training pipeline; the data-flow glue to add |
| `04-safe-feature-extraction.md` | High-signal static features + safe tooling for analyzing live-malware tarballs without execution |
| `05-zerotoone-corpus-deep-dive.md` | Consolidated verdict: the corpus is the right fit; build plan; safety |
| `06-llm-wiki-for-models.md` | LLM-wiki knowledge graph for the auditor model + a Decepticon-owned attack-chain wiki (offense-feeds-defense) |
| `07-meta-harness-fit.md` | Fit of Stanford Meta-Harness (adopt) and BitGN-PAC (hardening reference, not a meta-harness) |

## ZeroToOne_Data corpus (decision-8, tasks 36-39)

The ~60GB Nextcloud corpus (`ZeroToOne_Data/finetune-data/raw-bundles/`) is
6,587 real npm tarballs, 3,778 vulnerable + 2,809 benign, produced by the
repo's own `finetune/scripts/download-raw-bundles.mjs`. The benign bucket is
the negative class the text corpus lacked (the reason `block_recall` is 0).
See `decision-8` for the verdict and `task-36` through `task-39` for the
leverage-ranked ingestion work. Ingestion is static-only; the vulnerable
tarballs are never executed.

## LLM-wiki + meta-harness (decision-9, tasks 40-43)

`06` designs an LLM-wiki for the models: an auditor wiki (BM25 RAG of prior
cases into the audit prompt, feeding back as SFT rows) and a Decepticon-owned
attack-chain wiki seeded from `demo/curated-threat-chains.json`. `07` assesses
Stanford Meta-Harness (HIGH fit, adopt - it auto-optimizes the audit harness
against our own eval metrics) and BitGN-PAC (not a meta-harness; adopt its B5
secret-redaction, B3 grounding-refs, B4 spiral-brake into the audit runner).
See `decision-9` and `task-40` through `task-43`.
