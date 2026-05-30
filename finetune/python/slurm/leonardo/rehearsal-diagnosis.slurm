#!/bin/bash
# Leonardo rehearsal smoke for diagnosis fine-tune.
# Validates huihui-qwen3.6-27b-abliterated model loading + QLoRA training
# loop on a small subset of diagnosis SFT records.
# 1 GPU, 30 min, debug QoS.
# CRITICAL GATE: if this fails, STOP before the full 4-GPU run.
#
# Submit:
#   python leo.py --put rehearsal-diagnosis.slurm '$HOME/rehearsal-diagnosis.slurm'
#   python leo.py 'cd $HOME && sbatch rehearsal-diagnosis.slurm'
#
#SBATCH --account=euhpc_d30_031
#SBATCH --partition=boost_usr_prod
#SBATCH --reservation=s_tra_ncc
#SBATCH --nodes=1
#SBATCH --ntasks-per-node=1
#SBATCH --gpus-per-task=1
#SBATCH --mem=120GB
#SBATCH --cpus-per-task=8
#SBATCH --time=0:30:00
#SBATCH --job-name=mw-rehearsal-diag
#SBATCH --output=%x-%j.out

set -x
SCRATCH="${SCRATCH:-/leonardo_scratch/large/usertrain/$USER}"
export HF_HOME="$SCRATCH/hf"
export TRANSFORMERS_OFFLINE=1 HF_HUB_OFFLINE=1 TOKENIZERS_PARALLELISM=false PYTHONUNBUFFERED=1

echo "=== host $(hostname) gpu ==="
nvidia-smi --query-gpu=name,memory.total --format=csv,noheader

# The base model is the pre-abliterated huihui checkpoint already on scratch.
# Use local path so we don't hit HuggingFace Hub (compute node has no internet).
BASE_MODEL="$SCRATCH/models/huihui-qwen3.6-27b-abliterated"

# SFT records: use the full diagnosis JSONL if uploaded, else generate a tiny
# synthetic set (the rehearsal.py --quick path produces 20 synthetic records
# and is sufficient for smoke-testing model loading + training loop).
SFT_JSONL="${SFT_JSONL:-$SCRATCH/sft-records-diagnosis.jsonl}"

cd "$SCRATCH/ModuleWarden" || exit 1

# Handle VLM model loading: Qwen3.5/Qwen3.6 models have language_model_only=false
# and image_token_id in config. Option A: create a temp config with
# language_model_only=true and copy tokenizer_config.json to suppress VLM loading.
MODEL_TMP="$SCRATCH/tmp_rehearsal_model"
rm -rf "$MODEL_TMP"
cp -r "$BASE_MODEL" "$MODEL_TMP"
python3 -c "
import json
cfg_path = '$MODEL_TMP/config.json'
with open(cfg_path) as f:
    cfg = json.load(f)
cfg['language_model_only'] = True
with open(cfg_path, 'w') as f:
    json.dump(cfg, f, indent=2)
print('Patched config: language_model_only=True')
" || echo "Config patch failed (non-fatal - model may load via trust_remote_code)"

# Run the rehearsal. If SFT_JSONL doesn't exist, --quick creates synthetic data.
# The rehearsal validates: model load -> tokenize -> train 1-2 steps -> save adapter.
singularity exec --nv --bind "$SCRATCH" "$SCRATCH/pytorch.sif" \
  "$SCRATCH/mwenv/bin/python" -m finetune.python.training.rehearsal \
  --base-model "$MODEL_TMP" \
  ${SFT_JSONL:+--sft-jsonl "$SFT_JSONL"} \
  --quick 2>&1 | grep -vE "DEBUG|urllib3|filelock|hf_xet"

RC=${PIPESTATUS[0]}
echo "MW_REHEARSAL_DIAG_RC=$RC"

# Cleanup temp model copy
rm -rf "$MODEL_TMP"

if [ "$RC" = "0" ]; then
  echo "REHEARSAL PASSED - safe to proceed to full 4-GPU training"
else
  echo "REHEARSAL FAILED - STOP and investigate before full run"
fi
echo "MW_REHEARSAL_DIAG_DONE"
