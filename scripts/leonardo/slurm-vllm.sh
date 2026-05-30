#!/bin/bash
# ── ModuleWarden: vLLM Slurm Job for Leonardo ──────────────────────
#
# Deploys vLLM with qwen3.6 27b as an OpenAI-compatible endpoint on
# Leonardo compute nodes. Uses Singularity for the vLLM container.
#
# Usage:
#   sbatch scripts/leonardo/slurm-vllm.sh
#
# Model weights are cached in $SCRATCH/models/qwen3.6-27b/.
# The vLLM API listens on port 8000 on the compute node.
#
# After the job starts, find the node with: squeue --me
# Then SSH tunnel from local: ssh -L 8081:<node>:8000 <user>@login01-ext.leonardo.cineca.it

#SBATCH --partition=boost_usr_prod
#SBATCH --reservation=s_tra_ncc     # hackathon reserved node (fast lane); drop for general queue / multi-node
#SBATCH --nodes=1
#SBATCH --ntasks-per-node=1
#SBATCH --gpus-per-task=4           # qwen3.6 27b with TP=4 on A100 64GB
#SBATCH --mem=480GB                 # 120GB × 4 GPUs
#SBATCH --cpus-per-task=32          # 8 × 4 GPUs
#SBATCH --time=8:00:00              # Long-running endpoint for batch audits
#SBATCH --job-name=mw-vllm
#SBATCH --output=slurm-vllm-%j.out
#SBATCH --error=slurm-vllm-%j.err

set -euo pipefail

echo "=== ModuleWarden vLLM Deployment ==="
echo "Job ID: ${SLURM_JOB_ID}"
echo "Node: $(hostname)"
echo "Start: $(date -u '+%Y-%m-%dT%H:%M:%SZ')"

# ── Environment ──────────────────────────────────────────────

# Compute-node egress proxy. Only the singularity-pull fallback or a runtime HF
# fetch needs it; the staged-image + local-model serve path below needs no network.
# Supply it via MW_LEONARDO_PROXY in your job env or .env, never as a committed value.
if [ -n "${MW_LEONARDO_PROXY:-}" ]; then
    export HTTP_PROXY="${MW_LEONARDO_PROXY}" HTTPS_PROXY="${MW_LEONARDO_PROXY}"
    export http_proxy="${MW_LEONARDO_PROXY}" https_proxy="${MW_LEONARDO_PROXY}"
fi

# ── Paths ───────────────────────────────────────────────────

SCRATCH_DIR="/leonardo_scratch/large/usertrain/${USER}"
MODEL_CACHE="${SCRATCH_DIR}/models"
LOG_DIR="${SCRATCH_DIR}/vllm-logs"
mkdir -p "${MODEL_CACHE}" "${LOG_DIR}"

# Point to the model directory (binded into container at /model). Prefer the shared
# de-duplicated copy in $WORK (survives the 40-day scratch purge, read by both project
# accounts); fall back to the per-user scratch copy. Override with MW_MODEL_DIR.
WORK_MODELS="/leonardo_work/EUHPC_D30_031/models"
MODEL_DIR="${MW_MODEL_DIR:-${WORK_MODELS}/huihui-qwen3.6-27b-abliterated}"
[ -d "${MODEL_DIR}" ] || MODEL_DIR="${SCRATCH_DIR}/models/huihui-qwen3.6-27b-abliterated"
MODEL_NAME="${MW_VLLM_MODEL_NAME:-huihui-qwen3.6-27b-abliterated}"
PORT="${MW_VLLM_PORT:-8000}"
HOST="${MW_VLLM_HOST:-0.0.0.0}"

# ── vLLM Singularity image ──────────────────────────────────
# Default to the pre-staged, world-readable image in the project work dir
# (vLLM 0.21.0, CUDA 12.9 userspace). It runs on the 535/12.2 A100 driver via CUDA
# 12.x minor-version compat and also covers Hopper (sm_90), so the serve is
# GPU-arch-agnostic and needs no singularity pull. Override with MW_VLLM_SIF.
STAGED_SIF="/leonardo_work/EUHPC_D30_031/mpfister-public/vllm-openai-v0.21.0-cu129.sif"
VLLM_SIF="${MW_VLLM_SIF:-${STAGED_SIF}}"

# Fallback: if neither the override nor the staged image is present, pull a pinned
# image into scratch. That path needs MW_LEONARDO_PROXY set (compute-node egress).
if [ ! -f "${VLLM_SIF}" ]; then
    echo "Image not found at ${VLLM_SIF}; falling back to singularity pull..."
    VLLM_SIF="${SCRATCH_DIR}/containers/vllm-openai-v063-cu121.sif"
    mkdir -p "$(dirname "${VLLM_SIF}")"
    if [ ! -f "${VLLM_SIF}" ]; then
        TMP_SIF="/tmp/vllm-openai-${SLURM_JOB_ID}.sif"
        singularity pull --name "${TMP_SIF}" docker://docker.io/vllm/vllm-openai:v0.6.3.post1
        mv "${TMP_SIF}" "${VLLM_SIF}"
    fi
fi
echo "vLLM image: ${VLLM_SIF}"

# ── Download model weights (if not cached) ──────────────────
# Models are downloaded by the vLLM container on first run.
# Pre-caching via huggingface_hub on login node is faster:
#   pip install huggingface_hub
#   python3 -c "from huggingface_hub import snapshot_download; snapshot_download('${MODEL_ID}', cache_dir='${MODEL_CACHE}')"
# But since compute nodes have no internet, we rely on vLLM's built-in download
# via the proxy during the first job run.

# ── vLLM Arguments ──────────────────────────────────────────
# qwen3.6 27b fits comfortably on 4× A100 64GB with TP=4
# Use --max-model-len 32768 to keep KV cache manageable
# --gpu-memory-utilization 0.90 to leave room for CUDA context

VLLM_ARGS=(
    --model "/model"
    --served-model-name "${MODEL_NAME}"
    --host "${HOST}"
    --port "${PORT}"
    --tensor-parallel-size 4
    --trust-remote-code
    --max-model-len 32768
    --gpu-memory-utilization 0.90
    --max-num-seqs 64
    --enable-prefix-caching
)

echo ""
echo "=== vLLM Configuration ==="
echo "Model dir: ${MODEL_DIR}"
echo "Served as: ${MODEL_NAME}"
echo "Port: ${PORT}"
echo "TP size: 4"
echo "Max model length: 32768"
echo "Max sequences: 64"
echo "Prefix caching: enabled"
echo "Model cache: ${MODEL_CACHE}"
echo ""

# ── Launch vLLM ─────────────────────────────────────────────
echo "Starting vLLM server..."

singularity exec --nv \
    --bind "${MODEL_DIR}:/model" \
    --env HF_HOME=/root/.cache/huggingface \
    --env HTTP_PROXY="${HTTP_PROXY}" \
    --env HTTPS_PROXY="${HTTPS_PROXY}" \
    --env http_proxy="${http_proxy}" \
    --env https_proxy="${https_proxy}" \
    "${VLLM_SIF}" \
    python3 -m vllm.entrypoints.openai.api_server \
        "${VLLM_ARGS[@]}" \
        2>&1 | tee "${LOG_DIR}/vllm-${SLURM_JOB_ID}.log"

echo "vLLM server exited."
echo "End: $(date -u '+%Y-%m-%dT%H:%M:%SZ')"
