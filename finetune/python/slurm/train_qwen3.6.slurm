#!/bin/bash
#SBATCH --job-name=mw-qwen36-sft
#SBATCH --partition=h100
#SBATCH --account=YOUR_ACCOUNT_HERE
#SBATCH --nodes=8
#SBATCH --ntasks-per-node=8
#SBATCH --gpus-per-node=8
#SBATCH --cpus-per-task=16
#SBATCH --mem=0
#SBATCH --time=12:00:00
#SBATCH --output=runs/slurm/%x-%j.out
#SBATCH --error=runs/slurm/%x-%j.err
#
# ModuleWarden Qwen3.6-27B fine-tune on 64 H100s (8 nodes x 8 GPUs).
# Three stages: abliteration (1 node), SFT LoRA (8 nodes FSDP), eval (1 node).
#
# Submit:
#     sbatch finetune/python/slurm/train_qwen3.6.slurm
#
# Override the base model (e.g. for a Qwen2.5-32B fallback):
#     BASE_MODEL=Qwen/Qwen2.5-32B-Instruct sbatch finetune/python/slurm/train_qwen3.6.slurm

set -euo pipefail

mkdir -p runs/slurm models

# ---------------------------------------------------------------------------
# Environment
# ---------------------------------------------------------------------------

module purge
module load profile/deeplrn 2>/dev/null || true
module load cuda/12.4 2>/dev/null || true
module load python/3.11 2>/dev/null || true
module load gcc/12.2 2>/dev/null || true

source .venv/bin/activate

export TOKENIZERS_PARALLELISM=false
export OMP_NUM_THREADS=8
export HF_HOME="${SCRATCH:-$HOME/scratch}/hf_cache"
export TRANSFORMERS_CACHE="$HF_HOME"
export NCCL_DEBUG=WARN
export NCCL_ASYNC_ERROR_HANDLING=1
mkdir -p "$HF_HOME"

BASE_MODEL="${BASE_MODEL:-Qwen/Qwen3.6-27B-Instruct}"
MODEL_TAG="$(basename "$BASE_MODEL")"
ABLITERATED_DIR="models/${MODEL_TAG}-abliterated"
SFT_OUT="models/mw-${MODEL_TAG}-v1"
TRAIN_DATA="finetune/corpus/sft-records.jsonl"
TEST_DATA="finetune/corpus/sft-records.test.jsonl"

HEAD_NODE_IP=$(scontrol show hostnames "$SLURM_JOB_NODELIST" | head -n1)
HEAD_NODE_IP=$(getent hosts "$HEAD_NODE_IP" | awk '{print $1}')
export HEAD_NODE_IP

echo "================================================================"
echo "ModuleWarden Qwen3.6 training: $BASE_MODEL"
echo "Head node IP: $HEAD_NODE_IP"
echo "Nodes:        $SLURM_JOB_NUM_NODES"
echo "GPUs total:   $((SLURM_JOB_NUM_NODES * 8))"
echo "================================================================"

# ---------------------------------------------------------------------------
# Stage 1: abliteration (1 node, 8 H100s, ~60-90 min for 27B)
# ---------------------------------------------------------------------------

if [ ! -d "$ABLITERATED_DIR" ]; then
    echo "[stage 1/3] abliteration -> $ABLITERATED_DIR"
    srun --nodes=1 --ntasks=1 --gpus=8 --exclusive \
        python -m finetune.python.training.abliteration \
            --base-model "$BASE_MODEL" \
            --output "$ABLITERATED_DIR" \
            --harmful-prompts finetune/python/training/harmful_prompts.json \
            --harmless-prompts finetune/python/training/harmless_prompts.json \
            --dtype bfloat16 \
            --verbose
else
    echo "[stage 1/3] reusing existing abliterated weights at $ABLITERATED_DIR"
fi

# ---------------------------------------------------------------------------
# Stage 2: SFT LoRA (8 nodes x 8 H100 = 64 GPUs, ~6-10 hours for 27B + 60K examples)
# ---------------------------------------------------------------------------

echo "[stage 2/3] SFT LoRA -> $SFT_OUT"

srun --ntasks="$SLURM_JOB_NUM_NODES" --ntasks-per-node=1 \
    bash -c "accelerate launch \
        --config_file finetune/python/training/accelerate_multinode.yaml \
        --num_processes $((SLURM_JOB_NUM_NODES * 8)) \
        --num_machines $SLURM_JOB_NUM_NODES \
        --main_process_ip $HEAD_NODE_IP \
        --main_process_port 29500 \
        --machine_rank \$SLURM_NODEID \
        -m finetune.python.training.sft_lora \
            --base-model $BASE_MODEL \
            --abliterated-model $ABLITERATED_DIR \
            --train-data $TRAIN_DATA \
            --eval-data $TEST_DATA \
            --output $SFT_OUT \
            --batch-size 2 \
            --grad-accum 16 \
            --epochs 2 \
            --lr 1e-4 \
            --lora-r 64 \
            --lora-alpha 128 \
            --lora-target-modules q_proj,k_proj,v_proj,o_proj,gate_proj,up_proj,down_proj \
            --max-seq-len 8192 \
            --bf16 \
            --save-steps 250 \
            --eval-steps 250 \
            --logging-steps 10 \
            --report-to none \
            --seed 42"

# ---------------------------------------------------------------------------
# Stage 3: 4-arm eval matrix (1 node, 1 H100, ~60-120 min)
# ---------------------------------------------------------------------------

echo "[stage 3/3] eval matrix -> finetune/python/eval/results/"

srun --nodes=1 --ntasks=1 --gpus=1 --exclusive \
    python -m finetune.python.eval.matrix_runner \
        --sft-records "$TRAIN_DATA" \
        --base-model "$BASE_MODEL" \
        --finetuned-model "$SFT_OUT" \
        --arms 1,2 \
        --max-new-tokens 1024 \
        --output-dir finetune/python/eval/results/

echo "Done at $(date -u +%Y-%m-%dT%H:%M:%SZ)"
