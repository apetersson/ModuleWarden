#!/bin/bash
# Leonardo full fine-tune: huihui-qwen3.6-27b-abliterated -> diagnosis model.
# 4x A100-64GB, QLoRA 4-bit NF4, r=32 alpha=64, epochs=3.
# Fully offline - model + corpus + container + venv all pre-staged in $SCRATCH.
#
# Submit:
#   python leo.py --put train-diagnosis.slurm '$HOME/train-diagnosis.slurm'
#   python leo.py 'cd $HOME && sbatch train-diagnosis.slurm'
#
# Override corpus path:
#   SFT_JSONL=$SCRATCH/sft-records-diagnosis-partial.jsonl sbatch train-diagnosis.slurm
#
#SBATCH --account=euhpc_d30_031
#SBATCH --partition=boost_usr_prod
#SBATCH --reservation=s_tra_ncc
#SBATCH --nodes=1
#SBATCH --ntasks-per-node=1
#SBATCH --gpus-per-task=4
#SBATCH --mem=480GB
#SBATCH --cpus-per-task=32
#SBATCH --time=8:00:00
#SBATCH --job-name=mw-train-diag
#SBATCH --output=%x-%j.out

set -x
SCRATCH="${SCRATCH:-/leonardo_scratch/large/usertrain/$USER}"

# Paths - all pre-staged on scratch
BASE_MODEL="$SCRATCH/models/huihui-qwen3.6-27b-abliterated"
SFT_JSONL="${SFT_JSONL:-$SCRATCH/sft-records-diagnosis.jsonl}"
ADAPTER_OUT="$SCRATCH/mw-diagnosis-adapter"

export HF_HOME="$SCRATCH/hf"
export TRANSFORMERS_OFFLINE=1 HF_HUB_OFFLINE=1 TOKENIZERS_PARALLELISM=false PYTHONUNBUFFERED=1
export NCCL_DEBUG=WARN OMP_NUM_THREADS=8

echo "================================================================"
echo "ModuleWarden Diagnosis Fine-tune"
echo "Node:    $(hostname)"
echo "Model:   $BASE_MODEL"
echo "Corpus:  $SFT_JSONL"
echo "Adapter: $ADAPTER_OUT"
echo "================================================================"
nvidia-smi --query-gpu=index,name,memory.total --format=csv,noheader

# Pre-flight: check corpus exists
if [ ! -f "$SFT_JSONL" ]; then
  echo "FATAL: SFT corpus not found at $SFT_JSONL"
  exit 2
fi
RECORDS=$(wc -l < "$SFT_JSONL")
echo "Corpus records: $RECORDS"

cd "$SCRATCH/ModuleWarden" || exit 1

# ------------------------------------------------------------------
# Handle VLM model loading
# ------------------------------------------------------------------
# The huihui model has language_model_only=false and image_token_id in
# its config. transformers 4.46 may fail to load the full VLM. We create
# a temp copy with language_model_only=true to force text-only loading.
MODEL_TMP="$SCRATCH/tmp_train_model"
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
"

# ------------------------------------------------------------------
# QLoRA SFT training via sft_lora.py
# ------------------------------------------------------------------
# We use the existing sft_lora.py driver with --load-in-4bit for QLoRA.
# The rehearsal.py entry point doesn't expose all knobs; we invoke
# sft_lora.py directly for full control.
singularity exec --nv --bind "$SCRATCH" "$SCRATCH/pytorch.sif" \
  "$SCRATCH/mwenv/bin/python" -m finetune.python.training.sft_lora \
    --base-model "$MODEL_TMP" \
    --train-data "$SFT_JSONL" \
    --output "$ADAPTER_OUT" \
    --epochs 3 \
    --lr 2e-4 \
    --warmup-ratio 0.03 \
    --lora-r 32 \
    --lora-alpha 64 \
    --lora-dropout 0.0 \
    --lora-target-modules "all-linear" \
    --max-seq-len 4096 \
    --batch-size 1 \
    --grad-accum 16 \
    --bf16 \
    --load-in-4bit \
    --save-steps 500 \
    --eval-steps 500 \
    --logging-steps 10 \
    --save-total-limit 3 \
    --report-to none \
    --seed 42 \
    2>&1 | grep -vE "DEBUG|urllib3|filelock|hf_xet"

RC=${PIPESTATUS[0]}
echo "MW_TRAIN_DIAG_RC=$RC"

# Cleanup temp model copy
rm -rf "$MODEL_TMP"

if [ "$RC" = "0" ]; then
  echo "================================================================"
  echo "TRAINING COMPLETE"
  echo "Adapter saved to: $ADAPTER_OUT"
  ls -la "$ADAPTER_OUT" 2>&1
  echo "================================================================"

  # Quick eval: load adapter + test split, measure verdict accuracy
  echo "=== Quick eval on test split ==="
  singularity exec --nv --bind "$SCRATCH" "$SCRATCH/pytorch.sif" \
    "$SCRATCH/mwenv/bin/python" -m finetune.python.training.local_finetune_eval \
      --base-model "$BASE_MODEL" \
      --adapter "$ADAPTER_OUT" \
      --eval-split test --max-new-tokens 512 2>&1 | tail -40 || \
    echo "eval step skipped/failed (non-fatal)"
else
  echo "================================================================"
  echo "TRAINING FAILED with RC=$RC"
  echo "================================================================"
fi

echo "MW_TRAIN_DIAG_DONE"
