#!/bin/bash
#SBATCH --account=euhpc_d30_031
#SBATCH --partition=boost_usr_prod
#SBATCH --reservation=s_tra_ncc
#SBATCH --nodes=1
#SBATCH --ntasks-per-node=1
#SBATCH --gpus-per-task=4
#SBATCH --mem=480GB
#SBATCH --cpus-per-task=32
#SBATCH --time=0:35:00
#SBATCH --job-name=mw-ab
#SBATCH --output=%x-%j.out

set -x
SCRATCH="${SCRATCH:-/leonardo_scratch/large/usertrain/$USER}"
export TRANSFORMERS_OFFLINE=1 HF_HUB_OFFLINE=1 TOKENIZERS_PARALLELISM=false PYTHONUNBUFFERED=1
export HF_HOME="$SCRATCH/hf"
export MWMODEL="$SCRATCH/models/huihui-qwen3.6-27b-abliterated"
export MWADAPTER="$SCRATCH/sft27-adapter-full"
export MWCORPUS="$SCRATCH/sft-records-partial.jsonl"
export MWOUT="$SCRATCH/ab-result"
export MWN=2
export MWMAXNEW=1500

nvidia-smi --query-gpu=index,name,memory.total --format=csv,noheader
singularity exec --nv --bind "$SCRATCH" \
  --env MWMODEL="$MWMODEL",MWADAPTER="$MWADAPTER",MWCORPUS="$MWCORPUS",MWOUT="$MWOUT",MWN="$MWN",MWMAXNEW="$MWMAXNEW" \
  "$SCRATCH/pytorch57.sif" "$SCRATCH/mwenv57b/bin/python" "$SCRATCH/infer_ab.py"
echo "MW_AB_RC=${PIPESTATUS[0]} DONE"
