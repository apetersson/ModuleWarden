#!/bin/sh
# ── ModuleWarden Audit Container Entrypoint ────────────────
# This container runs a PI RPC session or a fallback process.
# The worker injects the run-specific workspace, RPC token, and
# evidence inputs before starting.
#
# Environment variables set by worker:
#   MW_RPC_TOKEN    - Short-lived, single-run RPC token
#   MW_RPC_PORT     - RPC port (default 9090)
#   MW_WORKSPACE    - Path to run-specific workspace
#
# The container has recorded-open egress (public internet only).
# No core prompts, model credentials, or DB credentials.

set -e

WORKSPACE="${MW_WORKSPACE:-/workspace}"
RPC_PORT="${MW_RPC_PORT:-9090}"

echo "[audit-runner] Starting audit session..."
echo "[audit-runner] Workspace: ${WORKSPACE}"
echo "[audit-runner] RPC port: ${RPC_PORT}"
echo "[audit-runner] Package: ${MW_PACKAGE_NAME:-unknown}@${MW_PACKAGE_VERSION:-unknown}"

cd "${WORKSPACE}"

# Ensure output directory exists (writable via volume mount)
mkdir -p output/inspection

# Check if PI is available
if command -v pi >/dev/null 2>&1; then
  echo "[audit-runner] Starting PI RPC mode..."
  exec pi rpc --token "${MW_RPC_TOKEN}" --port "${RPC_PORT}"
else
  echo "[audit-runner] PI runtime not installed in this image."
  echo "[audit-runner] Running in inspection mode — capturing package metadata."

  # Run basic inspection as evidence
  if [ -f inputs/package.tgz ]; then
    tar -tzf inputs/package.tgz > output/inspection/file-list.txt 2>/dev/null || \
      echo "Could not extract tarball" > output/inspection/result.txt
  else
    echo "No package tarball provided" > output/inspection/result.txt
  fi

  # Collect environment info as evidence (redact RPC token)
  env | grep -v MW_RPC_TOKEN > output/inspection/env.txt 2>/dev/null || true
  uname -a > output/inspection/system.txt 2>/dev/null || true

  echo "[audit-runner] Inspection complete."
  echo "[audit-runner] Output written to ${WORKSPACE}/output/"
fi
