#!/usr/bin/env bash
# Bulletproof 90-second live demo driver for ModuleWarden.
#
# Runs preflight first and ABORTS if anything the audience would see is
# wrong. Then walks the three pitch incidents through the offline CLI (zero
# network, zero docker). The optional live npm-install -> 403 moment runs
# only if a proxy is reachable; if not, the offline path is the demo and the
# script still succeeds.
#
# Usage:
#   bash demo/safe_demo.sh                 # offline path only (always safe)
#   MW_PROXY_URL=http://localhost:8080 bash demo/safe_demo.sh   # + live 403
#   bash demo/safe_demo.sh --pause         # wait for Enter between sections
#
# Safety rules baked in (do not edit these out before stage):
#   - Never invite judges to type arbitrary packages. The three below are
#     pre-tested by preflight. Offer a whiteboard list, not a keyboard.
#   - If the proxy step hangs, Ctrl-C it; the offline replays above already
#     made the point. The proxy step is a bonus, never load-bearing.

set -euo pipefail

cd "$(dirname "$0")/.."   # repo root

PAUSE=0
[ "${1:-}" = "--pause" ] && PAUSE=1
pause() { [ "$PAUSE" = "1" ] && { printf '\n  (press Enter to continue)'; read -r _; } || true; }

bar() { printf '\n========================================================\n'; }

bar
echo "  STEP 0  Preflight (backstage gate - must pass before stage)"
bar
python -m demo.preflight || {
  echo ""
  echo "PREFLIGHT FAILED. Do not present. Fix the issue above first."
  exit 1
}
pause

bar
echo "  STEP 1  Compromised release -> BLOCK"
echo "          postmark-mcp-1.0.16 (real Sep 2025 npm compromise)"
bar
python -m demo.run_incident_replay --incident postmark-mcp-1.0.16
pause

bar
echo "  STEP 2  Last-known-clean release of the SAME package -> ALLOW"
echo "          postmark-mcp-1.0.12 (proves we don't blocklist by name)"
bar
python -m demo.run_incident_replay --incident postmark-mcp-1.0.12
pause

bar
echo "  STEP 3  Mainstream baseline -> ALLOW"
echo "          lodash-4.17.21 (proves we don't block everything)"
bar
python -m demo.run_incident_replay --incident lodash-4.17.21
pause

# ---- Optional live proxy moment (only if a proxy is reachable) ----
if [ -n "${MW_PROXY_URL:-}" ]; then
  bar
  echo "  STEP 4  Live registry proxy (optional - bonus, not load-bearing)"
  echo "          MW_PROXY_URL=${MW_PROXY_URL}"
  bar
  if curl -fsS --max-time 3 "${MW_PROXY_URL}" >/dev/null 2>&1 \
     || curl -sS --max-time 3 -o /dev/null "${MW_PROXY_URL}" 2>/dev/null; then
    echo "  Proxy is up. A real 'npm install' of a blocked version resolves to 403,"
    echo "  because the proxy filters the packument to ALLOW-only versions and the"
    echo "  tarball route denies blocked/quarantined tarballs."
    echo ""
    echo "  Showing the packument/tarball decision path:"
    curl -sS --max-time 5 "${MW_PROXY_URL}/postmark-mcp" 2>/dev/null \
      | python -m json.tool 2>/dev/null | head -20 \
      || echo "  (packument query returned no JSON; proxy may need DB/Verdaccio up)"
  else
    echo "  Proxy not reachable. Skipping the live 403 - the offline replays above"
    echo "  are the demo. This is expected and safe."
  fi
fi

bar
echo "  DEMO COMPLETE. Memos written to demo/outputs/."
echo "  Three verdicts shown: BLOCK (compromise), ALLOW (clean sibling), ALLOW (baseline)."
bar
