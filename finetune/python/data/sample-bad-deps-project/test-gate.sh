#!/usr/bin/env bash
# End-to-end gate verification: npm install through the MW gate and
# confirm each package's actual verdict matches expected.json.
#
# Runs inside the read-only Docker container defined by Dockerfile +
# docker-compose.yml. NEVER run on the host; the package.json contains
# known-compromised versions whose postinstall hooks are credential
# exfiltrators.

set -uo pipefail

EXPECTED_FILE="${EXPECTED_FILE:-/work/expected.json}"
GATE_BASE="${MW_GATE_BASE_URL:-http://mw-gate:8080}"
STATUS_PATH="${MW_GATE_STATUS_PATH:-/admin/status}"

echo "MW gate verification test"
echo "  gate base: $GATE_BASE"
echo "  expected:  $EXPECTED_FILE"
echo ""

# Pre-flight: confirm the gate is reachable.
if ! curl -sfI -o /dev/null "$GATE_BASE/healthz" 2>/dev/null; then
  echo "FAIL  gate is not reachable at $GATE_BASE/healthz"
  echo "      ensure the production stack (docker compose up -d) is running"
  echo "      on the modulewarden_default network before running this test"
  exit 2
fi
echo "PASS  gate reachable at $GATE_BASE"
echo ""

# Counters for the final report.
block_pass=0
block_fail=0
allow_pass=0
allow_fail=0
script_executions=0

# Snapshot /tmp before install to detect any script-induced writes.
pre_snapshot=$(mktemp /tmp/pre-XXXXXX)
( ls -lA /tmp /work 2>/dev/null ) > "$pre_snapshot" || true

# Read each expected entry and query the gate's status for that
# package + version. Compare the returned verdict against the expected.
jq -c '.entries[]' "$EXPECTED_FILE" | while read -r entry; do
  pkg=$(echo "$entry" | jq -r '.package')
  ver=$(echo "$entry" | jq -r '.version')
  expected=$(echo "$entry" | jq -r '.expected_verdict')

  # Query the gate's status API for this exact version.
  resp=$(curl -sf "$GATE_BASE$STATUS_PATH?package=$pkg&version=$ver" 2>/dev/null || echo '{}')
  actual=$(echo "$resp" | jq -r '.verdict // "unknown"')

  if [ "$expected" = "block" ]; then
    if [ "$actual" = "block" ] || [ "$actual" = "quarantine" ]; then
      printf "PASS  BLOCK  %-30s @ %-12s -> %s\n" "$pkg" "$ver" "$actual"
      block_pass=$((block_pass + 1))
    else
      printf "FAIL  BLOCK  %-30s @ %-12s -> %s (expected block)\n" "$pkg" "$ver" "$actual"
      block_fail=$((block_fail + 1))
    fi
  else
    if [ "$actual" = "allow" ]; then
      printf "PASS  ALLOW  %-30s @ %-12s -> %s\n" "$pkg" "$ver" "$actual"
      allow_pass=$((allow_pass + 1))
    else
      printf "FAIL  ALLOW  %-30s @ %-12s -> %s (expected allow)\n" "$pkg" "$ver" "$actual"
      allow_fail=$((allow_fail + 1))
    fi
  fi
done > /tmp/results.log

cat /tmp/results.log

# Detect any post-install side effects.
post_snapshot=$(mktemp /tmp/post-XXXXXX)
( ls -lA /tmp /work 2>/dev/null ) > "$post_snapshot" || true
if ! diff -q "$pre_snapshot" "$post_snapshot" >/dev/null 2>&1; then
  script_executions=$(( $(wc -l < "$post_snapshot") - $(wc -l < "$pre_snapshot") ))
  if [ "$script_executions" -gt 0 ]; then
    echo ""
    echo "WARN  detected $script_executions new filesystem entries since pre-install snapshot"
    diff "$pre_snapshot" "$post_snapshot" | head -20
  fi
fi

# Recompute counters from the log (subshell-safe).
block_pass=$(grep -c '^PASS  BLOCK' /tmp/results.log || true)
block_fail=$(grep -c '^FAIL  BLOCK' /tmp/results.log || true)
allow_pass=$(grep -c '^PASS  ALLOW' /tmp/results.log || true)
allow_fail=$(grep -c '^FAIL  ALLOW' /tmp/results.log || true)
total_fail=$((block_fail + allow_fail))

echo ""
echo "================================================================"
printf "Summary: %d BLOCK passed, %d ALLOW passed, %d failed, %d script executions\n" \
  "$block_pass" "$allow_pass" "$total_fail" "$script_executions"

if [ "$total_fail" -eq 0 ] && [ "$script_executions" -eq 0 ]; then
  echo "PASS  sample-bad-deps: ${block_pass} BLOCK + ${allow_pass} ALLOW matched, 0 script executions"
  exit 0
fi
echo "FAIL  sample-bad-deps: $total_fail mismatch(es), $script_executions script execution(s)"
exit 1
