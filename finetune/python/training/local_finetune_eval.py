"""Real small QLoRA fine-tune + honest held-out eval, sized for a single GPU.

Trains a LoRA adapter on the real SFT corpus (dossier -> AuditReport) and
measures, on a held-out split, what the fine-tune actually buys versus the
stock base model: schema-valid JSON rate, verdict-match accuracy, and
block-recall (does it still catch the severe class). This is the honest,
small-scale version of the deck's claimed eval matrix - a real model, real
data, a real number, runnable on the box we have.

SAFETY (the corpus is derived from real npm malware advisories):
  - Training and eval read ONLY JSON text. Dossiers describe advisories;
    they are not executable payloads and nothing here runs package code.
  - No tarball download, no npm install, no install-script execution.
  - Model output is parsed with json.loads as DATA and never executed,
    eval'd, written to an executable path, or piped to a shell. A malformed
    or hostile generation simply counts as schema-invalid.
  - The only network access is the stock base-model download from
    HuggingFace (model weights, not package code).

Usage:
    python -m finetune.python.training.local_finetune_eval --smoke
    python -m finetune.python.training.local_finetune_eval \
        --model Qwen/Qwen2.5-0.5B-Instruct --epochs 2 --eval-split validation
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path
from typing import Any

REPO_ROOT = Path(__file__).resolve().parents[3]
SFT_PATH = REPO_ROOT / "finetune" / "corpus" / "sft-records.jsonl"
DEFAULT_OUT = REPO_ROOT / "finetune" / "python" / "training" / "adapters" / "local-sft"
METRICS_OUT = REPO_ROOT / "finetune" / "python" / "eval" / "finetune-metrics.json"
TRACES_DIR = REPO_ROOT / "finetune" / "python" / "eval" / "traces"

VALID_VERDICTS = {"allow", "quarantine", "block"}


def _load_split(split: str | None, corpus_path: Path = SFT_PATH) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    with Path(corpus_path).open(encoding="utf-8") as fh:
        for line in fh:
            line = line.strip()
            if not line:
                continue
            rec = json.loads(line)
            if "messages" not in rec:
                continue
            if split is None or rec.get("split") == split:
                rows.append(rec)
    return rows


def _gold_verdict(rec: dict[str, Any]) -> str | None:
    try:
        rep = json.loads(rec["messages"][-1]["content"])
        return (rep.get("verdict") or "").lower() or None
    except Exception:
        return None


_VERDICT_RE = re.compile(r'"verdict"\s*:\s*"(allow|quarantine|block)"', re.IGNORECASE)


def _extract_verdict(text: str) -> tuple[bool, str | None]:
    """Parse a model generation as JSON DATA (never executed).

    Returns (schema_valid, verdict).
      - schema_valid: a fully-closed JSON object with a recognized verdict
        was produced (the strict bar a small model may miss on long output).
      - verdict: the verdict, recovered by regex even if the long JSON was
        truncated before its closing brace, so a correct call is not hidden
        by a token-budget cutoff.
    """
    schema_valid = False
    verdict: str | None = None

    start = text.find("{")
    if start != -1:
        depth = 0
        end = -1
        for i in range(start, len(text)):
            if text[i] == "{":
                depth += 1
            elif text[i] == "}":
                depth -= 1
                if depth == 0:
                    end = i + 1
                    break
        if end != -1:
            try:
                obj = json.loads(text[start:end])
                if isinstance(obj, dict):
                    v = (obj.get("verdict") or "").lower()
                    if v in VALID_VERDICTS:
                        schema_valid = True
                        verdict = v
            except Exception:
                pass

    if verdict is None:
        m = _VERDICT_RE.search(text)
        if m:
            verdict = m.group(1).lower()
    return schema_valid, verdict


_TECHNIQUE_RE = re.compile(r"\bT\d{4}(?:\.\d{3})?\b")


def _trace_id(rec: dict[str, Any], idx: int) -> str:
    """Stable per-case id for the trace filename.

    Prefers record_id (always present in the SFT corpus), falls back to the
    audit_id embedded in the user message, then to a positional index. The
    result is filesystem-safe so it can be used directly as a JSON filename.
    """
    raw = rec.get("record_id")
    if not raw:
        try:
            user = json.loads(rec["messages"][1]["content"])
            raw = user.get("audit_id")
        except Exception:
            raw = None
    if not raw:
        raw = f"case_{idx:04d}"
    return re.sub(r"[^A-Za-z0-9._-]", "_", str(raw))


def _write_trace(traces_dir: Path, trace: dict[str, Any]) -> None:
    """Write one per-case trace JSON the meta-harness proposer reads.

    The proposer greps and cats these files to diagnose why a case failed,
    so each trace is the full causal record for one eval case. raw_output is
    model-generated text written as DATA only; it is never executed.
    """
    traces_dir.mkdir(parents=True, exist_ok=True)
    path = traces_dir / f"{trace['trace_id']}.json"
    path.write_text(json.dumps(trace, indent=2, ensure_ascii=False), encoding="utf-8")


def _evaluate(
    model,
    tokenizer,
    records,
    max_new_tokens,
    label,
    torch,
    max_prompt_tokens=4096,
    write_traces=False,
    traces_dir=None,
) -> dict[str, Any]:
    schema_valid = 0
    verdict_match = 0
    block_total = 0
    block_caught = 0
    kill_chain_emitted = 0
    n = 0
    # Trace writing is opt-in. When off, the loop below is byte-for-byte the
    # behavior that shipped before --write-traces existed.
    if write_traces:
        traces_dir = Path(traces_dir) if traces_dir is not None else TRACES_DIR
    for idx, rec in enumerate(records):
        gold = _gold_verdict(rec)
        if gold is None:
            continue
        n += 1
        prompt_msgs = rec["messages"][:-1]  # system + user, ask model to produce report
        ids = tokenizer.apply_chat_template(
            prompt_msgs, add_generation_prompt=True, return_tensors="pt"
        )[0]
        # Some dossiers tokenize to tens of thousands of tokens; an untruncated
        # prompt makes SDPA attention OOM. Keep the verdict-relevant head plus
        # the short generation-cue tail so the model still sees "produce report".
        if ids.shape[0] > max_prompt_tokens:
            head = ids[: max_prompt_tokens - 24]
            tail = ids[-24:]
            ids = torch.cat([head, tail])
        input_ids = ids.unsqueeze(0).to(model.device)
        attention_mask = torch.ones_like(input_ids)
        with torch.no_grad():
            out = model.generate(
                input_ids,
                attention_mask=attention_mask,
                max_new_tokens=max_new_tokens,
                do_sample=False,
                pad_token_id=tokenizer.pad_token_id,
            )
        gen = tokenizer.decode(out[0][input_ids.shape[1]:], skip_special_tokens=True)
        ok, pred = _extract_verdict(gen)
        if ok:
            schema_valid += 1
        if pred is not None and pred == gold:
            verdict_match += 1
        if _TECHNIQUE_RE.search(gen):
            kill_chain_emitted += 1
        if gold == "block":
            block_total += 1
            # block-recall: model must produce the block verdict, not soften it.
            if pred == "block":
                block_caught += 1
        if write_traces:
            # prompt_used is the exact text the model saw (post-truncation),
            # so the proposer diagnoses against the real input, not the raw
            # untruncated dossier.
            prompt_used = tokenizer.decode(ids, skip_special_tokens=False)
            _write_trace(
                traces_dir,
                {
                    "trace_id": _trace_id(rec, idx),
                    "label": label,
                    "split": rec.get("split"),
                    "source": rec.get("source"),
                    "gold_verdict": gold,
                    "model_verdict": pred,
                    "verdict_match": bool(pred is not None and pred == gold),
                    "schema_valid": ok,
                    "is_block_gold": gold == "block",
                    "block_caught": bool(gold == "block" and pred == "block"),
                    "prompt_used": prompt_used,
                    "raw_output": gen,
                },
            )
    return {
        "label": label,
        "n": n,
        "schema_valid": schema_valid,
        "schema_valid_pct": round(100.0 * schema_valid / n, 1) if n else 0.0,
        "verdict_match": verdict_match,
        "verdict_match_pct": round(100.0 * verdict_match / n, 1) if n else 0.0,
        "block_total": block_total,
        "block_caught": block_caught,
        "block_recall_pct": round(100.0 * block_caught / block_total, 1) if block_total else None,
        "kill_chain_emitted": kill_chain_emitted,
        "kill_chain_emitted_pct": round(100.0 * kill_chain_emitted / n, 1) if n else 0.0,
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Local QLoRA fine-tune + honest eval")
    parser.add_argument("--model", default="Qwen/Qwen2.5-0.5B-Instruct")
    parser.add_argument("--epochs", type=float, default=2.0)
    parser.add_argument("--max-steps", type=int, default=-1)
    parser.add_argument("--max-seq", type=int, default=2048)
    parser.add_argument("--max-new-tokens", type=int, default=512)
    parser.add_argument("--eval-split", default="validation")
    parser.add_argument("--eval-limit", type=int, default=-1, help="cap eval records (speed)")
    parser.add_argument("--out", default=str(DEFAULT_OUT))
    parser.add_argument("--metrics", default=str(METRICS_OUT))
    parser.add_argument("--no-4bit", action="store_true", help="full precision (more VRAM)")
    parser.add_argument("--corpus", default=str(SFT_PATH), help="SFT JSONL (e.g. the ATT&CK-augmented corpus)")
    parser.add_argument("--smoke", action="store_true", help="2-step run to prove it executes")
    parser.add_argument(
        "--write-traces",
        action="store_true",
        help="write one per-case trace JSON to the traces dir for the meta-harness "
        "proposer (off by default; existing eval behavior is unchanged when off)",
    )
    parser.add_argument(
        "--traces-dir",
        default=str(TRACES_DIR),
        help="directory for per-case trace JSON files (used only with --write-traces)",
    )
    args = parser.parse_args(argv)

    import torch
    from transformers import (
        AutoModelForCausalLM,
        AutoTokenizer,
        BitsAndBytesConfig,
        DataCollatorForLanguageModeling,
        Trainer,
        TrainingArguments,
    )
    from peft import LoraConfig, get_peft_model, prepare_model_for_kbit_training

    if not torch.cuda.is_available():
        print("CUDA not available; refusing to run a slow CPU fine-tune.")
        return 2

    train_recs = _load_split("train", args.corpus)
    eval_recs = _load_split(args.eval_split, args.corpus)
    if args.smoke:
        train_recs = train_recs[:8]
        eval_recs = eval_recs[:4]
    elif args.eval_limit > 0:
        eval_recs = eval_recs[: args.eval_limit]
    print(f"train={len(train_recs)} eval({args.eval_split})={len(eval_recs)} model={args.model}")

    tokenizer = AutoTokenizer.from_pretrained(args.model, trust_remote_code=True)
    if tokenizer.pad_token is None:
        tokenizer.pad_token = tokenizer.eos_token

    quant = None
    if not args.no_4bit:
        quant = BitsAndBytesConfig(
            load_in_4bit=True,
            bnb_4bit_quant_type="nf4",
            bnb_4bit_use_double_quant=True,
            bnb_4bit_compute_dtype=torch.bfloat16,
        )
    model = AutoModelForCausalLM.from_pretrained(
        args.model,
        trust_remote_code=True,
        quantization_config=quant,
        torch_dtype=torch.bfloat16,
        device_map={"": 0},
    )
    model.config.use_cache = False
    if quant is not None:
        model = prepare_model_for_kbit_training(model, use_gradient_checkpointing=True)
    lora = LoraConfig(
        r=16,
        lora_alpha=32,
        lora_dropout=0.05,
        bias="none",
        task_type="CAUSAL_LM",
        target_modules=["q_proj", "k_proj", "v_proj", "o_proj", "gate_proj", "up_proj", "down_proj"],
    )
    model = get_peft_model(model, lora)
    model.print_trainable_parameters()

    # Tokenize train records via the chat template (full messages = SFT target).
    def _tok(rec):
        text = tokenizer.apply_chat_template(rec["messages"], tokenize=False)
        enc = tokenizer(text, truncation=True, max_length=args.max_seq)
        enc["labels"] = enc["input_ids"].copy()
        return enc

    from datasets import Dataset

    train_ds = Dataset.from_list([_tok(r) for r in train_recs])
    collator = DataCollatorForLanguageModeling(tokenizer=tokenizer, mlm=False)

    out_dir = Path(args.out)
    out_dir.mkdir(parents=True, exist_ok=True)
    targs = TrainingArguments(
        output_dir=str(out_dir),
        num_train_epochs=args.epochs,
        max_steps=args.max_steps,
        per_device_train_batch_size=1,
        gradient_accumulation_steps=8,
        learning_rate=2e-4,
        warmup_ratio=0.03,
        bf16=True,
        logging_steps=5,
        save_strategy="no",
        gradient_checkpointing=True,
        report_to="none",
        seed=42,
    )
    trainer = Trainer(model=model, args=targs, train_dataset=train_ds, data_collator=collator)

    # Baseline FIRST (adapters initialize to a no-op, so this is the stock base).
    model.eval()
    model.config.use_cache = True  # generation wants the KV cache
    print("evaluating BASE (adapter disabled) ...")
    with model.disable_adapter():
        base = _evaluate(
            model,
            tokenizer,
            eval_recs,
            args.max_new_tokens,
            "base",
            torch,
            write_traces=args.write_traces,
            traces_dir=args.traces_dir,
        )
    print("base:", json.dumps(base))

    print("training ...")
    model.config.use_cache = False  # required with gradient checkpointing
    model.train()
    trainer.train()
    model.save_pretrained(str(out_dir))
    tokenizer.save_pretrained(str(out_dir))

    print("evaluating FINE-TUNED (adapter enabled) ...")
    model.eval()
    model.config.use_cache = True
    tuned = _evaluate(
        model,
        tokenizer,
        eval_recs,
        args.max_new_tokens,
        "fine_tuned",
        torch,
        write_traces=args.write_traces,
        traces_dir=args.traces_dir,
    )
    print("fine_tuned:", json.dumps(tuned))

    metrics = {
        "model": args.model,
        "method": "QLoRA 4-bit" if quant is not None else "LoRA bf16",
        "corpus": str(args.corpus),
        "train_records": len(train_recs),
        "eval_split": args.eval_split,
        "eval_records": len(eval_recs),
        "smoke": args.smoke,
        "safety": "JSON-text only; no tarball fetch; model output parsed as data, never executed",
        "base": base,
        "fine_tuned": tuned,
        "adapter_dir": str(out_dir),
        "write_traces": args.write_traces,
        "traces_dir": str(args.traces_dir) if args.write_traces else None,
    }
    Path(args.metrics).write_text(json.dumps(metrics, indent=2), encoding="utf-8")
    print(f"wrote {args.metrics}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
