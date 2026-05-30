#!/bin/bash
# Leonardo prep for diagnosis fine-tune: stages training infra into $SCRATCH.
# Does NOT download a base model (huihui-qwen3.6-27b-abliterated is already on
# $SCRATCH/models/). Only stages: repo clone, pytorch.sif container, mwenv venv
# with pinned deps.
#
# Submit:
#   sed "s|GITHUB_TOKEN_PLACEHOLDER|$PAT|" prep-train-diagnosis.slurm > /tmp/prep.filled
#   python leo.py --put /tmp/prep.filled '$HOME/prep-train-diagnosis.slurm'
#   python leo.py 'cd $HOME && sbatch prep-train-diagnosis.slurm'
#
#SBATCH --account=euhpc_d30_031
#SBATCH --partition=lrd_all_serial
#SBATCH --time=03:00:00
#SBATCH --mem=24G
#SBATCH --cpus-per-task=8
#SBATCH --gres=tmpfs:100G
#SBATCH --job-name=mw-prep-diag
#SBATCH --output=%x-%j.out

set -x
SCRATCH="${SCRATCH:-/leonardo_scratch/large/usertrain/$USER}"
cd "$SCRATCH" || exit 1

# Singularity cache must live on $SCRATCH (TB), NOT the tiny default /tmp
export SINGULARITY_CACHEDIR="$SCRATCH/.sing_cache" SINGULARITY_TMPDIR="$SCRATCH/.sing_tmp"
export APPTAINER_CACHEDIR="$SCRATCH/.sing_cache" APPTAINER_TMPDIR="$SCRATCH/.sing_tmp"
mkdir -p "$SINGULARITY_CACHEDIR" "$SINGULARITY_TMPDIR"

# 1. Clone ModuleWarden repo (private; token injected at upload time)
if [ ! -d ModuleWarden ]; then
  git clone --depth 1 "https://x-access-token:GITHUB_TOKEN_PLACEHOLDER@github.com/apetersson/ModuleWarden.git" \
    && ( cd ModuleWarden && git remote set-url origin https://github.com/apetersson/ModuleWarden.git )
else
  echo "ModuleWarden already cloned, skipping"
fi

# 2. Pull pytorch training container (the exact image validated on vast.ai)
if [ ! -f pytorch.sif ]; then
  singularity pull pytorch.sif docker://pytorch/pytorch:2.4.0-cuda12.1-cudnn9-runtime
else
  echo "pytorch.sif already exists, skipping"
fi

# 3. Build mwenv venv inheriting container torch, plus pinned deps
if [ ! -d mwenv ]; then
  singularity exec pytorch.sif python -m venv --system-site-packages mwenv
fi

# Pinned deps: the vast.ai-validated cohort from HACKATHON_NOTES.md
singularity exec pytorch.sif mwenv/bin/pip install -q --no-cache-dir \
  "transformers==4.46.3" "accelerate==1.1.1" "datasets==3.1.0" "peft==0.17.1" \
  "trl==0.12.2" "bitsandbytes==0.44.1" diffusers safetensors jsonschema huggingface_hub

echo "=== staged in $SCRATCH ==="
ls -la "$SCRATCH" 2>&1
echo "=== model already present ==="
ls -d "$SCRATCH"/models/*/ 2>&1
echo "=== sif size ==="; ls -lh "$SCRATCH/pytorch.sif" 2>&1
echo "MW_PREP_DIAG_DONE rc=$?"
