---
id: decision-1
title: Finetune pipeline language (Python vs MJS) for hackathon ship
date: 2026-05-28
status: accepted
---

# Decision: Hybrid pipeline (Option C)

The Saturday data-pipeline run goes through the existing Python stack at
`finetune/python/pipeline/`. Andreas's `finetune/high-level-plan.md`
MJS architecture is the **Q3 post-hackathon target**.

## Context

ModuleWarden has two valid paths to produce `sft-records.jsonl` Saturday
morning:

1. **Python pipeline (existing, battle-tested):** `corpus_walker.py` ->
   `dossier_builder.py` -> `sft_pair_builder.py`, plus the 26-pattern
   synthetic `injector.py`, all schema-validated against the
   `audit_dossier.v1` and `audit_report.v1` contracts. Has tests.
   Runs in ~45 min on the existing scraped corpus.

2. **MJS pipeline (proposed):** three new tools per Andreas's
   `finetune/high-level-plan.md` (Steps 2, 4, 5): `build-dossiers.mjs`,
   `validate-audit-report.mjs`, `build-sft-records.mjs`. Plus
   integrating Semgrep + OSV-Scanner + TruffleHog + Syft/Grype for
   evidence. Architecturally cleaner (single-language repo except for
   trainers).

Decision required before Saturday morning because Recipe A on vast.ai
launches at 09:30 with whatever `sft-records.jsonl` exists.

## Consultation

Consulted five systems in parallel:

| System | Verdict |
|---|---|
| Trident Gemini | C (Hybrid) |
| Trident Grok | C (Hybrid) |
| Hermes-unified (Grok-routed) | C |
| Titan-agentic | C (Hybrid) |
| Pantheon tier-4 council (USD 0.50, 6 reviews) | C (Hybrid), MEDIUM confidence |

All five converged on Option C. Pantheon's council added the
load-bearing refinement: assign the parallel tracks explicitly so the
Saturday critical path stays Python while Andreas's architectural
contribution lands without blocking the demo.

Google deep-research was not invoked because the answer was
unambiguous after five sources.

## Decision

**Option C: Hybrid.** Specifically:

### Saturday critical path (Andrew owns)

1. Pull `scraped-cases.npm-enriched.jsonl` from Nextcloud
2. Run `node finetune/scripts/select-golden-cases.mjs --target 150 --max-per-cwe 8`
3. Seed benign packages: `bash finetune/python/data/benign-packages/seed.sh`
4. Run corpus walker as module: `python -m finetune.python.pipeline.corpus_walker
   --scraped-cases finetune/corpus/scraped-cases-overnight.jsonl
   --output finetune/corpus/sft-records.jsonl
   --concurrency 4 --max-cases 600 --verbose` (about 45 min)
5. Rehearsal smoke on Qwen2.5-1.5B
6. Launch Recipe A on vast.ai (Recipe B on Leonardo once the project ID
   arrives Saturday afternoon)
7. Run SecLens-R 4-arm eval matrix when the checkpoint lands

### Saturday parallel track (Andreas owns)

Build `finetune/scripts/validate-audit-report.mjs` only.

This is Step 4 from `high-level-plan.md`: a JSON-schema validator for
`audit_report.v1`. Smallest surface area, highest reuse value because
the same validator is the type-safety boundary in the production
`packages/audit-runner/` worker. Implementing it now gives the Saturday
training output an extra correctness gate (the Python `sft_pair_builder.py`
produces records; the MJS validator checks every line before vast.ai
training begins) AND lands the first concrete piece of the architecture
target.

Zero critical-path risk because if `validate-audit-report.mjs` is not
ready by Saturday afternoon, the Python pipeline still ships the demo
unblocked.

### Sunday pitch

Demo on the existing Python-trained checkpoint. Reference Andreas's
`high-level-plan.md` as the Q3 architecture roadmap in Slide 8.

### Post-hackathon Q3 refactor

Port `build-dossiers.mjs` and `build-sft-records.mjs` to TypeScript,
backed by tests mirroring the Python suite. Retire `dossier_builder.py`
and `sft_pair_builder.py` once parity is established. Keep
`injector.py`, `sft_lora.py`, and `abliteration.py` in Python
permanently. ML tooling stays in the ML ecosystem.

## What this rejects

- **Option A (keep Python only):** dismisses Andreas's architectural
  contribution. The MJS direction is sound for production unification.
- **Option B (replace with MJS for Saturday):** would gamble 6 to 8 hours
  of untested greenfield work against an immovable Sunday 13:30
  deadline. The 26-pattern `injector.py` alone is days of port work and
  is required to produce the synthetic Class A and Class C examples.
- **Option D:** no fourth path that all five systems considered worth
  defending was surfaced.

## What still needs human input

- Andreas confirms the parallel-track assignment of
  `validate-audit-report.mjs` to him for Saturday.
- Andreas decides whether Step 3 (Semgrep + OSV-Scanner + TruffleHog +
  Syft/Grype evidence integration) is in scope for the Q3 refactor or
  whether each tool gets its own follow-up Backlog task.

## References

- `finetune/high-level-plan.md` (Andreas, 2026-05-28)
- `finetune/corpus/FINETUNE-DATA-PLAN.md` (Saturday timeline)
- Backlog: TASK-22 (the decision), TASK-18 / TASK-19 / TASK-20 (the
  three MJS tools as Q3 follow-ups), TASK-21 (external-tools integration)
