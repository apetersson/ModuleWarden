# Smoke results

Real-hardware validation runs of the SFT-LoRA pipeline in
`finetune/python/training/sft_lora.py`. These are NOT the main
evaluation matrix (that lives one directory up in
`finetune/python/eval/matrix_runner.py`). The intent here is to prove
the training cohort actually works on a GPU before burning Leonardo
allocation hours on Saturday.

## What is recorded per smoke

Each smoke writes a JSON file named after the provider's instance id
that produced it. Required fields:

- `instance`: provider, gpu name, image, network metadata
- `pinned_versions`: exact versions of transformers + peft + trl +
  accelerate + datasets + bitsandbytes that produced the result
- `training`: model id, method (full SFT or QLoRA), LoRA config,
  schedule, mixed-precision setup
- `results`: loss curve (epoch + loss + grad_norm + lr per logged
  step), runtime, throughput
- `generation_smoke`: held-out prompt, decoded assistant tail,
  whether the output matches the expected audit-report shape
- `spend`: provider credit before, after, total consumed, with a
  breakdown when more than one run contributed
- `lessons_learned`: anything that should change in the next run

## How to reproduce one

The driver lives at `finetune/python/scripts/vast_smoke.py`. It:

1. Searches vast.ai for the cheapest single-GPU instance matching
   blacklist + CUDA + bandwidth + reliability filters carried over
   from the operational notes
2. Walks the candidate list on `no_such_ask` rejections
3. Creates the instance with `pytorch/pytorch:2.4.0-cuda12.4-cudnn9-runtime`
4. Onstart runs `pip install` against a pinned cohort, then the smoke
   training script
5. Polls instance logs until `SMOKE_COMPLETE` lands, instance dies, or
   the deadline hits
6. Destroys the instance (success or failure) so credit is never
   silently consumed

Pre-flight: the script requires `VAST_API_KEY` either set in env or
read from `~/.vast-key`. Cost ceiling is enforced by `MAX_PRICE_PER_HOUR`
and `MAX_WAIT_MINUTES` in the script.

```bash
# from finetune/python/scripts/ or repo root
python vast_smoke.py
# writes vast_smoke_<instance_id>.json on completion
```

## Current results

| File | Provider | GPU | Hours | Spend | Verdict |
|---|---|---|---|---|---|
| `vast_smoke_38255250.json` | vast.ai | A100 PCIE 1x | 0.13 | $0.33 | smoke_ok=true; loss 5.36 to 0.73 in 20 steps; generation emits valid audit-report-shaped JSON |

The A100 smoke confirms the requested pin cohort
(transformers 4.46 + peft 0.13 + trl 0.12 + accelerate 1.0.1 +
datasets 3.0.2 + bitsandbytes 0.44.1) imports cleanly and the
`processing_class=` SFTTrainer kwarg, `target_modules="all-linear"`
LoRA, and 4-bit base + bf16 compute with gradient_checkpointing(
`use_reentrant=False`) interop on a single GPU. The smoke does NOT
prove FSDP1 multi-GPU sharding, Qwen3.6-27B specifically (we ran
Qwen2.5-Coder-1.5B-Instruct), the pre-abliterated huihui-ai
checkpoint specifically, multi-node communication, or that
`all-linear` finds the Qwen3.6 Gated DeltaNet projections. See
`leonardo_handover_status.blockers_before_sbatch` in the JSON.

## Why this directory exists

The pitch deck claims the fine-tune pipeline is real, not vaporware.
A schema-conformant JSON in this directory is the cheap proof. A
judge who pulls this file can verify:

- the model id we ran
- the version cohort that produced the result
- the loss descent (gradient flow + LoRA wiring confirmed)
- a generation sample (decode + chat-template confirmed)
- the spend (so the run cost is auditable, not just claimed)
