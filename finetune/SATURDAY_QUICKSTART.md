# Saturday Quick Start

The single page Andreas reads at 08:00. Six commands in order with a
one-line verification after each.

## Pre-flight (08:00 Saturday)

```bash
cd ~/path/to/ModuleWarden
git pull --ff-only
ls .env || cp .env.example .env  # then edit secrets

# TypeScript dependencies (recharts is already in lockfile per bd1e085).
pnpm install --frozen-lockfile

# CRITICAL: Prisma client types are NOT in git. Generate them BEFORE
# any TypeScript build, otherwise packages/prisma-client and everything
# downstream fails with "Module '@prisma/client' has no exported
# member 'ModelProfile'" etc.
pnpm generate

# Smoke-build to catch regressions early. web-ui needs
# VITE_MW_API_BASE_URL set or it fails fast (task-29 invariant).
VITE_MW_API_BASE_URL=http://localhost:8080 pnpm -r build
```

Verify: the 6 demo-critical packages report Done: shared, audit-runner,
prisma-client, audit-rpc-server, web-ui, cli. `worker` and `api-proxy`
are mid-refactor and still red as of Saturday 00:00 (api-proxy only
because its build chains to worker). Neither is on the demo or
fine-tune path, so a red worker does NOT block the pitch. If you want a
fully green run, exclude them:
`VITE_MW_API_BASE_URL=http://localhost:8080 pnpm -r --filter='!@modulewarden/worker' --filter='!@modulewarden/api-proxy' build`.

## Step 1: Pull the scraped corpus from Nextcloud

```bash
bash finetune/scripts/nextcloud-sync.sh ls
bash finetune/scripts/nextcloud-sync.sh pull scraped-cases-overnight.jsonl
```

Verify: `wc -l finetune/corpus/scraped-cases-overnight.jsonl` returns
**8510** (or more if Andrew re-ran the scraper overnight).

If file is missing on Nextcloud OR is fewer than 8000 lines, fall back
to the committed `scraped-cases.jsonl` (2305 cases) and proceed.

## Step 2: Pull pre-computed SFT records (skip the walker)

```bash
# Try the full file first (the auto-uploader pushes it once the
# Friday-night walker finishes). If it 404s, pull the partial, which is
# always present (18.9 MB snapshot, Friday 19:34). The file on Nextcloud
# is named sft-records-partial.jsonl, NOT sft-records.jsonl.
bash finetune/scripts/nextcloud-sync.sh pull sft-records.jsonl \
  || bash finetune/scripts/nextcloud-sync.sh pull sft-records-partial.jsonl
```

Verify: `wc -l finetune/corpus/sft-records*.jsonl` returns at least
**200** for whichever file landed. The Friday-night walker run produced
these; no need to re-run for 45 to 90 minutes. If you pulled the
partial, point training `--sft-jsonl` at
`finetune/corpus/sft-records-partial.jsonl`.

If NEITHER file is on Nextcloud, run the walker:

```bash
python -m finetune.python.pipeline.corpus_walker \
  --scraped-cases finetune/corpus/scraped-cases-overnight.jsonl \
  --output finetune/corpus/sft-records.jsonl \
  --manifest finetune/corpus/walker-manifest.json \
  --concurrency 4 --max-cases 600 --verbose
```

Expect 45 to 120 minutes depending on network speed to npmjs.org.

## Step 3: Seed benign baseline packages (synthetic-track unblocker)

```bash
bash finetune/python/data/benign-packages/seed.sh
```

If running on Windows git-bash and you see `gzip: stdin: unexpected end
of file`, use the Python fallback instead:

```bash
python finetune/python/data/benign-packages/seed.py
```

Verify: `ls finetune/python/data/benign-packages/extracted/ | wc -l`
returns **18 to 20**. (Some packages may be deprecated; warn-and-skip
is normal.)

## Step 4: Rehearsal smoke (validates the SFT pipeline)

```bash
pip install -e finetune/python/[training]
python -m finetune.python.training.rehearsal \
  --base-model Qwen/Qwen2.5-Coder-1.5B-Instruct \
  --sft-jsonl finetune/corpus/sft-records.jsonl \
  --quick
```

Verify: loss curve descends, exits 0 in under 15 minutes. If it crashes
on `aiohttp` ImportError, run `pip install aiohttp>=3.9` first.

## Step 5: Launch Recipe A on vast.ai

Vast.ai offers from Friday-night survey (sorted by price; check current
prices since the market moves):

| $/hr | GPU | RAM | Disk | Location | ID |
|---|---|---|---|---|---|
| $1.00 | A100 SXM4 40GB | 40 | 450 | Czechia | 36449297 |
| $1.43 | A100 PCIE 40GB | 40 | 258 | Japan | 34453408 |
| $1.90 | A100 SXM4 80GB | 80 | 1800 | Massachusetts | 27652304 |
| $1.91 | A100 SXM4 80GB | 80 | 2097 | Massachusetts | 27652321 |
| $2.44 | H100 NVL 94GB | 94 | 159 | Iowa | 38287262 |

Recipe A (7B QLoRA) needs 22GB VRAM; any 40GB card is fine. The $1.00
Czechia or $1.43 Japan offer is the sweet spot.

```bash
export VAST_API_KEY=<your key>

# Re-check current market in case prices moved overnight
vastai search offers "num_gpus=1 dph_total<=1.5 gpu_ram>=40 disk_space>=80 cuda_max_good>=12.4" -o "dph_total" | head -5

# Rent (replace <offer_id> with chosen ID)
vastai create instance <offer_id> \
  --image pytorch/pytorch:2.4.0-cuda12.4-cudnn9-runtime \
  --disk 80 \
  --onstart-cmd 'env >> /etc/environment; HF_HOME=/workspace/hf-cache HF_HUB_ENABLE_HF_TRANSFER=1'
```

Then SSH in, run the provisioning steps from `RECIPE_A_LAUNCH.md`.

## Step 6: Run the eval matrix (after the checkpoint lands)

```bash
pip install -e finetune/python/[eval,inference]  # adds outlines

python -m finetune.python.eval.matrix_runner \
  --sft-records finetune/corpus/sft-records.jsonl \
  --base-model Qwen/Qwen2.5-Coder-7B-Instruct \
  --finetuned-model /workspace/models/mw-qwen25-7b-v1 \
  --arms 1,2 \
  --output-dir finetune/python/eval/results/
```

If time allows, run arm-3 with outlines constrained decoding:

```bash
python -c "
from finetune.python.eval.constrained_decode import load_constrained_generator
# See decision-3 for usage. Plug in as a third arm if budget permits.
"
```

Verify: `ls finetune/python/eval/results/matrix-*.json` has at least
one file with arm-1 and arm-2 metrics.

## Budget tracking

Starting vast.ai balance: $33.63

| Phase | Estimated cost |
|---|---|
| Rehearsal smoke | $0 (runs locally) |
| Recipe A 7B QLoRA, 3-4h at $1.00 to $1.50 | $3 to $6 |
| Eval matrix 2 arms | $1 to $2 |
| Buffer for retries | $5 |
| Spare for arm-3 outlines run | $2 |

Total expected: $11 to $15. Leaves $18+ for Sunday eval reruns or
unforeseen retry budget.

## What gets pushed to Nextcloud on completion

```bash
tar -czf /tmp/mw-qwen25-7b-v1.tar.gz models/mw-qwen25-7b-v1
bash finetune/scripts/nextcloud-sync.sh push /tmp/mw-qwen25-7b-v1.tar.gz
bash finetune/scripts/nextcloud-sync.sh push finetune/python/eval/results/matrix-*.json
```

## When Leonardo project ID arrives

1. Edit `finetune/python/slurm/train_qwen3.6.slurm`: replace
   `ACCOUNT=YOUR_ACCOUNT_HERE` with the actual code.
2. Rsync the corpus and pipeline to Leonardo.
3. `sbatch finetune/python/slurm/train_qwen3.6.slurm`.
4. Monitor with `squeue -u <user>`; expect 6 to 12 hours.

## Decisions log

| ID | Subject | Outcome |
|---|---|---|
| decision-1 | Python vs MJS pipeline | Hybrid: Python Saturday, MJS Q3 |
| decision-2 | ExploitBench eval | Rejected (V8 exploit benchmark, not classification) |
| decision-3 | Unsloth + MiniOneRec | outlines tonight, defer Unsloth, reject MiniOneRec |

All three are in `backlog/decisions/`. Read them if you hit a fork in
the road that questions the chosen path.
