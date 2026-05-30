---
id: TASK-49
title: Qwen3.6 fine-tune validated on Leonardo (modern transformers 5.9 stack)
status: Done
assignee: []
created_date: '2026-05-30 01:13'
labels: []
dependencies: []
ordinal: 64000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Smoke-tested the production Qwen3.6 fine-tune on a08trc01 (4x A100-64GB) for Andreas. The abliterated huihui-Qwen3.6-27B is a qwen3_5 VLM; fine-tuning it text-only needs a NEW stack, not a pin bump: torch 2.6 (a torch-2.6 container, since transformers 5.9 imports torch.distributed.tensor.device_mesh), transformers 5.9.0, trl 1.5.1 (processing_class API), peft 0.19.1, accelerate 1.13.0, datasets 4.8.5, NO bitsandbytes (triton import needs a C compiler the runtime image lacks; bf16 fits 256GB). Load with config.language_model_only=True -> Qwen3_5ForCausalLM via AutoModelForCausalLM device_map=auto. Validated end to end: loss 5.83 -> 1.11, adapter saved, RC=0. Shipped: training/sft_qwen36.py, slurm/leonardo/prep-qwen36.slurm + train-qwen36.slurm, README section, pyproject training-qwen36 extra. Legacy sft_lora.py stays the transformers-4.46 text path.
<!-- SECTION:DESCRIPTION:END -->
