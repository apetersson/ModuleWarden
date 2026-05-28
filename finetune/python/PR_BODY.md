# feat(finetune): Python H100 training + 4-arm eval matrix (apiary contribution)

Adds `finetune/python/`, the Python sibling to the existing TS-driven
`finetune/` directory. Every output document conforms to the canonical
schemas already in `finetune/contracts/`. No parallel formats are
invented.

## What this PR adds

`finetune/python/` with five subdirectories:

- `pipeline/` (5 modules): the scraped-cases.jsonl -> sft-records.jsonl
  pipeline. Builds `audit_dossier.v1`, `audit_report.v1`, and
  `sft_record.v1` documents that validate cleanly against the schemas
  in `finetune/contracts/`.
- `training/` (3 modules + 2 prompt files + 2 configs): abliteration
  (refusal-direction orthogonalization), SFT LoRA via trl + peft, and a
  small-model rehearsal harness for a 30-minute single-GPU smoke before
  the H100 burn.
- `slurm/` (1 script): 3-stage SLURM job for abliteration + 64-GPU FSDP
  SFT + eval matrix on Qwen3.6-27B.
- `eval/` (3 modules): the 4-arm eval matrix runner with the 7 metrics
  listed in `finetune/README.md`. The agentic arms shell out to
  `packages/audit-runner/dist/orchestrator.js` via a Node subprocess.
- `pitch/` (4 documents): insurance underwriting one-pager with NAIC,
  Coalition, Verizon, Sonatype, and Munich Re citations, plus the
  12-slide ModuleWarden hackathon deck.

## How it composes with the existing TS code

The two halves compose at the JSONL boundary and at the
`packages/audit-runner` orchestrator binary. There is no Python import
of TS code and no TS import of Python code.

```
finetune/scripts/scrape-cases.mjs (existing TS)
   -> finetune/corpus/scraped-cases.jsonl (existing)
   -> finetune/python/pipeline/corpus_walker.py (NEW)
   -> finetune/corpus/sft-records.jsonl
   -> finetune/python/training/sft_lora.py (NEW; Qwen3.6-27B + LoRA)
   -> trained checkpoint
   -> finetune/python/eval/matrix_runner.py (NEW; 4-arm matrix)
   -> finetune/python/eval/results/matrix-{timestamp}.json
```

The TS worker can drive the corpus walker as a subprocess:

```ts
spawn('python', [
  '-m', 'finetune.python.pipeline.corpus_walker',
  '--scraped-cases', 'finetune/corpus/scraped-cases.jsonl',
  '--output', 'finetune/corpus/sft-records.jsonl',
  '--manifest', 'finetune/corpus/sft-records.manifest.json',
  '--concurrency', '4',
]);
```

## Schemas this PR conforms to

Every produced document validates against:

- `finetune/contracts/audit-dossier.schema.json` (modulewarden.audit_dossier.v1)
- `finetune/contracts/audit-report.schema.json` (modulewarden.audit_report.v1)
- `finetune/contracts/sft-record.schema.json` (modulewarden.sft_record.v1)

The 7 tests in `finetune/python/tests/test_schema_conformance.py` run
the dossier builder + report template + SFT pair builder end to end on
a synthetic Class A "compromised maintainer" case and validate every
output against the canonical schemas. All 7 pass.

A real-data smoke test against 8 records from
`finetune/corpus/scraped-cases.jsonl` produced 4 SFT records (4 cases
skipped cleanly because they lacked both `likely_affected` and
`first_patched` roles). All 4 SFT records, all 4 embedded dossiers, and
all 4 embedded reports validate against the schemas.

## What is cherrypicked from the sibling apiary repo

| File | LOC | Source |
| --- | --- | --- |
| `pipeline/version_pair_extractor.py` | 703 | `apiary_train/version_pair_extractor.py` (verbatim minus logger rename) |
| `training/abliteration.py` | 388 | `apiary_train/abliteration.py` (verbatim minus logger rename and CLI description) |
| `training/sft_lora.py` | 305 | `apiary_train/sft_lora.py` (logger rename, default base model is now Qwen3.6-27B-Instruct) |
| `training/rehearsal.py` | 230 | `apiary_train/rehearsal.py` (rewritten to use the SFT JSONL contract directly) |
| `training/harmful_prompts.json` | 144 prompts | `apiary_train/harmful_prompts.json` (verbatim) |
| `training/harmless_prompts.json` | 150 prompts | `apiary_train/harmless_prompts.json` (verbatim) |
| `training/accelerate_multinode.yaml` | 45 | `apiary_train/accelerate_multinode.yaml` (verbatim) |
| `pitch/underwriter-economics.md` | 70 | `apiary/pitch/underwriter-economics.md` (verbatim) |
| `pitch/insurance-economics-slides.md` | 67 | `apiary/pitch/insurance-economics-slides.md` (verbatim) |
| `pitch/slide-deck.md` | 238 | `apiary/pitch/slide-deck.md` (adapted to ModuleWarden v2 framing) |

New code added in this PR:

| File | LOC | Purpose |
| --- | --- | --- |
| `pipeline/dossier_builder.py` | 462 | emit audit_dossier.v1 from VersionPair + scraped case |
| `pipeline/report_template.py` | 343 | emit ground-truth audit_report.v1 per labeling-rubric |
| `pipeline/sft_pair_builder.py` | 90 | pair (Dossier, Report) into sft_record.v1 |
| `pipeline/corpus_walker.py` | 287 | CLI: scraped-cases.jsonl -> sft-records.jsonl |
| `eval/metrics.py` | 187 | 7 metrics from finetune/README.md |
| `eval/pi_harness_wrapper.py` | 142 | Node subprocess wrapper for packages/audit-runner |
| `eval/matrix_runner.py` | 343 | 4-arm matrix runner with HF transformers |
| `slurm/train_qwen3.6.slurm` | 110 | 3-stage SLURM job |
| `training/sft_config_qwen36.yaml` | 35 | LoRA hyperparams |
| `tests/test_schema_conformance.py` | 188 | 7 schema + builder tests |
| `README.md` | 195 | directory README |
| `pitch/README.md` | 36 | pitch directory README |

## Smoke tests run before this PR

1. `python -m py_compile` on every Python file. Clean.
2. `python -m pytest finetune/python/tests/`. 7 passed in 0.34s.
3. `python -m finetune.python.pipeline.corpus_walker --max-cases 8` on
   the real `finetune/corpus/scraped-cases.jsonl`. 4 SFT records
   written, 4 skipped cleanly (the 4 skipped cases lacked both
   `likely_affected` and `first_patched` roles, which is expected per
   the scraped-case schema). Three real npm tarballs were fetched,
   diffed, and converted to dossiers without error.
4. Schema validation on all 4 produced SFT records and on every
   embedded dossier and report. All validate against the canonical
   `finetune/contracts/` schemas.

## Safety guarantees

- This directory never executes any npm package and never invokes
  `npm install` or `npm exec`.
- All tarball extraction uses a path-traversal-safe filter inherited
  from the cherrypicked `version_pair_extractor`. Absolute paths,
  `..` traversal, and symlink or hardlink tar members are rejected.
- Per-tarball byte cap is 50 MiB. Per-file diff cap is 50 KiB.
- Hostname allowlist for npm registry tarball URLs: only
  `registry.npmjs.org` and `registry.yarnpkg.com`.
- The corpus walker defaults to `--concurrency 4`. Higher values can
  OOM the host (this happened in an earlier 17k-package run with
  concurrency 16 and is documented in the README).

## Hackathon timeline

- 24 hours to submission.
- 64 x H100 SLURM job ready at `slurm/train_qwen3.6.slurm`.
- Rehearsal on Qwen2.5-1.5B can finish in 30 minutes on a single H100
  and validate the abliteration + SFT loop end to end before the big
  job goes in.
- 4-arm eval matrix runner is ready; arms 1 and 2 are HF
  `pipeline('text-generation')` calls, arms 3 and 4 shell out to the
  built `packages/audit-runner` orchestrator. On a dev box without the
  runner built, arms 3 and 4 are marked `status=unavailable` so the
  matrix still completes with no silent degradation.

## Open questions for Andreas

1. Approval to merge this branch into `main`?
2. Model id confirmation: `Qwen/Qwen3.6-27B-Instruct` is the current
   default. Should we lock to a specific HuggingFace revision SHA?
3. Compute access: do we have a CINECA Leonardo allocation or another
   64 x H100 cluster available, and from when?
4. Drive folder location for any additional fine-tune data you want to
   feed beyond the current scraped-cases.jsonl?
5. Eval matrix scope: ship all 4 arms for the demo or just arms A + B
   (one-shot before / after) to fit the 7-minute pitch window? Arms 3
   + 4 add 60 to 120 minutes of agentic runtime per test case.

---

The fine-tune target model and the 4-arm eval matrix in this PR follow
`finetune/README.md` verbatim. If any of the model choice, the matrix
configuration, or the schemas need to change, this branch can pick up
the changes before merge.
