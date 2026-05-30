#!/bin/bash
# Production Qwen3.6 fine-tune on Leonardo: bf16 LoRA SFT of the abliterated
# huihui-Qwen3.6-27B on 4x A100-64GB, fully offline. Validated end to end
# 2026-05-30 (loss 5.83 -> 1.11 on the cve_diff smoke). Run mw-prep-qwen36.slurm
# first to stage the container + venv; the model is pre-staged in $SCRATCH/models.
#SBATCH --account=euhpc_d30_031
#SBATCH --partition=boost_usr_prod
#SBATCH --reservation=s_tra_ncc
#SBATCH --nodes=1
#SBATCH --ntasks-per-node=1
#SBATCH --gpus-per-task=4
#SBATCH --mem=480GB
#SBATCH --cpus-per-task=32
#SBATCH --time=4:00:00
#SBATCH --job-name=mw-train-qwen36
#SBATCH --output=%x-%j.out

set -x
SCRATCH="${SCRATCH:-/leonardo_scratch/large/usertrain/$USER}"
export TRANSFORMERS_OFFLINE=1 HF_HUB_OFFLINE=1 TOKENIZERS_PARALLELISM=false PYTHONUNBUFFERED=1
export HF_HOME="$SCRATCH/hf"
export MWMODEL="${MWMODEL:-$SCRATCH/models/huihui-qwen3.6-27b-abliterated}"
export MWCORPUS="${MWCORPUS:-$SCRATCH/sft-records-partial.jsonl}"
export MWOUT="${MWOUT:-$SCRATCH/qwen36-sft-adapter}"
export MW_EPOCHS="${MW_EPOCHS:-2}"

nvidia-smi --query-gpu=index,name,memory.total --format=csv,noheader
cd "$SCRATCH/ModuleWarden" || exit 1
singularity exec --nv --bind "$SCRATCH" \
  --env MWMODEL="$MWMODEL",MWCORPUS="$MWCORPUS",MWOUT="$MWOUT",MW_EPOCHS="$MW_EPOCHS",SCRATCH="$SCRATCH" \
  "$SCRATCH/pytorch57.sif" "$SCRATCH/mwenv57b/bin/python" \
  -m finetune.python.training.sft_qwen36 2>&1 | grep -vE "^\s*$"
echo "MW_TRAIN_QWEN36_RC=${PIPESTATUS[0]} DONE"
