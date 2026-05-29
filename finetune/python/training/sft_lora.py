"""LoRA supervised fine-tune via trl.SFTTrainer + peft.

Drives the second stage of the v3 training pipeline: takes the
abliterated base model and an SFT JSONL produced by
``apiary_train.data_prep`` and trains a LoRA adapter that turns
the model into a structured-JSON npm auditor.

Multi-node FSDP is configured via the accelerate config at
``apiary_train/accelerate_multinode.yaml``. Launch with
``accelerate launch --config_file ...``; this module also supports
single-GPU runs for the rehearsal pipeline.
"""

from __future__ import annotations

import argparse
import json
import logging
import os
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Sequence

logger = logging.getLogger("modulewarden.sft_lora")


@dataclass
class SftConfig:
    """All knobs in one place; CLI args map directly into here."""

    base_model: str
    train_data: Path
    output: Path
    abliterated_model: Path | None = None
    eval_data: Path | None = None
    batch_size: int = 4
    grad_accum: int = 8
    epochs: int = 2
    lr: float = 1e-4
    warmup_ratio: float = 0.03
    weight_decay: float = 0.0
    lora_r: int = 64
    lora_alpha: int = 128
    lora_dropout: float = 0.05
    lora_target_modules: list[str] = field(
        default_factory=lambda: ["q_proj", "k_proj", "v_proj", "o_proj", "gate_proj", "up_proj", "down_proj"]
    )
    max_seq_len: int = 8192
    bf16: bool = True
    fp16: bool = False
    gradient_checkpointing: bool = True
    packing: bool = True
    save_steps: int = 250
    eval_steps: int = 250
    logging_steps: int = 10
    report_to: str = "none"
    push_to_hub: bool = False
    hub_model_id: str | None = None
    seed: int = 42
    save_total_limit: int = 3
    optim: str = "adamw_torch"
    dtype: str = "bfloat16"
    load_in_4bit: bool = False


def _require(module: str) -> Any:
    try:
        return __import__(module)
    except ImportError as exc:
        raise RuntimeError(
            f"{module} is required for SFT; pip install {module}"
        ) from exc


def _load_jsonl_dataset(path: Path) -> Any:
    """Read a JSONL of {messages, meta} records into a HF Dataset."""
    datasets = _require("datasets")
    rows: list[dict[str, Any]] = []
    with Path(path).open("r", encoding="utf-8") as fh:
        for line in fh:
            line = line.strip()
            if not line:
                continue
            try:
                rec = json.loads(line)
            except json.JSONDecodeError:
                continue
            if "messages" not in rec:
                continue
            rows.append({"messages": rec["messages"]})
    logger.info("loaded %d records from %s", len(rows), path)
    return datasets.Dataset.from_list(rows)


def _build_lora_config(cfg: SftConfig) -> Any:
    peft = _require("peft")
    return peft.LoraConfig(
        r=cfg.lora_r,
        lora_alpha=cfg.lora_alpha,
        lora_dropout=cfg.lora_dropout,
        bias="none",
        task_type="CAUSAL_LM",
        target_modules=cfg.lora_target_modules,
    )


def _resolve_dtype(cfg: SftConfig) -> Any:
    torch = _require("torch")
    if cfg.bf16:
        return torch.bfloat16
    if cfg.fp16:
        return torch.float16
    return torch.float32


def _load_base_model(cfg: SftConfig) -> tuple[Any, Any]:
    transformers = _require("transformers")
    AutoTokenizer = transformers.AutoTokenizer
    AutoModelForCausalLM = transformers.AutoModelForCausalLM
    source = str(cfg.abliterated_model) if cfg.abliterated_model else cfg.base_model
    logger.info("loading model weights from %s", source)
    tokenizer = AutoTokenizer.from_pretrained(source, trust_remote_code=True)
    if tokenizer.pad_token is None:
        tokenizer.pad_token = tokenizer.eos_token
    kwargs: dict[str, Any] = {
        "trust_remote_code": True,
        "torch_dtype": _resolve_dtype(cfg),
    }
    if cfg.load_in_4bit:
        try:
            bnb = _require("bitsandbytes")
            del bnb  # presence check
            kwargs["load_in_4bit"] = True
        except RuntimeError:
            logger.warning("bitsandbytes missing; falling back to full precision")
    model = AutoModelForCausalLM.from_pretrained(source, **kwargs)
    if cfg.gradient_checkpointing and hasattr(model, "gradient_checkpointing_enable"):
        model.gradient_checkpointing_enable()
        model.config.use_cache = False
    return model, tokenizer


def _build_training_arguments(cfg: SftConfig) -> Any:
    trl = _require("trl")
    sft_args_cls = getattr(trl, "SFTConfig", None)
    if sft_args_cls is None:
        # older trl exposes TrainingArguments only
        transformers = _require("transformers")
        sft_args_cls = transformers.TrainingArguments
    return sft_args_cls(
        output_dir=str(cfg.output),
        num_train_epochs=cfg.epochs,
        per_device_train_batch_size=cfg.batch_size,
        per_device_eval_batch_size=cfg.batch_size,
        gradient_accumulation_steps=cfg.grad_accum,
        learning_rate=cfg.lr,
        warmup_ratio=cfg.warmup_ratio,
        weight_decay=cfg.weight_decay,
        bf16=cfg.bf16,
        fp16=cfg.fp16,
        logging_steps=cfg.logging_steps,
        save_steps=cfg.save_steps,
        eval_steps=cfg.eval_steps,
        save_total_limit=cfg.save_total_limit,
        optim=cfg.optim,
        report_to=cfg.report_to,
        push_to_hub=cfg.push_to_hub,
        hub_model_id=cfg.hub_model_id,
        gradient_checkpointing=cfg.gradient_checkpointing,
        seed=cfg.seed,
        max_seq_length=cfg.max_seq_len,
        packing=cfg.packing,
    )


def train(cfg: SftConfig) -> None:
    """Run the SFT loop. Saves adapter + tokenizer to ``cfg.output``."""
    trl = _require("trl")
    peft = _require("peft")
    cfg.output = Path(cfg.output)
    cfg.output.mkdir(parents=True, exist_ok=True)

    train_ds = _load_jsonl_dataset(cfg.train_data)
    eval_ds = _load_jsonl_dataset(cfg.eval_data) if cfg.eval_data else None

    model, tokenizer = _load_base_model(cfg)
    lora_cfg = _build_lora_config(cfg)
    model = peft.get_peft_model(model, lora_cfg)
    if hasattr(model, "print_trainable_parameters"):
        model.print_trainable_parameters()

    train_args = _build_training_arguments(cfg)
    trainer = trl.SFTTrainer(
        model=model,
        tokenizer=tokenizer,
        args=train_args,
        train_dataset=train_ds,
        eval_dataset=eval_ds,
    )
    logger.info("starting SFT (epochs=%d, lr=%.2e)", cfg.epochs, cfg.lr)
    trainer.train()
    trainer.save_model(str(cfg.output))
    tokenizer.save_pretrained(str(cfg.output))
    (cfg.output / "modulewarden_sft_config.json").write_text(
        json.dumps(
            {
                "base_model": cfg.base_model,
                "abliterated_model": str(cfg.abliterated_model) if cfg.abliterated_model else None,
                "epochs": cfg.epochs,
                "lr": cfg.lr,
                "lora_r": cfg.lora_r,
                "lora_alpha": cfg.lora_alpha,
                "lora_target_modules": cfg.lora_target_modules,
                "max_seq_len": cfg.max_seq_len,
            },
            indent=2,
        ),
        encoding="utf-8",
    )
    logger.info("saved adapter + tokenizer to %s", cfg.output)


def _build_arg_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(description="ModuleWarden SFT LoRA trainer")
    p.add_argument(
        "--base-model",
        default="Qwen/Qwen3.6-27B-Instruct",
        help=(
            "HF model id. Defaults to Qwen/Qwen3.6-27B-Instruct per the model "
            "choice in finetune/README.md."
        ),
    )
    p.add_argument("--abliterated-model", type=Path, default=None)
    p.add_argument("--train-data", required=True, type=Path)
    p.add_argument("--eval-data", type=Path, default=None)
    p.add_argument("--output", required=True, type=Path)
    p.add_argument("--batch-size", type=int, default=4)
    p.add_argument("--grad-accum", type=int, default=8)
    p.add_argument("--epochs", type=int, default=2)
    p.add_argument("--lr", type=float, default=1e-4)
    p.add_argument("--warmup-ratio", type=float, default=0.03)
    p.add_argument("--weight-decay", type=float, default=0.0)
    p.add_argument("--lora-r", type=int, default=64)
    p.add_argument("--lora-alpha", type=int, default=128)
    p.add_argument("--lora-dropout", type=float, default=0.05)
    p.add_argument(
        "--lora-target-modules",
        type=str,
        default="q_proj,k_proj,v_proj,o_proj,gate_proj,up_proj,down_proj",
    )
    p.add_argument("--max-seq-len", type=int, default=8192)
    p.add_argument("--bf16", action="store_true", default=True)
    p.add_argument("--fp16", action="store_true", default=False)
    p.add_argument("--no-gradient-checkpointing", dest="gradient_checkpointing", action="store_false")
    p.add_argument("--no-packing", dest="packing", action="store_false")
    p.add_argument("--save-steps", type=int, default=250)
    p.add_argument("--eval-steps", type=int, default=250)
    p.add_argument("--logging-steps", type=int, default=10)
    p.add_argument("--report-to", default="none")
    p.add_argument("--push-to-hub", action="store_true")
    p.add_argument("--hub-model-id", default=None)
    p.add_argument("--seed", type=int, default=42)
    p.add_argument("--load-in-4bit", action="store_true")
    p.add_argument("-v", "--verbose", action="store_true")
    return p


def main(argv: Sequence[str] | None = None) -> int:
    args = _build_arg_parser().parse_args(argv)
    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s %(message)s",
    )
    cfg = SftConfig(
        base_model=args.base_model,
        abliterated_model=args.abliterated_model,
        train_data=args.train_data,
        eval_data=args.eval_data,
        output=args.output,
        batch_size=args.batch_size,
        grad_accum=args.grad_accum,
        epochs=args.epochs,
        lr=args.lr,
        warmup_ratio=args.warmup_ratio,
        weight_decay=args.weight_decay,
        lora_r=args.lora_r,
        lora_alpha=args.lora_alpha,
        lora_dropout=args.lora_dropout,
        lora_target_modules=[m.strip() for m in args.lora_target_modules.split(",") if m.strip()],
        max_seq_len=args.max_seq_len,
        bf16=args.bf16,
        fp16=args.fp16,
        gradient_checkpointing=args.gradient_checkpointing,
        packing=args.packing,
        save_steps=args.save_steps,
        eval_steps=args.eval_steps,
        logging_steps=args.logging_steps,
        report_to=args.report_to,
        push_to_hub=args.push_to_hub,
        hub_model_id=args.hub_model_id,
        seed=args.seed,
        load_in_4bit=args.load_in_4bit,
    )
    train(cfg)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
