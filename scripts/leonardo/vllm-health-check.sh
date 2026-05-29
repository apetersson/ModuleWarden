#!/bin/bash
# ── ModuleWarden: vLLM Health Check ──────────────────────────
#
# Verifies that the Leonardo vLLM endpoint is reachable and
# the model is loaded and ready to serve requests.
#
# Usage:
#   ./scripts/leonardo/vllm-health-check.sh [endpoint]

set -euo pipefail

ENDPOINT="${1:-http://localhost:8081}"

echo "=== ModuleWarden vLLM Health Check ==="
echo "Endpoint: ${ENDPOINT}"
echo ""

# ── Check 1: /v1/models ─────────────────────────────────────
echo "1. Checking /v1/models..."
MODELS=$(curl -s "${ENDPOINT}/v1/models" 2>&1 || echo "FAILED")

if [ "${MODELS}" = "FAILED" ]; then
    echo "   FAILED: Cannot reach ${ENDPOINT}/v1/models"
    echo "   Is the SSH tunnel up? Run: ./scripts/leonardo/tunnel.sh"
    exit 1
fi

MODEL_NAMES=$(echo "${MODELS}" | python3 -c "import sys,json; data=json.load(sys.stdin); print(', '.join(m['id'] for m in data.get('data',[])))" 2>/dev/null || echo "PARSE_ERROR")
echo "   Models: ${MODEL_NAMES}"

# ── Check 2: /health ────────────────────────────────────────
echo "2. Checking /health..."
HEALTH=$(curl -s "${ENDPOINT}/health" 2>&1 || echo "FAILED")
echo "   ${HEALTH}"

# ── Check 3: Chat completion (smoke test) ───────────────────
echo "3. Running chat completion smoke test..."
FIRST_MODEL=$(echo "${MODELS}" | python3 -c "import sys,json; data=json.load(sys.stdin); print(data['data'][0]['id'])" 2>/dev/null || echo "")

if [ -n "${FIRST_MODEL}" ]; then
    RESPONSE=$(curl -s "${ENDPOINT}/v1/chat/completions" \
        -H "Content-Type: application/json" \
        -H "Authorization: Bearer vllm" \
        -d "{
            \"model\": \"${FIRST_MODEL}\",
            \"messages\": [{\"role\": \"user\", \"content\": \"Say 'ModuleWarden health check OK' and nothing else.\"}],
            \"max_tokens\": 50,
            \"temperature\": 0
        }" 2>&1)
    
    CONTENT=$(echo "${RESPONSE}" | python3 -c "import sys,json; print(json.load(sys.stdin)['choices'][0]['message']['content'])" 2>/dev/null || echo "PARSE_ERROR")
    echo "   Response: ${CONTENT}"
else
    echo "   SKIPPED: No models available yet (still loading?)"
fi

echo ""
echo "=== Health Check Complete ==="
