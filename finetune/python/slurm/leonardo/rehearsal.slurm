#!/bin/bash
# Leonardo rehearsal: the vast.ai-validated pipeline on real A100 hardware.
# 1 A100-64GB under the hackathon reservation. Fully offline (model pre-staged).
#SBATCH --account=euhpc_d30_031
#SBATCH --partition=boost_usr_prod
#SBATCH --reservation=s_tra_ncc
#SBATCH --nodes=1
#SBATCH --ntasks-per-node=1
#SBATCH --gpus-per-task=1
#SBATCH --mem=120GB
#SBATCH --cpus-per-task=8
#SBATCH --time=0:30:00
#SBATCH --job-name=mw-rehearsal
#SBATCH --output=%x-%j.out

set -x
SCRATCH="${SCRATCH:-/leonardo_scratch/large/usertrain/$USER}"
export HF_HOME="$SCRATCH/hf"
export TRANSFORMERS_OFFLINE=1 HF_HUB_OFFLINE=1 TOKENIZERS_PARALLELISM=false PYTHONUNBUFFERED=1

echo "=== host $(hostname) gpu ==="
nvidia-smi --query-gpu=name,memory.total --format=csv,noheader

cd "$SCRATCH/ModuleWarden" || exit 1
singularity exec --nv --bind "$SCRATCH" "$SCRATCH/pytorch.sif" \
  "$SCRATCH/mwenv/bin/python" -m finetune.python.training.rehearsal \
  --base-model Qwen/Qwen2.5-1.5B-Instruct --quick 2>&1 | grep -vE "DEBUG|urllib3|filelock|hf_xet"
echo "MW_REHEARSAL_RC=${PIPESTATUS[0]} DONE"
