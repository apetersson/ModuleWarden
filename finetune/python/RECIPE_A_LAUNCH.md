# Recipe A vast.ai launch reference

Copy-paste runbook for Saturday morning. Assumes the corpus walker has
already produced `finetune/corpus/sft-records.jsonl`.

## Budget reality

- **$33.63 vast.ai balance as of Friday night** (topped up from $8.63 with
  an additional $25 from Andrew)
- A100 PCIE 40GB market rate: $1.20 to $2.20 per hour
- Recipe A training: 2 to 4 hours on 1x A100 (depends on records count)
- Overhead per instance: 25 to 35 minutes (provisioning + pip install + model download)

At $1.50/hr the budget covers about 22 hours of compute. That gives:

| Plan | Hours | Cost |
|---|---|---|
| One Recipe A 7B QLoRA run | 3-4h | ~$5-6 |
| Two eval matrix arms | 1-2h | ~$2-3 |
| Buffer for retries | 4h | ~$6 |
| Spare for a small 32B QLoRA stretch run | 8-10h | ~$15 |

Plenty of headroom. No need to cap `--max-cases` for budget reasons.

## Step 1: spin a vast.ai instance

The script at `finetune/python/scripts/vast_smoke.py` finds and rents
the cheapest A100 under MAX_PRICE_PER_HOUR. It is wired for the
1.5B smoke run; for Recipe A we use the same shape but the 7B model.

```bash
# requires VAST_API_KEY in .env
export VAST_API_KEY=<set in .env, ideally>

cd /c/Projects/_Jobs/Collaborations/Andrew/_mw-clone
source .env

# Pick an instance via the vast CLI (vastai CLI must be `pip install vastai`)
vastai search offers \
  "gpu_name=A100 num_gpus=1 dph<=2.0 disk_space>=80 cuda_max_good>=12.4" \
  --raw -o "dph_total"  | head -5

# Rent the first one (replace <offer_id>)
vastai create instance <offer_id> \
  --image pytorch/pytorch:2.4.0-cuda12.4-cudnn9-runtime \
  --disk 80 \
  --onstart-cmd 'env >> /etc/environment; HF_HOME=/workspace/hf-cache HF_HUB_ENABLE_HF_TRANSFER=1'
```

## Step 2: provision the instance

SSH into the instance, then:

```bash
# Pinned dep cohort that survived the resolver-skew bug from the 1.5B smoke
pip install --no-cache-dir \
  transformers==4.46.0 \
  peft==0.13.0 \
  trl==0.12.0 \
  accelerate==1.0.1 \
  datasets==3.0.2 \
  bitsandbytes==0.44.1

# Confirm CUDA + cohort
python -c "import torch; print('CUDA', torch.cuda.is_available(), torch.cuda.get_device_name(0))"
python -c "import transformers, peft, trl, accelerate, datasets, bitsandbytes; print('cohort ok')"
```

## Step 3: rsync the corpus and pipeline

From the local repo root:

```bash
# Replace <vast_ssh> with the SSH endpoint the vast.ai dashboard shows
rsync -avz --progress \
  finetune/python/ \
  finetune/corpus/sft-records.jsonl \
  <vast_ssh>:/workspace/finetune/

# Or pull from Nextcloud directly on the instance:
# bash finetune/scripts/nextcloud-sync.sh push finetune/corpus/sft-records.jsonl
# then on the vast.ai instance:
# curl -sf -u "user:pass" "<webdav_url>/sft-records.jsonl" -o sft-records.jsonl
```

## Step 4: launch Recipe A

The actual training command:

```bash
cd /workspace
export HF_HOME=/workspace/hf-cache
export HF_HUB_ENABLE_HF_TRANSFER=1

python -m finetune.python.training.sft_lora \
  --base-model Qwen/Qwen2.5-Coder-7B-Instruct \
  --train-data /workspace/finetune/sft-records.jsonl \
  --output /workspace/models/mw-qwen25-7b-v1 \
  --batch-size 4 \
  --grad-accum 8 \
  --epochs 3 \
  --lr 2e-4 \
  --lora-r 64 \
  --lora-alpha 128 \
  --lora-target-modules all-linear \
  --max-seq-len 8192 \
  --bf16 \
  --load-in-4bit \
  --gradient-checkpointing \
  --save-steps 100 \
  --eval-steps 100 \
  --logging-steps 10 \
  2>&1 | tee /workspace/recipe-a-train.log
```

Note: `--lora-target-modules all-linear` matters per HACKATHON_NOTES.md.
The hardcoded 7-name list in `sft_lora.py` defaults would miss Qwen3
DeltaNet layers (less critical for 7B but enforced for safety).

## Step 5: pull the checkpoint back to local

```bash
# From local
rsync -avz --progress \
  <vast_ssh>:/workspace/models/mw-qwen25-7b-v1/ \
  ./models/mw-qwen25-7b-v1/

# Then push the checkpoint to Nextcloud for the team
tar -czf /tmp/mw-qwen25-7b-v1.tar.gz models/mw-qwen25-7b-v1
bash finetune/scripts/nextcloud-sync.sh push /tmp/mw-qwen25-7b-v1.tar.gz
```

## Step 6: run the eval matrix locally

The eval can run on a CPU-friendly machine or back on vast.ai if budget
allows. The 4-arm matrix runner is at
`finetune/python/eval/matrix_runner.py`.

```bash
python -m finetune.python.eval.matrix_runner \
  --sft-records finetune/corpus/sft-records.jsonl \
  --base-model Qwen/Qwen2.5-Coder-7B-Instruct \
  --finetuned-model ./models/mw-qwen25-7b-v1 \
  --arms 1,2 \
  --output-dir finetune/python/eval/results/
```

## Failure recovery

| Symptom | Cause | Fix |
|---|---|---|
| `ModuleNotFoundError: aiohttp` | pyproject was not installed before scripts ran | `pip install aiohttp>=3.9` |
| `tarball_url` empty in seed.sh | npm not on PATH on the rental | `source ~/.nvm/nvm.sh` or install Node first |
| `ERR_PNPM_OUTDATED_LOCKFILE` | recharts added without lockfile refresh | `pnpm install --no-frozen-lockfile` once |
| OOM during training | seq_len too high for 40GB A100 | Drop `--max-seq-len` to 4096 |
| Instance dies mid-training | spot/preemptible variant | Pin to on-demand in vastai create flags |
| Budget exhausted before complete | wall-clock overran | Set `--max-steps 800` instead of `--epochs 3` |

## Top up reminder

If the Sunday eval needs a second run, top up before Saturday afternoon.
Add via the vast.ai dashboard. Minimum useful top up: $5 (about 3 more
hours at $1.50 per hour).

## Local GPU constraint (do not waste time on local 7B+ runs)

The local RTX 5090 (32 GB) is shared with the federation services, which
hold ~26 GB steady; free VRAM fluctuates between ~1 and 9 GB. Measured this
session:

- 0.5B QLoRA: succeeds locally (the honest 0% to 46.7% verdict-reproduction
  number came from a local 0.5B run on the augmented corpus).
- 1.5B QLoRA: wedged - base-eval generation OOM'd / stalled when free VRAM
  dipped to ~1.2 GB mid-run.
- 7B and 27B: not feasible locally. Use vast.ai / Leonardo (this runbook).

So: local 0.5B is the fast proof-of-pipeline path; anything larger goes to
vast.ai. Do not burn time trying to fit a 7B on the local box. The eval
script `finetune/python/training/local_finetune_eval.py` caps the eval prompt
to avoid the long-dossier attention OOM, but it cannot create VRAM that the
federation services are holding.
