#!/bin/bash
# ── ModuleWarden: SSH Tunnel to Leonardo vLLM ─────────────────
#
# Establishes an SSH tunnel from localhost:<local_port> to the
# vLLM endpoint running on a Leonardo compute node.
#
# Uses AutoSSH if available for automatic reconnection.
# Falls back to plain SSH with a restart loop.
#
# Usage:
#   ./scripts/leonardo/tunnel.sh [node] [remote_port] [local_port]
#
# If node is not specified, reads from .leonardo-vllm-state.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"

# ── Load state ──────────────────────────────────────────────
STATE_FILE="${REPO_ROOT}/.leonardo-vllm-state"

# Load Leonardo credentials
if [ -f "${REPO_ROOT}/../.leonardo-access" ]; then
    source "${REPO_ROOT}/../.leonardo-access"
elif [ -f "${HOME}/.leonardo-env" ]; then
    source "${HOME}/.leonardo-env"
fi

LEONARDO_USER="${LEONARDO_USER:-${USERNAME:-}}"
LEONARDO_LOGIN="${LEONARDO_LOGIN:-login01-ext.leonardo.cineca.it}"

# Override from state file if it exists
if [ -f "${STATE_FILE}" ]; then
    source "${STATE_FILE}"
fi

# Command-line overrides
NODE="${1:-${NODE:-}}"
REMOTE_PORT="${2:-${PORT:-8000}}"
LOCAL_PORT="${3:-${LOCAL_PORT:-8081}}"

if [ -z "${NODE:-}" ]; then
    echo "ERROR: No compute node specified."
    echo "Usage: $0 <compute_node> [remote_port] [local_port]"
    echo "Or deploy first: ./scripts/leonardo/deploy-vllm.sh"
    exit 1
fi

if [ -z "${LEONARDO_USER:-}" ]; then
    echo "ERROR: LEONARDO_USER/USERNAME not set."
    echo "Set it in .leonardo-access or ~/.leonardo-env"
    exit 1
fi

echo "=== ModuleWarden SSH Tunnel ==="
echo "Local:    localhost:${LOCAL_PORT}"
echo "Remote:   ${NODE}:${REMOTE_PORT}"
echo "Gateway:  ${LEONARDO_USER}@${LEONARDO_LOGIN}"
echo ""

# ── Kill existing tunnel on this port ───────────────────────
EXISTING_PID=$(lsof -ti ":${LOCAL_PORT}" 2>/dev/null || true)
if [ -n "${EXISTING_PID}" ]; then
    echo "Killing existing process on port ${LOCAL_PORT} (PID: ${EXISTING_PID})"
    kill "${EXISTING_PID}" 2>/dev/null || true
    sleep 1
fi

# ── Use AutoSSH if available ────────────────────────────────
if command -v autossh &>/dev/null; then
    echo "Using AutoSSH for persistent tunnel..."
    export AUTOSSH_PIDFILE="${REPO_ROOT}/.leonardo-tunnel.pid"
    export AUTOSSH_LOGFILE="${REPO_ROOT}/.leonardo-tunnel.log"
    export AUTOSSH_POLL=30
    export AUTOSSH_GATETIME=0
    
    autossh -M 0 -f -N -T \
        -o "ServerAliveInterval=30" \
        -o "ServerAliveCountMax=3" \
        -o "ExitOnForwardFailure=yes" \
        -o "StrictHostKeyChecking=accept-new" \
        -L "${LOCAL_PORT}:${NODE}:${REMOTE_PORT}" \
        "${LEONARDO_USER}@${LEONARDO_LOGIN}"
    
    echo "AutoSSH tunnel established. PID: $(cat "${AUTOSSH_PIDFILE}")"
else
    echo "AutoSSH not found. Using plain SSH with restart loop..."
    echo "Install autossh for automatic reconnection: brew install autossh"
    echo ""
    
    # Plain SSH with restart loop
    while true; do
        echo "[$(date)] Establishing SSH tunnel..."
        ssh -N -T \
            -o "ServerAliveInterval=30" \
            -o "ServerAliveCountMax=3" \
            -o "ExitOnForwardFailure=yes" \
            -o "StrictHostKeyChecking=accept-new" \
            -L "${LOCAL_PORT}:${NODE}:${REMOTE_PORT}" \
            "${LEONARDO_USER}@${LEONARDO_LOGIN}" \
            2>&1 | tee -a "${REPO_ROOT}/.leonardo-tunnel.log"
        
        echo "[$(date)] Tunnel disconnected. Reconnecting in 5s..."
        sleep 5
    done &
    
    TUNNEL_PID=$!
    echo "SSH tunnel running in background (PID: ${TUNNEL_PID})"
    echo "${TUNNEL_PID}" > "${REPO_ROOT}/.leonardo-tunnel.pid"
fi

echo ""
echo "Tunnel active. Test with:"
echo "  curl http://localhost:${LOCAL_PORT}/v1/models"
echo ""
echo "Stop tunnel:"
echo "  kill \$(cat ${REPO_ROOT}/.leonardo-tunnel.pid)"
