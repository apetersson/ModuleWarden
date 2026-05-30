#!/bin/bash
# Leonardo diagnosis fine-tune: huihui-qwen3.6-27b-abliterated -> diagnosis model.
# Modern stack: pytorch57.sif + mwenv57b + sft_qwen36.py (bf16 LoRA, no bitsandbytes).
# 4x A100-64GB, bf16, all-linear LoRA, r=32 alpha=64 dropout=0.0, epochs=3.
#
# Prerequisites:
#   1. prep-qwen36.slurm must have completed (pytorch57.sif + mwenv57b staged)
#   2. sft-records-diagnosis.jsonl uploaded to $SCRATCH
#   3. mw-code-v2.tar.gz extracted to $SCRATCH/ModuleWarden
#   4. rehearsal-diag-v2.slurm must have PASSED
#
# Submit:
#   python leo.py --put train-diag-v2.slurm '/leonardo/home/usertrain/a08trc02/train-diag-v2.slurm'
#   LEO_ACCT=2 python leo.py 'sbatch /leonardo/home/usertrain/a08trc02/train-diag-v2.slurm'
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
#SBATCH --job-name=mw-train-diag-v2
#SBATCH --output=%x-%j.out

set -x
SCRATCH=/leonardo_scratch/large/usertrain/a08trc02
export TRANSFORMERS_OFFLINE=1 HF_HUB_OFFLINE=1 TOKENIZERS_PARALLELISM=false PYTHONUNBUFFERED=1
export HF_HOME="$SCRATCH/hf"

# Modern stack (containerless): module load + venv
module load python/3.11.7
source "$SCRATCH/mwenv57b/bin/activate"

# Model + corpus (all pre-staged)
export MWMODEL="$SCRATCH/models/huihui-qwen3.6-27b-abliterated"
export MWCORPUS="${MWCORPUS:-$SCRATCH/sft-records-diagnosis.jsonl}"
export MWOUT="${MWOUT:-$SCRATCH/mw-diagnosis-adapter}"

# Diagnosis target hyperparams (per TASK-50)
export MW_EPOCHS=3
export MW_LORA_R=32
export MW_LORA_ALPHA=64
export MW_LORA_DROPOUT=0.0
export MW_GRAD_ACCUM=16
export MW_MAX_LEN=4096

echo "================================================================"
echo "ModuleWarden Diagnosis Fine-tune (modern stack)"
echo "Model:   $MWMODEL"
echo "Corpus:  $MWCORPUS"
echo "Adapter: $MWOUT"
echo "LoRA:    r=$MW_LORA_R alpha=$MW_LORA_ALPHA dropout=$MW_LORA_DROPOUT"
echo "Training: epochs=$MW_EPOCHS grad_accum=$MW_GRAD_ACCUM max_len=$MW_MAX_LEN"
echo "================================================================"
nvidia-smi --query-gpu=index,name,memory.total --format=csv,noheader

# Pre-flight
if [ ! -f "$MWCORPUS" ]; then
  echo "FATAL: SFT corpus not found at $MWCORPUS"
  exit 2
fi
RECORDS=$(wc -l < "$MWCORPUS")
echo "Corpus records: $RECORDS"
TRAIN=$(python3 -c "
import json
train = 0
with open('$MWCORPUS') as f:
    for line in f:
        if json.loads(line).get('split') == 'train':
            train += 1
print(train)
")
echo "Train split records: $TRAIN"

# Ensure code is extracted
cd "$SCRATCH/ModuleWarden" || { echo "FATAL: ModuleWarden code not found"; exit 3; }
ls finetune/python/training/sft_qwen36.py || { echo "FATAL: sft_qwen36.py missing"; exit 4; }

# Launch training (no container - direct venv)
python -m finetune.python.training.sft_qwen36 2>&1 | grep -vE "^\s*$"

RC=${PIPESTATUS[0]}
echo "MW_TRAIN_DIAG_V2_RC=$RC"

if [ "$RC" = "0" ]; then
  echo "================================================================"
  echo "TRAINING COMPLETE"
  echo "Adapter: $MWOUT"
  ls -la "$MWOUT" 2>&1
  echo "================================================================"

  # Quick eval on a few test records
  echo "=== Quick eval (5 test records) ==="
  export MWCORPUS="$MWCORPUS"
  python3 -c "
import json
test_recs = []
with open('$MWCORPUS') as f:
    for line in f:
        r = json.loads(line)
        if r.get('split') == 'test':
            test_recs.append(r)
            if len(test_recs) >= 5:
                break
print(f'test records available: {len(test_recs)}')
" || true
else
  echo "================================================================"
  echo "TRAINING FAILED with RC=$RC"
  echo "================================================================"
fi

echo "MW_TRAIN_DIAG_V2_DONE"
