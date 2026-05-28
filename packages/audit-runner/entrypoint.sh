#!/bin/sh
# ── ModuleWarden Audit Container Entrypoint ────────────────
#
# This container runs the PI audit orchestrator in the foreground. The
# orchestrator requires an RPC bridge server on MW_RPC_PORT; missing bridge,
# PI, or model configuration is a hard audit failure.
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

# ── Step 2: Run PI audit orchestrator ──────────────────────
ORCHESTRATOR="/app/orchestrator/index.js"
if [ -f "${ORCHESTRATOR}" ]; then
  echo "[entrypoint] Starting PI audit orchestrator..."
  set +e
  node "${ORCHESTRATOR}"
  ORCH_EXIT=$?
  set -e
  echo "[entrypoint] Orchestrator exited with code ${ORCH_EXIT}"
else
  echo "[entrypoint] Orchestrator not found at ${ORCHESTRATOR}"
  ORCH_EXIT=1
fi

# Capture final workspace state
ls -la "${OUTPUT_DIR}/" > "${OUTPUT_DIR}/output-manifest.txt" 2>/dev/null || true

echo "[entrypoint] Audit container complete. Exit code: ${ORCH_EXIT}"
exit ${ORCH_EXIT}
