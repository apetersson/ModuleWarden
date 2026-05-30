#!/usr/bin/env bash
set -euo pipefail
SANDBOX="${SANDBOX:-/tmp/mw-demo}"
rm -rf "$SANDBOX"
mkdir -p "$SANDBOX"
cat > "$SANDBOX/.npmrc" <<EOF
registry=http://localhost:8080/
//localhost:8080/:_authToken=mw-admin-token-change-me
fund=false
audit=false
EOF
cat > "$SANDBOX/package.json" <<'EOF'
{ "name": "mw-demo", "version": "0.0.0", "private": true }
EOF
echo "Sandbox ready at $SANDBOX"
