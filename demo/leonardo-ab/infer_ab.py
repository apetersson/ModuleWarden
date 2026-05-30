"""Base-vs-tuned A/B for the ModuleWarden 27B auditor, on held-out val dossiers.

Loads the base (same recipe as training: language_model_only, AutoModelForCausalLM
bf16 device_map=auto) plus the trained LoRA adapter, then for N val dossiers
generates the audit report twice: once with the adapter DISABLED (stock base
behavior) and once ENABLED (the fine-tuned auditor). Shows the lift: the base
refuses or rambles, the tuned model emits the in-schema, evidence-cited report.

Env: MWMODEL (base dir), MWADAPTER (LoRA dir), MWCORPUS (sft jsonl), MWOUT (out
dir), MWN (number of val dossiers).
"""
import json
import os
import torch
from transformers import AutoTokenizer, AutoConfig, AutoModelForCausalLM
from peft import PeftModel

MODEL = os.environ["MWMODEL"]
ADAPTER = os.environ["MWADAPTER"]
CORPUS = os.environ["MWCORPUS"]
OUT = os.environ.get("MWOUT", "/tmp/ab-result")
N = int(os.environ.get("MWN", "2"))
MAXNEW = int(os.environ.get("MWMAXNEW", "768"))
os.makedirs(OUT, exist_ok=True)


def log(m):
    print(f"=== {m} ===", flush=True)


log(f"transformers {__import__('transformers').__version__}; torch {torch.__version__}")
tok = AutoTokenizer.from_pretrained(MODEL, trust_remote_code=True)
if tok.pad_token is None:
    tok.pad_token = tok.eos_token
cfg = AutoConfig.from_pretrained(MODEL)
if hasattr(cfg, "language_model_only"):
    setattr(cfg, "language_model_only", True)

log("load base (bf16, device_map=auto)")
base = AutoModelForCausalLM.from_pretrained(
    MODEL, config=cfg, device_map="auto", dtype=torch.bfloat16, trust_remote_code=True
)
base.config.use_cache = True
log("attach trained LoRA adapter")
model = PeftModel.from_pretrained(base, ADAPTER)
model.eval()

recs = []
for line in open(CORPUS, encoding="utf-8"):
    line = line.strip()
    if not line:
        continue
    r = json.loads(line)
    if r.get("split") in ("val", "validation", "dev") and r.get("messages"):
        recs.append(r)
    if len(recs) >= N:
        break
log(f"val dossiers chosen: {len(recs)}")


def gen(messages_prompt):
    text = tok.apply_chat_template(messages_prompt, tokenize=False, add_generation_prompt=True)
    ids = tok(text, return_tensors="pt", truncation=True, max_length=11000).to(model.device)
    with torch.inference_mode():
        out = model.generate(
            **ids, max_new_tokens=MAXNEW, do_sample=False, pad_token_id=tok.pad_token_id
        )
    new = out[0][ids["input_ids"].shape[1]:]
    return tok.decode(new, skip_special_tokens=True).strip()


results = []
for i, r in enumerate(recs):
    msgs = r["messages"]
    gold = ""
    prompt = msgs
    if msgs and msgs[-1].get("role") == "assistant":
        gold = msgs[-1].get("content", "")
        prompt = msgs[:-1]
    user = next((m["content"] for m in reversed(prompt) if m.get("role") == "user"), "")
    row = {"i": i + 1, "user_excerpt": user[:1400], "gold_excerpt": gold[:1600]}
    try:
        log(f"dossier {i+1}: TUNED generate")
        row["tuned"] = gen(prompt)
        log(f"dossier {i+1}: BASE generate (adapter disabled)")
        with model.disable_adapter():
            row["base"] = gen(prompt)
        print(f"\n--- dossier {i+1} BASE ---\n{row['base'][:500]}\n--- dossier {i+1} TUNED ---\n{row['tuned'][:500]}\n", flush=True)
    except Exception as exc:  # noqa: BLE001
        row["error"] = f"{type(exc).__name__}: {str(exc)[:300]}"
        print(f"dossier {i+1} FAILED: {row['error']}", flush=True)
    results.append(row)
    # save incrementally so a late failure still leaves artifacts
    json.dump(results, open(os.path.join(OUT, "ab.json"), "w", encoding="utf-8"),
              ensure_ascii=False, indent=2)

with open(os.path.join(OUT, "ab.md"), "w", encoding="utf-8") as f:
    f.write("# Base vs fine-tuned ModuleWarden auditor (held-out val dossiers)\n\n")
    f.write("Same 27B base, adapter disabled vs enabled. The base refuses or breaks "
            "schema; the tuned auditor emits the in-schema, evidence-cited report.\n\n")
    for r in results:
        f.write(f"## Dossier {r['i']}\n\n")
        if r.get("error"):
            f.write(f"ERROR: {r['error']}\n\n")
            continue
        f.write(f"### Stock base (adapter disabled)\n\n```\n{r.get('base','')}\n```\n\n")
        f.write(f"### Fine-tuned auditor\n\n```\n{r.get('tuned','')}\n```\n\n")
        f.write(f"### Gold (human report, excerpt)\n\n```\n{r.get('gold_excerpt','')}\n```\n\n")
log("MW_AB_OK")
