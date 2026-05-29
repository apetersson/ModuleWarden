#!/bin/bash
# ── ModuleWarden: Deploy vLLM on Leonardo ────────────────────
#
# One-shot script to submit the vLLM Slurm job and wait for it
# to be ready. Run from your local machine after configuring
# SSH access to Leonardo.
#
# Prerequisites:
#   - SSH key configured for Leonardo login nodes
#   - LEONARDO_USERNAME== and LEONARDO_PASSWORD set (or in ~/.leonardo-env)
#
# Usage:
#   ./scripts/leonardo/deploy-vllm.sh [model_id] [gpus]
#
# Examples:
#   ./scripts/leonardo/deploy-vllm.sh                           # default: qwen3.6 27b, 4 GPUs
#   ./scripts/leonardo/deploy-vllm.sh Qwen/Qwen3.6-27B 2        # explicit model, 2 GPUs

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"

# ── Configuration ────────────────────────────────────────────

# Load Leonardo credentials
if [ -f "${REPO_ROOT}/../.leonardo-access" ]; then
    source "${REPO_ROOT}/../.leonardo-access"
elif [ -f "${HOME}/.leonardo-env" ]; then
    source "${HOME}/.leonardo-env"
fi

LEONARDO_USERNAME==="${LEONARDO_USERNAME==:-${USERNAME:-}}"
LEONARDO_PASS="${LEONARDO_PASS:-${PASSWORD:-}}"
LEONARDO_LOGIN="${LEONARDO_LOGIN:-login01-ext.leonardo.cineca.it}"

if [ -z "${LEONARDO_USERNAME==:-}" ]; then
    echo "ERROR: LEONARDO_USERNAME==/USERNAME not set."
    echo "Set it in .leonardo-access or ~/.leonardo-env"
    exit 1
fi

MODEL_ID="${1:-Qwen/Qwen3.6-27B}"
NUM_GPUS="${2:-4}"
MODEL_NAME="${3:-qwen3.6-27b}"

echo "=== ModuleWarden vLLM Deploy ==="
echo "User: ${LEONARDO_USERNAME==}"
echo "Login: ${LEONARDO_LOGIN}"
echo "Model: ${MODEL_ID}"
echo "GPUs: ${NUM_GPUS}"
echo ""

# ── Upload Slurm script ─────────────────────────────────────
SLURM_SCRIPT="${SCRIPT_DIR}/slurm-vllm.sh"

echo "Uploading Slurm script to Leonardo..."
scp "${SLURM_SCRIPT}" "${LEONARDO_USERNAME==}@${LEONARDO_LOGIN}:~/mw-slurm-vllm.sh"

# ── Submit job ──────────────────────────────────────────────
echo "Submitting vLLM job..."
JOB_ID=$(ssh "${LEONARDO_USERNAME==}@${LEONARDO_LOGIN}" \
    "sbatch --parsable ~/mw-slurm-vllm.sh" 2>&1)

if [[ ! "${JOB_ID}" =~ ^[0-9]+$ ]]; then
    echo "ERROR: Failed to submit job. Output: ${JOB_ID}"
    exit 1
fi

echo "Job submitted: ${JOB_ID}"

# ── Wait for job to start ───────────────────────────────────
echo "Waiting for job to start (this may take a few minutes)..."
for i in $(seq 1 60); do
    STATE=$(ssh "${LEONARDO_USERNAME==}@${LEONARDO_LOGIN}" \
        "squeue --job ${JOB_ID} --noheader --format=%T 2>/dev/null || echo 'UNKNOWN'")
    
    if [ "${STATE}" = "RUNNING" ]; then
        break
    fi
    
    if [ "${STATE}" = "UNKNOWN" ] || [ "${STATE}" = "FAILED" ] || [ "${STATE}" = "CANCELLED" ]; then
        echo "ERROR: Job entered state: ${STATE}"
        echo "Check logs: ssh ${LEONARDO_USERNAME==}@${LEONARDO_LOGIN} 'cat slurm-vllm-${JOB_ID}.err'"
        exit 1
    fi
    
    echo "  State: ${STATE} (attempt ${i}/60)"
    sleep 10
done

# ── Get compute node ────────────────────────────────────────
NODE=$(ssh "${LEONARDO_USERNAME==}@${LEONARDO_LOGIN}" \
    "squeue --job ${JOB_ID} --noheader --format=%N 2>/dev/null")

echo ""
echo "=== vLLM Job Running ==="
echo "Job ID: ${JOB_ID}"
echo "Node: ${NODE}"
echo "Model: ${MODEL_NAME}"
echo ""
echo "Next steps:"
echo "  1. Wait for model to load (~2-5 min)"
echo "  2. Set up SSH tunnel:"
echo "     ./scripts/leonardo/tunnel.sh ${NODE} 8000 8081"
echo "  3. Health check:"
echo "     ./scripts/leonardo/vllm-health-check.sh"
echo "  4. Start ModuleWarden with Leonardo config"
echo ""
echo "Monitor logs:"
echo "  ssh ${LEONARDO_USERNAME==}@${LEONARDO_LOGIN} 'tail -f slurm-vllm-${JOB_ID}.out'"
echo ""
echo "Cancel job:"
echo "  ssh ${LEONARDO_USERNAME==}@${LEONARDO_LOGIN} 'scancel ${JOB_ID}'"

# Save state for tunnel script
STATE_FILE="${REPO_ROOT}/.leonardo-vllm-state"
cat > "${STATE_FILE}" << EOF
JOB_ID=${JOB_ID}
NODE=${NODE}
MODEL_NAME=${MODEL_NAME}
PORT=8000
LOCAL_PORT=8081
LEONARDO_USERNAME===${LEONARDO_USERNAME==}
LEONARDO_LOGIN=${LEONARDO_LOGIN}
EOF

echo "State saved to ${STATE_FILE}"
