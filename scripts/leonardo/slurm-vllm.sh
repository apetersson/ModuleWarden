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

export HTTP_PROXY=http://proxyuser:5dd1d2bd002@10.99.0.1:38425
export HTTPS_PROXY=http://proxyuser:5dd1d2bd002@10.99.0.1:38425
export http_proxy=http://proxyuser:5dd1d2bd002@10.99.0.1:38425
export https_proxy=http://proxyuser:5dd1d2bd002@10.99.0.1:38425

# ── Paths ───────────────────────────────────────────────────

SCRATCH_DIR="/leonardo_scratch/large/usertrain/${USER}"
MODEL_CACHE="${SCRATCH_DIR}/models"
VLLM_SIF="${SCRATCH_DIR}/containers/vllm-openai-cu129.sif"
LOG_DIR="${SCRATCH_DIR}/vllm-logs"
mkdir -p "${MODEL_CACHE}" "${LOG_DIR}" "$(dirname "${VLLM_SIF}")"

# Default to the chosen pre-abliterated checkpoint (CLAUDE.md); override via MW_VLLM_MODEL.
MODEL_ID="${MW_VLLM_MODEL:-huihui-ai/Huihui-Qwen3.6-27B-abliterated}"
MODEL_NAME="${MW_VLLM_MODEL_NAME:-qwen3.6-27b}"
PORT="${MW_VLLM_PORT:-8000}"
HOST="${MW_VLLM_HOST:-0.0.0.0}"

# ── Pull vLLM Singularity image (if not cached) ─────────────
if [ ! -f "${VLLM_SIF}" ]; then
    echo "Pulling vLLM Singularity image..."
    # Pull first to /tmp then move to scratch (avoids partial downloads)
    TMP_SIF="/tmp/vllm-openai-cu129-${SLURM_JOB_ID}.sif"
    singularity pull --name "${TMP_SIF}" docker://docker.io/vllm/vllm-openai:latest
    mv "${TMP_SIF}" "${VLLM_SIF}"
    echo "vLLM image cached at ${VLLM_SIF}"
else
    echo "vLLM image found in cache"
fi

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
    --model "${MODEL_ID}"
    --served-model-name "${MODEL_NAME}"
    --host "${HOST}"
    --port "${PORT}"
    --tensor-parallel-size 4
    --max-model-len 32768
    --gpu-memory-utilization 0.90
    --max-num-seqs 64
    --enable-prefix-caching
    --download-dir "${MODEL_CACHE}"
)

echo ""
echo "=== vLLM Configuration ==="
echo "Model: ${MODEL_ID}"
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
    --bind "${MODEL_CACHE}:/root/.cache/huggingface" \
    --bind "${LOG_DIR}:/var/log/vllm" \
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
