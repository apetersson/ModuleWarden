# Fine-tuning method (and why we abliterate ourselves, not pull a pre-abliterated GGUF)

How ModuleWarden fine-tunes its auditor model, and the reasoning for running our
own abliteration on official base weights rather than adopting a community
pre-abliterated model. Written for the Forecast-track build (the method is the
same; only the SFT target text changes with the pivot, see the last section).

## The stack: TRL + PEFT + bitsandbytes QLoRA (not Unsloth)

The trainer is the standard HuggingFace training trio:

- `trl.SFTTrainer` for the supervised fine-tune loop
- `peft.LoraConfig` + `get_peft_model` for the LoRA adapter
- `bitsandbytes` 4-bit QLoRA for fitting a useful base on one GPU

It lives in `finetune/python/training/sft_lora.py` and is proven end-to-end on a
rented GPU (`finetune/python/eval/smoke_results/vast_smoke_38255250.json`).

Unsloth was logged as an optional speed swap (`backlog/tasks/task-27`, status
"TBD pending validation"), never the chosen path. Unsloth pins its own patched
`transformers` builds, which risks version conflicts mid-event, and it buys
speed, not capability. We chose the vanilla TRL/PEFT/bitsandbytes path because it
is auditable, reproducible, and the JSON-validity win comes from constrained
decoding, not from the trainer.

## Two stages: abliterate, then QLoRA SFT

1. Abliteration (`finetune/python/training/abliteration.py`). Runs first on the
   official base weights. KL-optimized (heretic-style) removal of the model's
   refusal directions, so a security model describes malicious package behavior
   for audit instead of refusing. Output is an abliterated base checkpoint.
2. QLoRA SFT (`finetune/python/training/sft_lora.py`). Trains a LoRA adapter on
   the abliterated base, turning it into a structured-JSON auditor. This is the
   "abliterate + SFT" path that task-40 / PR #26 smoke-proved.

## The QLoRA config

- 4-bit nf4 quantization, bf16 compute dtype, double quant (bitsandbytes
  `load_in_4bit`).
- LoRA r 16 to 64, alpha 32 to 128, dropout 0 to 0.05, target modules = all
  attention and MLP projections (`q,k,v,o,gate,up,down_proj`).
- Packing on, gradient checkpointing on, max_seq_len 8192, AdamW.

## Model and where it runs

- Proven today: Qwen2.5-Coder-1.5B-Instruct, QLoRA on a vast.ai A100 PCIE
  (about 1.40 USD/hr, instance 38255250). The smoke logged a real dropping loss
  curve and saved an adapter, so the loop works on real hardware.
- The local box runs a 0.5B CPU-sized rehearsal plus the honest held-out eval
  (`local_finetune_eval.py`: schema-valid-JSON rate, verdict-match, block-recall).
- A larger base (the config default points at a 27B-class Qwen) is the GPU
  scale-up path, gated on HPC, not claimed as done.
- Pinned, reproducible versions: transformers 4.46.0, peft 0.13.0, trl 0.12.0,
  accelerate 1.0.1, datasets 3.0.2, bitsandbytes 0.44.1, on torch 2.4 / CUDA 12.4.
  Multi-node is wired via an accelerate FSDP config for the full run.

## Inference-time JSON guarantee

Constrained decoding (`finetune/python/eval/minionerec_constraint.py`,
`constrained_decode.py`), MiniOneRec/outlines-style, forces schema-valid output.
That is `backlog/decisions/decision-3`.

## Why not just use a pre-abliterated GGUF

Example raised: `llmfan46/Qwen3.6-27B-uncensored-heretic-v2-Native-MTP-Preserved-GGUF`
(recent, about 99K downloads, Apache-2.0, heretic-v2 KL-abliteration, MTP head
preserved). The method is good. It is the same abliteration lineage we run. The
problem is not the method, it is the artifact and the provenance.

1. GGUF is an inference format, not a training format. GGUF is the llama.cpp
   serving format. The QLoRA training stack (TRL / PEFT / transformers /
   bitsandbytes) attaches LoRA adapters and backprops on HF-format bf16/fp16
   safetensors. You cannot fine-tune a GGUF directly. To train on it you would
   convert GGUF back to HF, but the GGUF is already quantized, so you would be
   training on de-quantized, degraded weights and then re-quantizing for serving.
   That is a double quantization loss. The correct order is bf16 base, then
   abliterate, then QLoRA train, then quantize (GGUF included) for inference if
   wanted. So for the training stage a GGUF is the wrong input.

2. Provenance is the whole product. ModuleWarden exists because you cannot trust a
   third party's self-attestation about what is inside a dependency. Importing an
   anonymous community member's repackaged weights as the brain of a
   supply-chain-security tool is the exact anti-pattern we sell against. We cannot
   attest those weights are free of data poisoning or a behavioral backdoor.
   Running official Qwen weights through our own abliteration script is
   reproducible and auditable end to end: official base, our script, our SFT, our
   eval. Shipping a model whose own supply chain we cannot verify would undercut
   the pitch on stage.

3. We control the abliteration target. Our abliteration tunes the KL trade-off to
   remove only the refusal vectors that block malware description. A generic
   "uncensored" abliteration is optimized for broad uncensoring, which can
   over-abliterate and degrade task capability, or miss the exact refusal vectors
   we care about. Running it ourselves keeps that trade-off under our control.

4. Reproducibility for judges. "Official Qwen plus our abliteration script plus
   QLoRA" reproduces from scratch. "We downloaded heretic-v2" is unreproducible
   the day that repo is renamed, pulled, or found tainted, which takes the result
   down with it.

Fair caveat: if we only needed an inference fallback (no fine-tune) and accepted
the provenance hop, a pre-abliterated GGUF is a legitimate time-saver, and this
one is a strong pick on recency and adoption. It is just the wrong artifact for
the training stage, and an awkward trust dependency for a security product whose
entire thesis is "verify, do not trust the upstream blob."

## How this maps to the Forecast-track pivot

The fine-tune itself does not change. The model is trained to emit a structured
report from a dossier and to narrate the decision. The deterministic delta-gate
stays the verdict authority; the fine-tuned model explains it, never overrides it.
What changes with the pivot is only the SFT target text (the insurance memo
becomes the Forecast Evidence Memo) and the corpus framing. See
`docs/winning-research/08-forecast-track-pivot.md`.
