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

## ZeroToOne_Data corpus (decision-8, tasks 36-39)

The ~60GB Nextcloud corpus (`ZeroToOne_Data/finetune-data/raw-bundles/`) is
6,587 real npm tarballs, 3,778 vulnerable + 2,809 benign, produced by the
repo's own `finetune/scripts/download-raw-bundles.mjs`. The benign bucket is
the negative class the text corpus lacked (the reason `block_recall` is 0).
See `decision-8` for the verdict and `task-36` through `task-39` for the
leverage-ranked ingestion work. Ingestion is static-only; the vulnerable
tarballs are never executed.
