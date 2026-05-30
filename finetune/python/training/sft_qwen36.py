"""SFT a Qwen3.6 (qwen3_5) model on the modern transformers 5.x / trl 1.x stack.

The legacy training/sft_lora.py targets transformers 4.46 + trl 0.12 (the
text-only Qwen2.5 path). Qwen3.6 is a qwen3_5 vision-language model that needs
transformers >= 5.9 (which needs torch >= 2.6) and the trl 1.x API. This module
is that path, validated end to end on Leonardo (4x A100-64GB): the abliterated
huihui-Qwen3.6-27B loads text-only in bf16 sharded across the GPUs, LoRA attaches,
and trl trains (loss 5.83 -> 1.11 on the cve_diff corpus smoke).

Key differences from sft_lora.py:
  - load bf16 + device_map=auto (no bitsandbytes; its triton import needs a C
    compiler the pytorch runtime container lacks, and 27B bf16 fits in 256GB)
  - force config.language_model_only so the vision tower is skipped
  - trl 1.x: SFTConfig + SFTTrainer(processing_class=...) (not tokenizer=)

Env: MWMODEL (local model dir), MWCORPUS (sft-records jsonl), MWOUT (adapter out),
MW_EPOCHS (default 2), MW_MAX_STEPS (optional cap for a smoke), MW_MAX_LEN (2048),
MW_LORA_R (16), MW_LORA_ALPHA (32), MW_LORA_DROPOUT (0.05), MW_GRAD_ACCUM (8).
"""
import json
import os
import sys

import torch
from transformers import AutoConfig, AutoTokenizer

MODEL = os.environ["MWMODEL"]
CORPUS = os.environ["MWCORPUS"]
OUT = os.environ.get("MWOUT", os.path.join(os.environ.get("SCRATCH", "/tmp"), "qwen36-sft-adapter"))
EPOCHS = float(os.environ.get("MW_EPOCHS", "2"))
MAX_STEPS = int(os.environ.get("MW_MAX_STEPS", "-1"))
MAX_LEN = int(os.environ.get("MW_MAX_LEN", "2048"))
LORA_R = int(os.environ.get("MW_LORA_R", "16"))
LORA_ALPHA = int(os.environ.get("MW_LORA_ALPHA", "32"))
LORA_DROPOUT = float(os.environ.get("MW_LORA_DROPOUT", "0.05"))
GRAD_ACCUM = int(os.environ.get("MW_GRAD_ACCUM", "8"))


def log(m):
    print(f"=== {m} ===", flush=True)


def main():
    import transformers, trl
    log(f"transformers {transformers.__version__}; trl {trl.__version__}; torch {torch.__version__}")

    tok = AutoTokenizer.from_pretrained(MODEL, trust_remote_code=True)
    if tok.pad_token is None:
        tok.pad_token = tok.eos_token

    cfg = AutoConfig.from_pretrained(MODEL)
    if hasattr(cfg, "language_model_only"):
        cfg.language_model_only = True
    print("config:", cfg.model_type, getattr(cfg, "architectures", None), flush=True)

    log("load model bf16 device_map=auto (text-only, no bitsandbytes)")
    from transformers import AutoModelForCausalLM
    try:
        model = AutoModelForCausalLM.from_pretrained(
            MODEL, config=cfg, device_map="auto", dtype=torch.bfloat16, trust_remote_code=True,
        )
    except Exception as e:
        print("AutoModelForCausalLM failed:", type(e).__name__, str(e)[:240], flush=True)
        from transformers import AutoModelForImageTextToText
        model = AutoModelForImageTextToText.from_pretrained(
            MODEL, device_map="auto", dtype=torch.bfloat16, trust_remote_code=True,
        )
    print("loaded:", type(model).__name__, flush=True)
    model.config.use_cache = False
    if hasattr(model, "gradient_checkpointing_enable"):
        model.gradient_checkpointing_enable()

    log("LoRA")
    from peft import LoraConfig, get_peft_model
    model = get_peft_model(model, LoraConfig(
        r=LORA_R, lora_alpha=LORA_ALPHA, lora_dropout=LORA_DROPOUT, task_type="CAUSAL_LM",
        target_modules="all-linear",
    ))
    model.print_trainable_parameters()

    log("dataset (train split, chat format)")
    recs = []
    with open(CORPUS, encoding="utf-8") as fh:
        for line in fh:
            line = line.strip()
            if not line:
                continue
            r = json.loads(line)
            if r.get("split") == "train":
                recs.append({"messages": r["messages"]})
    if not recs:
        sys.exit("no train-split records in corpus")
    from datasets import Dataset
    ds = Dataset.from_list(recs)
    print("train records:", len(ds), flush=True)

    log("SFTTrainer (trl 1.x)")
    from trl import SFTConfig, SFTTrainer
    args = SFTConfig(
        output_dir=OUT, per_device_train_batch_size=1, gradient_accumulation_steps=GRAD_ACCUM,
        num_train_epochs=EPOCHS, max_steps=MAX_STEPS, learning_rate=2e-4,
        logging_steps=5, bf16=True, report_to=[], max_length=MAX_LEN,
        save_strategy="epoch", gradient_checkpointing=True, warmup_ratio=0.03,
    )
    trainer = SFTTrainer(model=model, args=args, train_dataset=ds, processing_class=tok)
    trainer.train()
    trainer.save_model(OUT)
    tok.save_pretrained(OUT)
    log(f"QWEN36_SFT_OK adapter={OUT}")


if __name__ == "__main__":
    main()
