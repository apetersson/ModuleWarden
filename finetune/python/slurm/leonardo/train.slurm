#!/bin/bash
# Leonardo production train: abliterate + SFT LoRA on the real corpus, on the
# hackathon reservation (1 node, up to 4x A100-64GB). Fully offline - the model,
# the corpus, the container, and the venv are all pre-staged in $SCRATCH by
# mw-prep.slurm (extend its downloads to the production model + corpus first).
#
# Model + corpus are env-overridable. Defaults are a real, available model and
# the partial SFT corpus already on Nextcloud (sft-records-partial.jsonl).
#   BASE_MODEL=Qwen/Qwen2.5-7B-Instruct sbatch mw-train.slurm
#SBATCH --account=euhpc_d30_031
#SBATCH --partition=boost_usr_prod
#SBATCH --reservation=s_tra_ncc
#SBATCH --nodes=1
#SBATCH --ntasks-per-node=1
#SBATCH --gpus-per-task=4
#SBATCH --mem=480GB
#SBATCH --cpus-per-task=32
#SBATCH --time=8:00:00
#SBATCH --job-name=mw-train
#SBATCH --output=%x-%j.out

set -x
SCRATCH="${SCRATCH:-/leonardo_scratch/large/usertrain/$USER}"
BASE_MODEL="${BASE_MODEL:-Qwen/Qwen2.5-7B-Instruct}"
SFT_JSONL="${SFT_JSONL:-$SCRATCH/sft-records-partial.jsonl}"
export HF_HOME="$SCRATCH/hf"
export TRANSFORMERS_OFFLINE=1 HF_HUB_OFFLINE=1 TOKENIZERS_PARALLELISM=false PYTHONUNBUFFERED=1
export NCCL_DEBUG=WARN

echo "=== node $(hostname); model=$BASE_MODEL; corpus=$SFT_JSONL ==="
nvidia-smi --query-gpu=index,name,memory.total --format=csv,noheader

cd "$SCRATCH/ModuleWarden" || exit 1
RUN="singularity exec --nv --bind $SCRATCH $SCRATCH/pytorch.sif $SCRATCH/mwenv/bin/python"

# Full pipeline (abliterate best-effort -> SFT LoRA) on the real corpus.
# rehearsal.py is the validated single-entry driver; --sft-jsonl points it at the
# real corpus instead of synthetic data, --epochs/--max-len lifted for a real run.
$RUN -m finetune.python.training.rehearsal \
  --base-model "$BASE_MODEL" \
  --sft-jsonl "$SFT_JSONL" \
  --epochs 2 --max-len 4096 \
  2>&1 | grep -vE "DEBUG|urllib3|filelock|hf_xet"
RC=${PIPESTATUS[0]}
echo "MW_TRAIN_RC=$RC"

# Eval the adapter on the held-out split (offline).
if [ "$RC" = "0" ]; then
  $RUN -m finetune.python.training.local_finetune_eval \
    --base-model "$BASE_MODEL" \
    --adapter "$SCRATCH/ModuleWarden/finetune/python/training/adapters/local-sft" \
    --eval-split test --max-new-tokens 512 2>&1 | tail -40 || echo "eval step skipped/failed (non-fatal)"
fi
echo "MW_TRAIN_DONE"
