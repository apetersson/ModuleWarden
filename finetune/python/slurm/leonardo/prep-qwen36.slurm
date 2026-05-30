#!/bin/bash
# Prep the Qwen3.6 (qwen3_5) modern stack on Leonardo: a torch-2.6 container
# (transformers 5.9 needs torch>=2.5) + the validated tf5.9/trl1.5/peft0.19 deps.
# NOTE: bitsandbytes is intentionally NOT installed - its triton modules JIT-
# compile at import and the runtime container has no C compiler; the 27B trains
# in bf16 across 4 A100 (256GB) so 4-bit is unnecessary here.
# Stage the model separately (already done for both team accounts):
#   huihui-ai/Huihui-Qwen3.6-27B-abliterated -> $SCRATCH/models/huihui-qwen3.6-27b-abliterated
#SBATCH --account=euhpc_d30_031
#SBATCH --partition=lrd_all_serial
#SBATCH --time=01:00:00
#SBATCH --mem=24G
#SBATCH --cpus-per-task=8
#SBATCH --gres=tmpfs:100G
#SBATCH --job-name=mw-prep-qwen36
#SBATCH --output=%x-%j.out

set -x
SCRATCH="${SCRATCH:-/leonardo_scratch/large/usertrain/$USER}"
cd "$SCRATCH" || exit 1
export SINGULARITY_CACHEDIR="$SCRATCH/.sing_cache" SINGULARITY_TMPDIR="$SCRATCH/.sing_tmp"
export APPTAINER_CACHEDIR="$SCRATCH/.sing_cache" APPTAINER_TMPDIR="$SCRATCH/.sing_tmp"
mkdir -p "$SINGULARITY_CACHEDIR" "$SINGULARITY_TMPDIR"

if [ ! -f pytorch57.sif ]; then
  singularity pull pytorch57.sif docker://pytorch/pytorch:2.6.0-cuda12.4-cudnn9-runtime
fi
if [ ! -d mwenv57b ]; then
  singularity exec pytorch57.sif python -m venv --system-site-packages mwenv57b
fi
singularity exec pytorch57.sif mwenv57b/bin/pip install -q --no-cache-dir \
  "transformers==5.9.0" "trl==1.5.1" "peft==0.19.1" "accelerate==1.13.0" \
  "datasets==4.8.5" safetensors

echo "=== import probe ==="
singularity exec pytorch57.sif mwenv57b/bin/python -c "
import torch, transformers, trl
print('torch', torch.__version__, '| transformers', transformers.__version__, '| trl', trl.__version__)
from transformers import AutoConfig
import os
c = AutoConfig.from_pretrained(os.environ['SCRATCH'] + '/models/huihui-qwen3.6-27b-abliterated')
print('IMPORTS OK; config:', c.model_type, c.architectures)
"
echo "MW_PREP_QWEN36_DONE rc=$?"
