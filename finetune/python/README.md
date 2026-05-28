# finetune/python

Python sibling to the existing `finetune/` directory. Conforms to the
contracts in `finetune/contracts/` (no parallel formats invented) and
drives the H100 training plus 4-arm evaluation matrix described in
`finetune/README.md`.

## Why this exists

`finetune/scripts/scrape-cases.mjs` produces normalized
`modulewarden.scraped_case.v1` records. Those records describe what the
auditor should know about a package version, not what the model should
see. The auditor model is trained against `audit_dossier.v1` ->
`audit_report.v1` pairs.

This directory provides the Python pipeline that converts scraped cases
into SFT records:

```
scrape-cases.mjs (existing TS)
   -> finetune/corpus/scraped-cases.jsonl (existing)
   -> finetune/python/pipeline/corpus_walker.py
      (version_pair_extractor + dossier_builder + report_template + sft_pair_builder)
   -> finetune/corpus/sft-records.jsonl
   -> finetune/python/training/sft_lora.py (Qwen3.6-27B + LoRA)
   -> trained checkpoint
   -> finetune/python/eval/matrix_runner.py (4-arm matrix)
   -> finetune/python/eval/results/matrix-{timestamp}.json
```

Every output document validates against the canonical JSON Schemas in
`finetune/contracts/`. The walker is idempotent: re-running on the same
scraped-cases.jsonl produces the same `audit_id`s and the same
train/validation/test split assignment.

## Directory layout

```
finetune/python/
├── README.md                    (you are here)
├── pyproject.toml
├── __init__.py
├── pipeline/                    schema-conformant record construction
│   ├── version_pair_extractor.py   cherrypicked from apiary
│   ├── dossier_builder.py          audit_dossier.v1
│   ├── report_template.py          audit_report.v1
│   ├── sft_pair_builder.py         sft_record.v1
│   └── corpus_walker.py            CLI: scraped-cases.jsonl -> sft-records.jsonl
├── training/
│   ├── abliteration.py             refusal-direction orthogonalization
│   ├── sft_lora.py                 trl.SFTTrainer + peft LoRA
│   ├── rehearsal.py                small-model smoke test
│   ├── sft_config_qwen36.yaml      Qwen3.6-27B LoRA hyperparams
│   ├── accelerate_multinode.yaml   8 nodes x 8 H100 FSDP config
│   ├── harmful_prompts.json        144 supply-chain attack prompts
│   └── harmless_prompts.json       150 benign npm questions
├── slurm/
│   └── train_qwen3.6.slurm         3-stage SLURM job (ablit -> SFT -> eval)
├── eval/
│   ├── matrix_runner.py            4-arm matrix per finetune/README.md
│   ├── metrics.py                  7 metrics from finetune/README.md
│   ├── pi_harness_wrapper.py       Node subprocess to packages/audit-runner
│   └── results/                    matrix-{timestamp}.json outputs
├── pitch/                          hackathon submission materials
│   ├── underwriter-economics.md    NAIC/Coalition/Verizon-anchored economics
│   ├── insurance-economics-slides.md
│   ├── slide-deck.md               12-slide ModuleWarden deck
│   └── README.md
└── tests/                          schema + builder smoke tests
```

## Pipeline runner

```bash
# 1. Make sure scraped cases exist (already there in the demo branch)
ls finetune/corpus/scraped-cases.jsonl

# 2. Walk scraped cases into SFT records (defaults: 4 concurrency, all cases)
python -m finetune.python.pipeline.corpus_walker \
    --scraped-cases finetune/corpus/scraped-cases.jsonl \
    --output finetune/corpus/sft-records.jsonl \
    --manifest finetune/corpus/sft-records.manifest.json \
    --max-cases 200 \
    --concurrency 4

# 3. Smoke-test the full abliteration + SFT loop on a small model in roughly 30 min
python -m finetune.python.training.rehearsal \
    --base-model Qwen/Qwen2.5-1.5B-Instruct \
    --quick \
    --sft-jsonl finetune/corpus/sft-records.jsonl

# 4. Submit the real Qwen3.6-27B job on 64 x H100
sbatch finetune/python/slurm/train_qwen3.6.slurm

# 5. Run the eval matrix on the test split (arms 1, 2)
python -m finetune.python.eval.matrix_runner \
    --sft-records finetune/corpus/sft-records.jsonl \
    --base-model Qwen/Qwen3.6-27B-Instruct \
    --finetuned-model models/mw-Qwen3.6-27B-Instruct-v1 \
    --arms 1,2 \
    --output-dir finetune/python/eval/results/
```

## 4-arm eval matrix

Verbatim from `finetune/README.md`:

| Arm | Configuration |
| --- | --- |
| 1 | base Qwen3.6-27B + one-shot prompt (dossier as input) |
| 2 | fine-tuned Qwen3.6-27B + same one-shot prompt |
| 3 | base Qwen3.6-27B + PI agentic harness via `packages/audit-runner` |
| 4 | fine-tuned Qwen3.6-27B + PI agentic harness seeded with arm-2 report |

Metrics tracked per arm and per case:

- `malicious_catch_rate`
- `false_quarantine_block_rate`
- `json_validity`
- `evidence_citation_accuracy`
- `missed_suspicious_total`
- runtime: `runtime_p50_s`, `runtime_p95_s`, `runtime_total_s`
- `tool_call_total`, `tool_call_avg`

Output: `finetune/python/eval/results/matrix-{timestamp}.json`.

The agentic arms (3 and 4) require the audit-runner package to be built:

```bash
pnpm --filter @modulewarden/audit-runner build
```

On a dev box where the runner is not built or `node` is missing, arms 3
and 4 still complete; each row is marked `status: unavailable` so the
matrix report makes the gap obvious instead of silently degrading.

## Compute requirements

| Stage | Hardware | Wall-clock |
| --- | --- | --- |
| Rehearsal on 1.5B | 1 x H100 or 1 x A100 80GB | 20 to 30 minutes |
| Abliteration on Qwen3.6-27B | 1 node, 8 x H100 | 60 to 90 minutes |
| Full SFT on Qwen3.6-27B | 8 nodes, 64 x H100 | 6 to 10 hours |
| 4-arm eval, arms 1 + 2, 200 cases | 1 x H100 | 60 to 120 minutes |

Run the rehearsal first. The pipeline often has a bug that only shows
up at training time; you do not want to burn 64 x H100 hours to discover
a tokenizer mismatch.

## Safety guarantees

This directory never executes any npm package and never invokes
`npm install`, `npm exec`, or any other package manager command. All
tarball handling uses the path-traversal-safe filter inherited from
`version_pair_extractor.py`:

- Hostname allowlist for npm registry tarball URLs.
- Reject absolute paths and `..` traversal in tar members.
- Reject symlink and hardlink tar members.
- Per-tarball byte cap (50 MiB default).
- Per-file diff cap (50 KiB default) so the SFT records stay bounded.

The walker writes only JSON. Nothing is shelled out, no subprocess is
spawned (the PI harness wrapper does shell out, but only when the eval
matrix explicitly requests arms 3 or 4 and only against the
`packages/audit-runner` orchestrator binary at a known location).

## Schema conformance

Every output document conforms to a schema in `finetune/contracts/`:

- `audit_dossier.v1`: built by `pipeline/dossier_builder.py`
- `audit_report.v1`: built by `pipeline/report_template.py`
- `sft_record.v1`: built by `pipeline/sft_pair_builder.py`

The test suite under `tests/` uses `jsonschema` to validate generated
records against the canonical schemas before any record is ever written
to disk during the smoke run.

## How the existing TS worker invokes this Python pipeline

The TS worker treats the corpus walker as a subprocess:

```ts
import { spawn } from 'node:child_process';

const proc = spawn('python', [
  '-m', 'finetune.python.pipeline.corpus_walker',
  '--scraped-cases', 'finetune/corpus/scraped-cases.jsonl',
  '--output', 'finetune/corpus/sft-records.jsonl',
  '--manifest', 'finetune/corpus/sft-records.manifest.json',
  '--concurrency', '4',
], { stdio: ['ignore', 'inherit', 'inherit'] });

proc.on('exit', (code) => {
  if (code !== 0) throw new Error(`corpus walker failed with code ${code}`);
});
```

The Python side does not import any TS or Node code. The two halves
compose at the JSONL boundary and at the `packages/audit-runner`
orchestrator binary (eval arms 3 and 4).

## Memory discipline

The walker defaults to `--concurrency 4`. The previous 17k-package
extraction with concurrency 16 ran the workstation out of memory. Stay
at 4 unless you can afford to OOM the host.
