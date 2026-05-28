#!/bin/sh
# ── ModuleWarden Audit Container Entrypoint ────────────────
#
# This container runs two processes:
# 1. The RPC bridge server (background) — serves tool endpoints for PI
# 2. The PI audit orchestrator (foreground) — runs PI, captures verdict
#
# The worker injects the run-specific workspace, RPC token,
# package inputs, and prepared evidence before starting.
#
# Environment variables set by worker:
#   MW_RPC_TOKEN    - Short-lived, single-run RPC token
#   MW_RPC_PORT     - RPC port (default 9090)
#   MW_WORKSPACE    - Path to run-specific workspace
#   MW_PACKAGE_NAME - Package under audit
#   MW_PACKAGE_VERSION - Package version
#   MW_API_BASE     - ModuleWarden API base URL (default http://modulewarden-api:4000)
#
# The container has recorded-open egress (public internet only).
# No core prompts, model credentials, or DB credentials are exposed.

set -e

WORKSPACE="${MW_WORKSPACE:-/workspace}"
RPC_PORT="${MW_RPC_PORT:-9090}"
OUTPUT_DIR="${WORKSPACE}/output"

echo "[entrypoint] Starting audit container..."
echo "[entrypoint] Workspace: ${WORKSPACE}"
echo "[entrypoint] RPC port: ${RPC_PORT}"
echo "[entrypoint] Package: ${MW_PACKAGE_NAME:-unknown}@${MW_PACKAGE_VERSION:-unknown}"
echo "[entrypoint] API base: ${MW_API_BASE:-http://modulewarden-api:4000}"

cd "${WORKSPACE}"

# Ensure output and evidence directories exist
mkdir -p "${OUTPUT_DIR}/evidence" "${OUTPUT_DIR}/inspection"

# ── Step 1: Unpack the package tarball ─────────────────────
if [ -f inputs/package.tgz ]; then
  echo "[entrypoint] Unpacking package tarball..."
  mkdir -p inputs/package
  tar -xzf inputs/package.tgz -C inputs/package --strip-components=1 2>/dev/null || \
    tar -xzf inputs/package.tgz -C inputs/package 2>/dev/null || \
    echo "Warning: Could not extract tarball" >&2
fi

# ── Step 2: Start the RPC bridge server (background) ──────
RPC_BRIDGE="/app/rpc-bridge/index.js"
if [ -f "${RPC_BRIDGE}" ]; then
  echo "[entrypoint] Starting RPC bridge server..."
  node "${RPC_BRIDGE}" &
  RPC_PID=$!
  echo "[entrypoint] RPC bridge PID: ${RPC_PID}"

  # Wait for bridge to be ready
  for i in $(seq 1 10); do
    if nc -z 127.0.0.1 "${RPC_PORT}" 2>/dev/null; then
      echo "[entrypoint] RPC bridge is ready on port ${RPC_PORT}"
      break
    fi
    sleep 0.5
  done
else
  echo "[entrypoint] Warning: RPC bridge not found at ${RPC_BRIDGE}"
  RPC_PID=""
fi

# ── Step 3: Run PI audit orchestrator ──────────────────────
ORCHESTRATOR="/app/orchestrator/index.js"
if [ -f "${ORCHESTRATOR}" ]; then
  echo "[entrypoint] Starting PI audit orchestrator..."
  node "${ORCHESTRATOR}"
  ORCH_EXIT=$?
  echo "[entrypoint] Orchestrator exited with code ${ORCH_EXIT}"
else
  echo "[entrypoint] Orchestrator not found at ${ORCHESTRATOR}"
  echo "[entrypoint] Running fallback inspection..."

  # Run basic inspection as evidence
  if [ -f inputs/package.json ]; then
    cp inputs/package.json "${OUTPUT_DIR}/inspection/package.json" 2>/dev/null || true
  fi
  env | grep -v MW_RPC_TOKEN > "${OUTPUT_DIR}/inspection/env.txt" 2>/dev/null || true
  uname -a > "${OUTPUT_DIR}/inspection/system.txt" 2>/dev/null || true
  ls -laR inputs/ > "${OUTPUT_DIR}/inspection/inputs-tree.txt" 2>/dev/null || true

  ORCH_EXIT=0
fi

# ── Step 4: Cleanup ─────────────────────────────────────────
if [ -n "${RPC_PID}" ]; then
  echo "[entrypoint] Stopping RPC bridge..."
  kill "${RPC_PID}" 2>/dev/null || true
  wait "${RPC_PID}" 2>/dev/null || true
fi

# Capture final workspace state
ls -la "${OUTPUT_DIR}/" > "${OUTPUT_DIR}/output-manifest.txt" 2>/dev/null || true

echo "[entrypoint] Audit container complete. Exit code: ${ORCH_EXIT}"
exit ${ORCH_EXIT}
