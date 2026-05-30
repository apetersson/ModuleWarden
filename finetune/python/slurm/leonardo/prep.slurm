#!/bin/bash
# Leonardo login-side prep: serial partition (internet, no 10-min login limit).
# Stages repo + container + venv + model into $SCRATCH so the GPU job runs offline.
#SBATCH --account=euhpc_d30_031
#SBATCH --partition=lrd_all_serial
#SBATCH --time=03:00:00
#SBATCH --mem=24G
#SBATCH --cpus-per-task=8
#SBATCH --gres=tmpfs:100G
#SBATCH --job-name=mw-prep
#SBATCH --output=%x-%j.out

set -x
SCRATCH="${SCRATCH:-/leonardo_scratch/large/usertrain/$USER}"
cd "$SCRATCH" || exit 1

# Singularity squashfs build + layer cache must live on $SCRATCH (TB), NOT the
# tiny default /tmp tmpfs - that is what caused "No space left on device".
export SINGULARITY_CACHEDIR="$SCRATCH/.sing_cache" SINGULARITY_TMPDIR="$SCRATCH/.sing_tmp"
export APPTAINER_CACHEDIR="$SCRATCH/.sing_cache" APPTAINER_TMPDIR="$SCRATCH/.sing_tmp"
mkdir -p "$SINGULARITY_CACHEDIR" "$SINGULARITY_TMPDIR"

# 1. repo (private; token injected at upload time, remote reset to clean URL)
if [ ! -d ModuleWarden ]; then
  git clone --depth 1 "https://x-access-token:GITHUB_TOKEN_PLACEHOLDER@github.com/apetersson/ModuleWarden.git" \
    && ( cd ModuleWarden && git remote set-url origin https://github.com/apetersson/ModuleWarden.git )
fi

# 2. container: the exact image the vast.ai smoke validated
if [ ! -f pytorch.sif ]; then
  singularity pull pytorch.sif docker://pytorch/pytorch:2.4.0-cuda12.1-cudnn9-runtime
fi

# 3. venv on $SCRATCH inheriting container torch, plus our pinned deps
#    (peft>=0.17 required by trl 0.12.2's eager import; diffusers too - see PR #24)
if [ ! -d mwenv ]; then
  singularity exec pytorch.sif python -m venv --system-site-packages mwenv
fi
singularity exec pytorch.sif mwenv/bin/pip install -q --no-cache-dir \
  "transformers==4.46.3" "accelerate==1.1.1" "datasets==3.1.0" "peft==0.17.1" \
  "trl==0.12.2" "bitsandbytes==0.44.1" diffusers safetensors jsonschema huggingface_hub

# 4. pre-download the base model into the $SCRATCH HF cache (compute node has no net)
export HF_HOME="$SCRATCH/hf"
singularity exec pytorch.sif mwenv/bin/python -c \
  "from huggingface_hub import snapshot_download; snapshot_download('Qwen/Qwen2.5-1.5B-Instruct')"

echo "=== staged in $SCRATCH ==="
ls -la "$SCRATCH" 2>&1
echo "=== sif size ==="; ls -lh "$SCRATCH/pytorch.sif" 2>&1
echo "MW_PREP_DONE rc=$?"
