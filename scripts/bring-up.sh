#!/bin/bash
# ── ModuleWarden: Full Stack Bring-Up with Leonardo ──────────
#
# Starts the complete ModuleWarden stack locally, configured to use
# Leonardo-hosted vLLM (qwen3.6 27b) for agentic audit research.
#
# Prerequisites:
#   1. vLLM deployed on Leonardo: ./scripts/leonardo/deploy-vllm.sh
#   2. SSH tunnel active:          ./scripts/leonardo/tunnel.sh
#   3. Docker daemon running
#
# Usage:
#   ./scripts/bring-up.sh [--build] [--profile local-model-endpoint]
#
# Options:
#   --build     Rebuild Docker images before starting
#   --profile   Additional docker compose profiles

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

cd "${REPO_ROOT}"

echo "=== ModuleWarden: Bring-Up with Leonardo ==="
echo ""

# ── Check prerequisites ─────────────────────────────────────

# Ensure .env exists
if [ ! -f .env ]; then
    echo "ERROR: .env file not found."
    echo "Run: cp .env.leonardo-example .env"
    echo "Then edit .env if needed."
    exit 1
fi

# Source the env to check configuration
source .env 2>/dev/null || true

# Check SSH tunnel
TUNNEL_HOST="${MW_MODEL_ENDPOINT_BASE_URL:-http://host.docker.internal:8081/v1}"
TUNNEL_URL="${TUNNEL_HOST}"
echo "Checking model endpoint: ${TUNNEL_URL}..."

if curl -s --connect-timeout 5 "${TUNNEL_URL}/models" > /dev/null 2>&1; then
    echo "  Model endpoint is reachable."
else
    echo "  WARNING: Model endpoint is not reachable at ${TUNNEL_URL}"
    echo "  Make sure the SSH tunnel is up:"
    echo "    ./scripts/leonardo/tunnel.sh"
    echo ""
    read -rp "  Continue anyway? [y/N] " yn
    if [[ ! "${yn}" =~ ^[Yy]$ ]]; then
        exit 1
    fi
fi

# ── Build audit-runner image ────────────────────────────────
echo ""
echo "Building audit-runner image..."
pnpm --filter @modulewarden/audit-runner build 2>&1 | tail -3
pnpm --filter @modulewarden/audit-rpc-server bundle 2>&1 | tail -3
docker compose build audit-runner 2>&1 | tail -5
echo "  Done."

# ── Parse flags ─────────────────────────────────────────────
BUILD_FLAG=""
PROFILE_ARGS=""
while [[ $# -gt 0 ]]; do
    case "$1" in
        --build) BUILD_FLAG="--build" ;;
        --profile) PROFILE_ARGS="--profile $2"; shift ;;
        *) echo "Unknown flag: $1"; exit 1 ;;
    esac
    shift
done

# ── Start the stack ─────────────────────────────────────────
echo ""
echo "Starting ModuleWarden stack..."
echo "  Concurrency: audit-container-exec=${MW_JOB_CONCURRENCY_AUDIT_CONTAINER_EXEC:-8}"
echo "  Model: ${MW_MODEL_ENDPOINT_MODEL:-qwen3.6-27b}"
echo "  Endpoint: ${MW_MODEL_ENDPOINT_BASE_URL:-http://host.docker.internal:8081/v1}"
echo ""

# shellcheck disable=SC2086
docker compose up -d ${BUILD_FLAG} ${PROFILE_ARGS}

echo ""
echo "=== ModuleWarden is starting ==="
echo ""
echo "Services:"
echo "  API:      http://localhost:8080"
echo "  Web UI:   http://localhost:3000"
echo "  Worker:   http://localhost:9090 (internal)"
echo ""
echo "Monitor:"
echo "  docker compose logs -f worker"
echo "  docker compose ps"
echo ""
echo "Model endpoint (Leonardo via SSH tunnel):"
echo "  ${TUNNEL_URL}"
echo "  Health: ./scripts/leonardo/vllm-health-check.sh"
echo ""
echo "Stop:"
echo "  docker compose down"
echo "  ./scripts/leonardo/tunnel.sh  # Ctrl+C to stop tunnel"
