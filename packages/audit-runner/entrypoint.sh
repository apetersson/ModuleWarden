#!/bin/sh
# ── ModuleWarden Audit Container Entrypoint ────────────────
# This container runs a PI RPC session. The worker injects the
# run-specific workspace, RPC token, and evidence inputs before
# starting. This script waits for RPC instructions.
#
# Environment variables set by worker:
#   MW_RPC_TOKEN    - Short-lived, single-run RPC token
#   MW_RPC_PORT     - RPC port (default 9090)
#   MW_WORKSPACE    - Path to run-specific workspace
#
# The container has recorded-open egress (public internet only).
# No core prompts, model credentials, or DB credentials are
# provided to this container.

set -e

echo "[audit-runner] Starting PI RPC session..."
echo "[audit-runner] Workspace: ${MW_WORKSPACE:-/workspace}"
echo "[audit-runner] RPC port: ${MW_RPC_PORT:-9090}"

cd "${MW_WORKSPACE:-/workspace}"

# PI will connect back to ModuleWarden via RPC using the provided token.
# The worker handles container lifecycle and evidence collection.
exec pi rpc --token "${MW_RPC_TOKEN}" --port "${MW_RPC_PORT:-9090}"
