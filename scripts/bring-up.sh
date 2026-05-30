#!/bin/bash
# ── ModuleWarden: Full Stack Bring-Up ────────────────────────
#
# Starts the complete ModuleWarden stack locally. Configure by setting
# .env before calling this script (use pnpm start:openai or pnpm start:leonardo).
#
# Prerequisites:
#   1. Docker daemon running
#   2. .env configured with model endpoint, Verdaccio, and auth settings
#   3. (Leonardo only) vLLM deployed + SSH tunnel active
#
# Usage:
#   ./scripts/bring-up.sh [--build] [--profile local-model-endpoint] [--skip-tunnel-check]
#
# Options:
#   --build               Rebuild Docker images before starting
#   --profile             Additional docker compose profiles
#   --skip-tunnel-check   Don't check for the Leonardo SSH tunnel

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

cd "${REPO_ROOT}"

echo "=== ModuleWarden: Full Stack Bring-Up ==="
echo ""

# ── Parse flags first (before checks that depend on them) ───
BUILD_FLAG=""
PROFILE_ARGS=""
SKIP_TUNNEL_CHECK=false
while [[ $# -gt 0 ]]; do
    case "$1" in
        --build) BUILD_FLAG="--build" ;;
        --profile) PROFILE_ARGS="--profile $2"; shift ;;
        --skip-tunnel-check) SKIP_TUNNEL_CHECK=true ;;
        *) echo "Unknown flag: $1"; exit 1 ;;
    esac
    shift
done

# ── Check prerequisites ─────────────────────────────────────

# Ensure .env exists
if [ ! -f .env ]; then
    echo "ERROR: .env file not found."
    echo "Run: pnpm start:openai   (for OpenAI / remote API backends)"
    echo " or: pnpm start:leonardo (for Leonardo HPC backend)"
    exit 1
fi

# Source the env to check configuration
source .env 2>/dev/null || true

require_env() {
    local name="$1"
    local value="${!name:-}"
    if [ -z "${value//[[:space:]]/}" ]; then
        echo "ERROR: ${name} is required but is not set."
        echo "Set ${name} in .env before starting ModuleWarden."
        exit 1
    fi
}

require_env MW_MODEL_ENDPOINT_BASE_URL
require_env MW_MODEL_ENDPOINT_API_KEY
require_env MW_MODEL_ENDPOINT_MODEL
require_env MW_VERDACCIO_URL
require_env MW_VERDACCIO_TOKEN

# ── Build audit-runner image ────────────────────────────────
echo ""
echo "Building audit-runner image..."
echo "  [1/3] Compiling TypeScript..."
pnpm --filter @modulewarden/audit-runner build 2>&1 | tail -3
echo "  [2/3] Bundling RPC server..."
pnpm --filter @modulewarden/audit-rpc-server bundle 2>&1 | tail -3
echo "  [3/3] Building Docker image (may take ~60s)..."
docker compose build audit-runner
echo "  Done."

# ── Check model endpoint (skip for non-Leonardo backends) ───
TUNNEL_HOST="${MW_MODEL_ENDPOINT_BASE_URL}"
TUNNEL_URL="${TUNNEL_HOST}"
# host.docker.internal only resolves inside Docker — swap to localhost for host-side checks
CHECK_URL="${TUNNEL_URL/host.docker.internal/localhost}"
if [ "${SKIP_TUNNEL_CHECK}" = true ]; then
    echo ""
    echo "Skipping model endpoint reachability check."
    echo "  Endpoint: ${TUNNEL_URL}"
else
    echo ""
    echo "Checking model endpoint: ${CHECK_URL}..."
    if curl -s --connect-timeout 5 "${CHECK_URL}/models" > /dev/null 2>&1; then
        echo "  Model endpoint is reachable."
    else
        echo "  WARNING: Model endpoint is not reachable at ${TUNNEL_URL}"
        echo "  If using Leonardo, make sure the SSH tunnel is up:"
        echo "    ./scripts/leonardo/tunnel.sh"
        echo ""
        read -rp "  Continue anyway? [y/N] " yn
        if [[ ! "${yn}" =~ ^[Yy]$ ]]; then
            exit 1
        fi
    fi
fi

# ── Start the stack ─────────────────────────────────────────
echo ""
echo "Starting ModuleWarden stack..."
echo "  Concurrency: audit-container-exec=${MW_JOB_CONCURRENCY_AUDIT_CONTAINER_EXEC:-8}"
echo "  Model: ${MW_MODEL_ENDPOINT_MODEL}"
echo "  Endpoint: ${MW_MODEL_ENDPOINT_BASE_URL}"
echo "  Verdaccio: ${MW_VERDACCIO_URL}"
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
echo "Model endpoint:"
echo "  ${TUNNEL_URL}"
if [ "${SKIP_TUNNEL_CHECK}" != true ]; then
    echo "  Health: ./scripts/leonardo/vllm-health-check.sh"
fi
echo ""
echo "Stop:"
echo "  docker compose down"
if [ "${SKIP_TUNNEL_CHECK}" != true ]; then
    echo "  ./scripts/leonardo/tunnel.sh  # Ctrl+C to stop tunnel"
fi
