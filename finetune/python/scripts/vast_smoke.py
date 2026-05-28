"""Spool a single GPU on vast.ai, run a tiny SFT-LoRA smoke, destroy.

Reads the vast.ai API key from the ``VAST_API_KEY`` environment variable
or, as a fallback, from ``~/.vast-key``.

Filters: walks the bundles endpoint for single-GPU H100, H200, or A100
instances with CUDA >= 12.4, reliability >= 0.95, bandwidth >= 1500 Mbps,
disk >= 60 GB, dph_total <= ``MAX_PRICE_PER_HOUR``. The single-GPU H100
market on vast can be paper-thin, so accepting H200 + A100 keeps the
smoke runnable. Walks the candidate list on ``no_such_ask`` rejections,
which are stale-listing 404s common to vast's inventory sync.

Cost ceilings: ``MAX_PRICE_PER_HOUR`` rejects offers above the cap, and
the script self-destroys the instance after ``MAX_WAIT_MINUTES`` so
credit cannot be silently consumed. Reference run on an A100 PCIE cost
$0.33 wall-clock end-to-end.

Outputs ``vast_smoke_<instance_id>.json`` on completion with offer
chosen, provisioning timing, training loss curve, generation smoke, and
total spend. Same shape as files under
``finetune/python/eval/smoke_results/``.
"""

from __future__ import annotations

import asyncio
import ipaddress
import json
import os
import sys
import time
from pathlib import Path

import aiohttp

VAST_BASE = "https://console.vast.ai/api/v0"


def _load_key() -> str:
    env_key = os.environ.get("VAST_API_KEY")
    if env_key:
        return env_key.strip()
    keyfile = Path("~/.vast-key").expanduser()
    if keyfile.exists():
        return keyfile.read_text().strip()
    sys.exit(
        "ERROR: vast.ai API key not found. Set VAST_API_KEY env var or "
        "write the key to ~/.vast-key (mode 600)."
    )


# NOTE: deliberately do NOT call _load_key() at module import time. The
# previous version did, which made `import vast_smoke` (from tests, docs,
# or any tooling) crash on machines without a key. _load_key() is now
# called inside main() right before the API session is built.

# Blacklists carried forward from the Obsidian-referenced
# provision_inf_80b.py at C:/Projects/Claude_Code/Job_Orchestrator/scripts/
BLACKLIST_SUBNETS = ["149.7.4.0/24", "154.57.0.0/16", "185.148.0.0/16"]
BLACKLIST_MACHINES = [38594, 40325]
BLACKLIST_IPS = ["213.181.108.221"]

MIN_CUDA = 12.4
MIN_BANDWIDTH = 1500  # relaxed from 3000; H100 inventory at low price is thin
MIN_RELIABILITY = 0.95  # relaxed from 0.985 for the smoke run
MAX_PRICE_PER_HOUR = 4.00  # USD; raised from 2.50 -- prior cap left 1 stale ask
MAX_WAIT_MINUTES = 70  # hard kill at this point; budget protector
NUM_GPUS = 1
MAX_CREATE_RETRIES = 8  # walk down the offer list on no_such_ask

# Image and onstart script. pytorch 2.4 + cu124 per Obsidian-recommended
# Pantheon Option A base.
IMAGE = "pytorch/pytorch:2.4.0-cuda12.4-cudnn9-runtime"
DISK_GB = 60  # Qwen2.5-Coder-1.5B = ~3 GB; HF cache + pip env fits in 30 GB

ONSTART = r"""#!/bin/bash
set -ex

export HF_HUB_ENABLE_HF_TRANSFER=1
export DEBIAN_FRONTEND=noninteractive

apt-get update -qq && apt-get install -y -qq git curl
pip install --no-cache-dir -U pip
# Pin a known-compatible cohort. The shipped pytorch:2.4.0-cuda12.4 image
# bundles an older transformers; without explicit pins the resolver leaves
# transformers stale and peft.auto imports break with GenerationMixin
# moves. trl 0.12 is the floor for the processing_class= kwarg on
# SFTTrainer used below.
pip install --no-cache-dir --upgrade \
    "transformers==4.46.0" \
    "peft==0.13.0" \
    "trl==0.12.0" \
    "accelerate==1.0.1" \
    "datasets==3.0.2" \
    "bitsandbytes==0.44.1" \
    "hf_transfer>=0.1" \
    "sentencepiece" \
    "protobuf>=3.20,<5"

echo "=== installed package versions ==="
python -c "import transformers, peft, trl, accelerate, datasets, bitsandbytes; print('transformers', transformers.__version__); print('peft', peft.__version__); print('trl', trl.__version__); print('accelerate', accelerate.__version__); print('datasets', datasets.__version__); print('bitsandbytes', bitsandbytes.__version__)"

cat > /workspace/smoke_train.py <<'PYEOF'
import json
import time
import torch
from datasets import Dataset
from peft import LoraConfig, get_peft_model
from transformers import AutoModelForCausalLM, AutoTokenizer, BitsAndBytesConfig
from trl import SFTConfig, SFTTrainer

t_total_start = time.time()

MODEL = "Qwen/Qwen2.5-Coder-1.5B-Instruct"
print(f"=== smoke: loading {MODEL}")
t0 = time.time()
tok = AutoTokenizer.from_pretrained(MODEL)
if tok.pad_token is None:
    tok.pad_token = tok.eos_token

bnb = BitsAndBytesConfig(
    load_in_4bit=True,
    bnb_4bit_quant_type="nf4",
    bnb_4bit_compute_dtype=torch.bfloat16,
    bnb_4bit_use_double_quant=True,
)
model = AutoModelForCausalLM.from_pretrained(
    MODEL,
    quantization_config=bnb,
    device_map="auto",
    torch_dtype=torch.bfloat16,
)
print(f"=== model loaded in {time.time()-t0:.1f}s; device={model.device}")

lora = LoraConfig(
    r=16,
    lora_alpha=32,
    lora_dropout=0.0,
    bias="none",
    task_type="CAUSAL_LM",
    target_modules="all-linear",
)
model = get_peft_model(model, lora)
model.print_trainable_parameters()

# Synthetic SFT pairs matching the modulewarden.sft_record.v1 shape.
pairs = [
    {"messages": [
        {"role": "system", "content": "You are a ModuleWarden auditor."},
        {"role": "user", "content": "Verdict for postmark-mcp 1.0.16 (added postinstall reading env tokens)?"},
        {"role": "assistant", "content": '{"verdict": "block", "confidence": "high"}'},
    ]},
    {"messages": [
        {"role": "system", "content": "You are a ModuleWarden auditor."},
        {"role": "user", "content": "Verdict for lodash 4.17.21 (security fix, no install scripts)?"},
        {"role": "assistant", "content": '{"verdict": "allow", "confidence": "high"}'},
    ]},
    {"messages": [
        {"role": "system", "content": "You are a ModuleWarden auditor."},
        {"role": "user", "content": "Verdict for express 4.18.2 (semver minor, no capability deltas)?"},
        {"role": "assistant", "content": '{"verdict": "allow", "confidence": "high"}'},
    ]},
    {"messages": [
        {"role": "system", "content": "You are a ModuleWarden auditor."},
        {"role": "user", "content": "Verdict for tiny-pkg 0.0.4 (newly published, no source repo, postinstall present)?"},
        {"role": "assistant", "content": '{"verdict": "quarantine", "confidence": "medium"}'},
    ]},
    {"messages": [
        {"role": "system", "content": "You are a ModuleWarden auditor."},
        {"role": "user", "content": "Verdict for chalk 5.3.0 (popular package, no diff capabilities)?"},
        {"role": "assistant", "content": '{"verdict": "allow", "confidence": "high"}'},
    ]},
]
def render(ex):
    return {"text": tok.apply_chat_template(ex["messages"], tokenize=False)}
ds = Dataset.from_list(pairs).map(render)
print(f"=== dataset size: {len(ds)}")

cfg = SFTConfig(
    output_dir="/workspace/sft-smoke-out",
    num_train_epochs=4,
    per_device_train_batch_size=1,
    gradient_accumulation_steps=2,
    learning_rate=2e-4,
    logging_steps=2,
    save_steps=1000,
    max_steps=20,
    bf16=True,
    optim="adamw_torch",
    report_to="none",
    gradient_checkpointing=True,
    gradient_checkpointing_kwargs={"use_reentrant": False},
    dataset_text_field="text",
    max_seq_length=1024,
)
trainer = SFTTrainer(
    model=model,
    args=cfg,
    train_dataset=ds,
    processing_class=tok,
)
t0 = time.time()
result = trainer.train()
train_secs = time.time() - t0
print(f"=== train done in {train_secs:.1f}s; loss={result.training_loss:.4f}")

# Quick generation smoke
prompt = tok.apply_chat_template(
    [
        {"role": "system", "content": "You are a ModuleWarden auditor."},
        {"role": "user", "content": "Verdict for react 18.2.0 (no install scripts, popular)?"},
    ],
    tokenize=False,
    add_generation_prompt=True,
)
ids = tok(prompt, return_tensors="pt").to(model.device)
out = model.generate(**ids, max_new_tokens=40, do_sample=False)
gen = tok.decode(out[0], skip_special_tokens=True)
print(f"=== gen smoke output: {gen[-200:]}")

summary = {
    "model": MODEL,
    "device": str(model.device),
    "dataset_size": len(ds),
    "train_secs": round(train_secs, 1),
    "final_loss": round(float(result.training_loss), 4),
    "total_secs": round(time.time() - t_total_start, 1),
    "sft_max_steps": 20,
    "lora": {"r": 16, "alpha": 32, "target_modules": "all-linear"},
    "gen_sample_tail": gen[-200:],
}
with open("/workspace/smoke_summary.json", "w") as f:
    json.dump(summary, f, indent=2)
print("=== smoke_summary.json written")
print("=== SMOKE_COMPLETE ===")
PYEOF

cd /workspace && python smoke_train.py 2>&1 | tee /workspace/smoke.log
echo "=== ONSTART_FINISHED ==="
"""


async def _get(session, headers, url):
    async with session.get(url, headers=headers) as r:
        return r.status, await r.json() if r.content_type == "application/json" else await r.text()


async def _delete(session, headers, url):
    async with session.delete(url, headers=headers) as r:
        return r.status


def _ip_blacklisted(ip):
    if not ip:
        return False
    if ip in BLACKLIST_IPS:
        return True
    try:
        addr = ipaddress.ip_address(ip)
        return any(addr in ipaddress.ip_network(s, strict=False) for s in BLACKLIST_SUBNETS)
    except ValueError:
        return False


async def cleanup_existing(session, headers):
    print("=== checking for existing instances ===")
    status, data = await _get(session, headers, f"{VAST_BASE}/instances/")
    if status != 200:
        return
    for inst in (data or {}).get("instances", []):
        if inst.get("actual_status") in {"running", "loading", "exited", "stopped"}:
            print(f"!! found instance {inst['id']} (status={inst['actual_status']}); destroying for fresh start")
            await _delete(session, headers, f"{VAST_BASE}/instances/{inst['id']}/")
            await asyncio.sleep(2)


async def find_h100(session, headers):
    # Accept any of the H-class or A100 SXM single-GPU options; the
    # single-GPU H100 market on vast is paper-thin and the one listing is
    # stale-ask. Smoke needs roughly 6 GB of VRAM (Qwen2.5-Coder-1.5B
    # 4-bit) so an A100 or H200 works exactly the same as H100.
    query = {
        "gpu_name": {"in": [
            "H100 SXM5", "H100 PCIe", "H100 SXM", "H100 NVL",
            "H200", "H200 NVL",
            "A100 SXM4", "A100 PCIE", "A100",
        ]},
        "rentable": {"eq": True},
        "num_gpus": {"eq": NUM_GPUS},
        "verified": {"eq": True},
        "external": {"eq": False},
        "inet_down": {"gte": MIN_BANDWIDTH},
        "cuda_max_good": {"gte": MIN_CUDA},
        "reliability2": {"gte": MIN_RELIABILITY},
        "disk_space": {"gte": DISK_GB},
        "dph_total": {"lte": MAX_PRICE_PER_HOUR},
    }
    print(f"=== searching for H/A-class single-GPU (<= ${MAX_PRICE_PER_HOUR}/hr, CUDA {MIN_CUDA}+, BW {MIN_BANDWIDTH}+ Mbps) ===")
    params = {"q": json.dumps(query)}
    async with session.get(f"{VAST_BASE}/bundles/", headers=headers, params=params) as r:
        data = await r.json()
    offers = data.get("offers", [])
    print(f"=== {len(offers)} raw offers ===")

    valid = []
    for o in offers:
        mid = o.get("machine_id")
        ip = o.get("public_ipaddr")
        if mid in BLACKLIST_MACHINES:
            print(f"   skip machine {mid} (blacklist)")
            continue
        if _ip_blacklisted(ip):
            print(f"   skip ip {ip} (blacklist)")
            continue
        valid.append(o)

    if not valid:
        print("!! no valid H100 offers")
        return None

    valid.sort(key=lambda o: (o.get("dph_total") or 99, -float(o.get("reliability2") or 0)))
    top = valid[:MAX_CREATE_RETRIES]
    print(f"=== top {len(top)} valid offers ===")
    for i, o in enumerate(top):
        print(
            f"   {i:>2}: id={o.get('id')}  ${o.get('dph_total'):.3f}/hr  "
            f"{o.get('gpu_name')} x{o.get('num_gpus')}  "
            f"CUDA {o.get('cuda_max_good')}  rel {o.get('reliability2'):.3f}  "
            f"BW {o.get('inet_down'):.0f}Mbps  ip={o.get('public_ipaddr')}"
        )
    return top  # caller walks the list on no_such_ask


async def create(session, headers, offer):
    payload = {
        "client_id": "me",
        "image": IMAGE,
        "disk": DISK_GB,
        "onstart": ONSTART,
        "runtype": "ssh",
        "use_jupyter_lab": False,
    }
    print(f"=== creating instance from offer {offer['id']} ===")
    async with session.put(
        f"{VAST_BASE}/asks/{offer['id']}/",
        headers=headers,
        json=payload,
    ) as r:
        body = await r.json()
        if not body.get("success"):
            print("!! create failed:", body)
            return None
        inst_id = body.get("new_contract")
        print(f"=== created instance {inst_id} ===")
        return inst_id


async def poll_for_smoke(session, headers, inst_id, deadline_ts):
    """Poll instance until smoke marker appears, instance dies, or deadline hits."""
    last_status = None
    last_log_tail = ""
    while time.time() < deadline_ts:
        status, data = await _get(session, headers, f"{VAST_BASE}/instances/{inst_id}/")
        if status != 200 or "instances" not in (data or {}) and "instance" not in (data or {}):
            print("!! lost instance:", status, data)
            return False, "lost"
        inst = data.get("instances") or data.get("instance") or {}
        if isinstance(inst, list):
            inst = inst[0] if inst else {}
        cur = inst.get("actual_status")
        if cur != last_status:
            print(
                f"   t+{int(time.time() % 100000):>5} status={cur} "
                f"intended={inst.get('intended_status')} "
                f"image_runtype={inst.get('image_runtype')}"
            )
            last_status = cur

        # Try logs (logs endpoint or onstart log content if API exposes it)
        try:
            async with session.put(
                f"{VAST_BASE}/instances/request_logs/{inst_id}/",
                headers=headers,
            ) as r:
                body = await r.json()
                url = body.get("result_url") or body.get("url")
            if url:
                async with session.get(url) as r:
                    if r.status == 200:
                        text = await r.text()
                        tail = text[-2000:]
                        if tail != last_log_tail:
                            new = tail[len(last_log_tail):] if last_log_tail and last_log_tail in tail else tail
                            print("   log:", new[-400:].replace("\n", " | "))
                            last_log_tail = tail
                        if "SMOKE_COMPLETE" in text:
                            return True, text
                        if "Killed" in text or "OutOfMemoryError" in text:
                            return False, text
        except Exception as e:
            pass

        await asyncio.sleep(20)
    print("!! deadline hit")
    return False, "deadline"


async def destroy(session, headers, inst_id):
    print(f"=== destroying instance {inst_id} ===")
    s = await _delete(session, headers, f"{VAST_BASE}/instances/{inst_id}/")
    print(f"   destroy status={s}")


async def main():
    key = _load_key()
    headers = {"Authorization": f"Bearer {key}", "Accept": "application/json"}
    timeout = aiohttp.ClientTimeout(total=120)
    async with aiohttp.ClientSession(timeout=timeout) as session:
        await cleanup_existing(session, headers)
        offers = await find_h100(session, headers)
        if not offers:
            print("ABORT: no acceptable offer")
            return 2

        offer = None
        inst_id = None
        for candidate in offers:
            print(f"=== trying offer {candidate.get('id')} (${candidate.get('dph_total'):.3f}/hr) ===")
            inst_id = await create(session, headers, candidate)
            if inst_id:
                offer = candidate
                break
            await asyncio.sleep(3)
        if not inst_id:
            print("ABORT: every candidate offer failed at create()")
            return 3

        deadline = time.time() + MAX_WAIT_MINUTES * 60
        log_record = {
            "offer_id": offer["id"],
            "instance_id": inst_id,
            "machine_id": offer.get("machine_id"),
            "public_ipaddr": offer.get("public_ipaddr"),
            "gpu_name": offer.get("gpu_name"),
            "num_gpus": offer.get("num_gpus"),
            "cuda_max_good": offer.get("cuda_max_good"),
            "reliability2": offer.get("reliability2"),
            "inet_down": offer.get("inet_down"),
            "dph_total": offer.get("dph_total"),
            "created_at": time.time(),
            "max_wait_minutes": MAX_WAIT_MINUTES,
        }

        try:
            ok, payload = await poll_for_smoke(session, headers, inst_id, deadline)
            log_record["smoke_ok"] = ok
            log_record["payload_tail"] = payload[-3000:] if isinstance(payload, str) else str(payload)
        finally:
            await destroy(session, headers, inst_id)
            log_record["destroyed_at"] = time.time()
            log_record["wall_minutes"] = round(
                (log_record["destroyed_at"] - log_record["created_at"]) / 60, 2
            )
            log_record["spend_usd_estimate"] = round(
                (log_record["dph_total"] or 0) * log_record["wall_minutes"] / 60, 3
            )

        out_path = Path(f"vast_smoke_{inst_id}.json")
        out_path.write_text(json.dumps(log_record, indent=2))
        print(f"=== wrote {out_path}")
        return 0 if log_record.get("smoke_ok") else 1


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
