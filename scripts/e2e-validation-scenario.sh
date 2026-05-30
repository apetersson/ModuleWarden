#!/usr/bin/env bash
set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PROJECT_NAME="${MW_E2E_PROJECT_NAME:-e2e-validation-scenario}"
RUN_ID="${RUN_ID:-$(date -u +%Y%m%dT%H%M%SZ)}"

export MW_E2E_AUDIT_WORKSPACE_HOST="${MW_E2E_AUDIT_WORKSPACE_HOST:-$ROOT_DIR/.e2e/audit-workspaces}"
export MW_E2E_AUDIT_SESSION_ARCHIVE_HOST="${MW_E2E_AUDIT_SESSION_ARCHIVE_HOST:-$ROOT_DIR/.e2e/audit-sessions}"
export MW_E2E_VERDACCIO_STORAGE_HOST="${MW_E2E_VERDACCIO_STORAGE_HOST:-$ROOT_DIR/.e2e/verdaccio-storage}"
export MW_E2E_RESULTS_HOST="${MW_E2E_RESULTS_HOST:-$ROOT_DIR/.e2e/results}"
export MW_E2E_API_PORT="${MW_E2E_API_PORT:-8080}"
export MW_E2E_WEB_UI_PORT="${MW_E2E_WEB_UI_PORT:-13000}"
export MW_E2E_HOST_API_BASE_URL="${MW_E2E_HOST_API_BASE_URL:-http://localhost:$MW_E2E_API_PORT}"
export MW_E2E_HOST_WEB_URL="${MW_E2E_HOST_WEB_URL:-http://localhost:$MW_E2E_WEB_UI_PORT}"
export MW_E2E_BROWSER_API_BASE_URL="${MW_E2E_BROWSER_API_BASE_URL:-$MW_E2E_HOST_API_BASE_URL}"

require_env() {
  local name="$1"
  local value="${!name:-}"
  if [ -z "${value//[[:space:]]/}" ]; then
    echo "ERROR: ${name} is required but is not set." >&2
    echo "Set ${name} before running the E2E validation scenario." >&2
    exit 1
  fi
}

require_env MW_MODEL_ENDPOINT_BASE_URL
require_env MW_MODEL_ENDPOINT_API_KEY
require_env MW_MODEL_ENDPOINT_MODEL
require_env MW_VERDACCIO_URL
require_env MW_VERDACCIO_TOKEN
export MW_MODEL_ENDPOINT_BASE_URL
export MW_MODEL_ENDPOINT_API_KEY
export MW_MODEL_ENDPOINT_MODEL
export MW_VERDACCIO_URL
export MW_VERDACCIO_TOKEN
export MW_PRESERVE_AUDIT_SESSIONS="${MW_PRESERVE_AUDIT_SESSIONS:-true}"
export MW_AUTH_ADMIN_TOKENS="${MW_AUTH_ADMIN_TOKENS:-mw-admin-token-change-me}"
export MW_AUTH_DEV_TOKENS="${MW_AUTH_DEV_TOKENS:-mw-dev-token-change-me}"

RESULTS_DIR="$MW_E2E_RESULTS_HOST/$RUN_ID"
mkdir -p "$MW_E2E_AUDIT_WORKSPACE_HOST" "$MW_E2E_AUDIT_SESSION_ARCHIVE_HOST" "$MW_E2E_VERDACCIO_STORAGE_HOST" "$RESULTS_DIR"

compose() {
  docker compose \
    -p "$PROJECT_NAME" \
    -f "$ROOT_DIR/docker-compose.yml" \
    -f "$ROOT_DIR/docker-compose.e2e-validation.yml" \
    "$@"
}

psql_scalar() {
  compose exec -T postgres psql -U modulewarden -d modulewarden -tA -c "$1" | tr -d '\r'
}

wait_for_api() {
  for _ in $(seq 1 90); do
    if curl -fsS "$MW_E2E_HOST_API_BASE_URL/health" > "$RESULTS_DIR/health.json"; then
      return 0
    fi
    sleep 2
  done
  echo "API did not become healthy at $MW_E2E_HOST_API_BASE_URL" >&2
  compose logs --tail=200 api-proxy >&2 || true
  return 1
}

seed_ready_project() {
  compose exec -T postgres psql -U modulewarden -d modulewarden <<'SQL'
insert into "Project" (
  id,
  name,
  description,
  "graphState",
  "registryEnabled",
  "createdAt",
  "updatedAt"
) values (
  '00000000-0000-4000-8000-000000000001',
  'E2EValidationScenario',
  'Ephemeral project seeded by scripts/e2e-validation-scenario.sh',
  'READY',
  true,
  now(),
  now()
) on conflict (name) do update set
  "graphState" = 'READY',
  "registryEnabled" = true,
  "updatedAt" = now();
SQL
}

run_demo_install_attempt() {
  local label="$1"
  compose --profile e2e run --rm --no-deps -T -e RUN_ID="$RUN_ID" -e ATTEMPT_LABEL="$label" --entrypoint /bin/sh e2e-runner <<'RUNNER'
set -eu

RESULTS_DIR="/scenario/results/${RUN_ID}"
mkdir -p "${RESULTS_DIR}"

if ! command -v pnpm >/dev/null 2>&1; then
  npm install -g pnpm@9 > "${RESULTS_DIR}/runner-pnpm-install-${ATTEMPT_LABEL}.log" 2>&1
fi

cd /scenario/demo-project

if [ "${ATTEMPT_LABEL}" = "first" ]; then
  find . -mindepth 1 -maxdepth 1 -exec rm -rf {} +
  cat > package.json <<'JSON'
{
  "name": "modulewarden-e2e-demo-project",
  "version": "0.0.0",
  "private": true,
  "scripts": {
    "start": "node index.js"
  }
}
JSON
  cat > index.js <<'JS'
console.log("ModuleWarden E2E validation demo app");
JS
fi

pnpm config set registry "${MW_REGISTRY_URL}" > "${RESULTS_DIR}/pnpm-registry-${ATTEMPT_LABEL}.txt"
npm config set registry "${MW_REGISTRY_URL}" > "${RESULTS_DIR}/npm-registry-${ATTEMPT_LABEL}.txt"
pnpm config get registry >> "${RESULTS_DIR}/pnpm-registry-${ATTEMPT_LABEL}.txt"
npm config get registry >> "${RESULTS_DIR}/npm-registry-${ATTEMPT_LABEL}.txt"

if [ "${ATTEMPT_LABEL}" = "second" ]; then
  rm -rf node_modules pnpm-lock.yaml
fi

set +e
pnpm add cors-anywhere@0.4.4 > "${RESULTS_DIR}/${ATTEMPT_LABEL}-pnpm-add.log" 2>&1
rc=$?
set -e

echo "${rc}" > "${RESULTS_DIR}/${ATTEMPT_LABEL}-pnpm-add.exitcode"
if [ -d node_modules/cors-anywhere ]; then
  echo "installed" > "${RESULTS_DIR}/${ATTEMPT_LABEL}-install-state.txt"
else
  echo "not-installed" > "${RESULTS_DIR}/${ATTEMPT_LABEL}-install-state.txt"
fi
RUNNER
}

maybe_drive_tarball_review_path() {
  local count
  count="$(psql_scalar "select count(*) from \"ReviewJob\" r join \"PackageVersion\" pv on pv.id = r.\"packageVersionId\" where pv.\"packageName\" = 'cors-anywhere' and pv.version = '0.4.4';")"
  if [ "$count" != "0" ]; then
    echo "Review job already exists after package-manager install path."
    return 0
  fi

  echo "No review job appeared from pnpm add; driving tarball route directly to expose and continue the scenario."
  local http_code
  http_code="$(curl -sS -o "$RESULTS_DIR/direct-tarball-first.json" -w "%{http_code}" \
    "$MW_E2E_HOST_API_BASE_URL/cors-anywhere/-/cors-anywhere-0.4.4.tgz" || true)"
  echo "$http_code" > "$RESULTS_DIR/direct-tarball-first.httpcode"
}

wait_for_review_and_audit() {
  local review_count audit_count audit_status

  for _ in $(seq 1 90); do
    review_count="$(psql_scalar "select count(*) from \"ReviewJob\" r join \"PackageVersion\" pv on pv.id = r.\"packageVersionId\" where pv.\"packageName\" = 'cors-anywhere' and pv.version = '0.4.4';")"
    if [ "$review_count" != "0" ]; then
      break
    fi
    sleep 2
  done

  for _ in $(seq 1 120); do
    audit_count="$(psql_scalar "select count(*) from \"AuditRun\" ar join \"ReviewJob\" r on r.id = ar.\"reviewJobId\" join \"PackageVersion\" pv on pv.id = r.\"packageVersionId\" where pv.\"packageName\" = 'cors-anywhere' and pv.version = '0.4.4';")"
    audit_status="$(psql_scalar "select coalesce((select ar.status::text from \"AuditRun\" ar join \"ReviewJob\" r on r.id = ar.\"reviewJobId\" join \"PackageVersion\" pv on pv.id = r.\"packageVersionId\" where pv.\"packageName\" = 'cors-anywhere' and pv.version = '0.4.4' order by ar.\"createdAt\" desc limit 1), 'none');")"
    echo "$audit_status" > "$RESULTS_DIR/latest-audit-status.txt"
    if [ "$audit_count" != "0" ] && [ "$audit_status" != "PENDING" ] && [ "$audit_status" != "RUNNING" ]; then
      return 0
    fi
    sleep 2
  done

  echo "Timed out waiting for audit completion; continuing with captured state." | tee "$RESULTS_DIR/audit-wait-timeout.txt"
}

force_block_verdict() {
  local admin_token="${MW_AUTH_ADMIN_TOKENS%%,*}"
  local http_code
  http_code="$(curl -sS -o "$RESULTS_DIR/admin-override-block.json" -w "%{http_code}" \
    -X POST "$MW_E2E_HOST_API_BASE_URL/admin/override" \
    -H "Authorization: Bearer ${admin_token}" \
    -H "Content-Type: application/json" \
    --data '{
      "packageName": "cors-anywhere",
      "version": "0.4.4",
      "targetVerdict": "BLOCK",
      "scope": "SPECIFIC_VERSION",
      "reason": "Manual E2EValidationScenario policy block: permissive CORS proxy dependency is not allowed in this project."
    }' || true)"
  echo "$http_code" > "$RESULTS_DIR/admin-override-block.httpcode"
}

validate_blocked_tarball() {
  local http_code
  http_code="$(curl -sS -o "$RESULTS_DIR/direct-tarball-after-block.json" -w "%{http_code}" \
    "$MW_E2E_HOST_API_BASE_URL/cors-anywhere/-/cors-anywhere-0.4.4.tgz" || true)"
  echo "$http_code" > "$RESULTS_DIR/direct-tarball-after-block.httpcode"
}

capture_results() {
  curl -sS "$MW_E2E_HOST_API_BASE_URL/health" > "$RESULTS_DIR/health-final.json" || true
  curl -sS "$MW_E2E_HOST_API_BASE_URL/status" > "$RESULTS_DIR/status.json" || true
  curl -sS "$MW_E2E_HOST_API_BASE_URL/status/cors-anywhere" > "$RESULTS_DIR/cors-anywhere-status.json" || true
  curl -sS "$MW_E2E_HOST_API_BASE_URL/status/cors-anywhere/0.4.4" > "$RESULTS_DIR/cors-anywhere-0.4.4-status.json" || true

  compose ps > "$RESULTS_DIR/compose-ps.txt" || true
  compose logs --tail=500 api-proxy > "$RESULTS_DIR/api-proxy.log" || true
  compose logs --tail=800 worker > "$RESULTS_DIR/worker.log" || true
  compose logs --tail=300 web-ui > "$RESULTS_DIR/web-ui.log" || true
  find "$MW_E2E_AUDIT_SESSION_ARCHIVE_HOST" -maxdepth 3 -print > "$RESULTS_DIR/audit-sessions.txt" 2>/dev/null || true

  compose exec -T postgres psql -U modulewarden -d modulewarden <<'SQL' > "$RESULTS_DIR/db-snapshot.txt" || true
select pv."packageName", pv.version, pv."tarballHash", pv."createdAt"
from "PackageVersion" pv
where pv."packageName" = 'cors-anywhere'
order by pv."createdAt" desc;

select r.id, pv."packageName", pv.version, r.trigger, r.status, r."auditContext", r."pgBossJobId", r."createdAt", r."updatedAt", r."failureReason"
from "ReviewJob" r
join "PackageVersion" pv on pv.id = r."packageVersionId"
where pv."packageName" = 'cors-anywhere'
order by r."createdAt" desc;

select ar.id, ar.status, ar."containerId", ar."startedAt", ar."completedAt", ar."errorMessage"
from "AuditRun" ar
join "ReviewJob" r on r.id = ar."reviewJobId"
join "PackageVersion" pv on pv.id = r."packageVersionId"
where pv."packageName" = 'cors-anywhere'
order by ar."createdAt" desc;

select d.id, pv."packageName", pv.version, d.verdict, d."reasonSummary", d."actorType", d."createdAt"
from "Decision" d
join "PackageVersion" pv on pv.id = d."packageVersionId"
where pv."packageName" = 'cors-anywhere'
order by d."createdAt" desc;
SQL
}

case "${1:-run}" in
  down)
    compose down -v --remove-orphans
    exit 0
    ;;
  run)
    ;;
  *)
    echo "Usage: $0 [run|down]" >&2
    exit 2
    ;;
esac

cd "$ROOT_DIR"

if [ "${MW_E2E_KEEP_EXISTING:-0}" != "1" ]; then
  compose down -v --remove-orphans >/dev/null 2>&1 || true
fi

echo "Building local audit-runner dist..."
pnpm --filter @modulewarden/audit-rpc-server bundle
pnpm --filter @modulewarden/audit-runner build

echo "Building E2EValidationScenario images..."
compose build audit-runner api-proxy worker web-ui migrate

echo "Starting E2EValidationScenario stack..."
compose up -d postgres verdaccio migrate api-proxy worker web-ui
wait_for_api
seed_ready_project

echo "Running first demo install attempt inside docker volume..."
run_demo_install_attempt first
maybe_drive_tarball_review_path
wait_for_review_and_audit

echo "Forcing block verdict for deterministic retry validation..."
force_block_verdict

echo "Running second demo install attempt inside docker volume..."
run_demo_install_attempt second
validate_blocked_tarball
capture_results

first_state="$(cat "$RESULTS_DIR/first-install-state.txt" 2>/dev/null || echo unknown)"
second_state="$(cat "$RESULTS_DIR/second-install-state.txt" 2>/dev/null || echo unknown)"
block_code="$(cat "$RESULTS_DIR/direct-tarball-after-block.httpcode" 2>/dev/null || echo unknown)"

cat > "$RESULTS_DIR/summary.txt" <<SUMMARY
E2EValidationScenario run: ${RUN_ID}
Project: ${PROJECT_NAME}
API: ${MW_E2E_HOST_API_BASE_URL}
Web UI: ${MW_E2E_HOST_WEB_URL}
Results: ${RESULTS_DIR}
Audit sessions: ${MW_E2E_AUDIT_SESSION_ARCHIVE_HOST}

First pnpm install state: ${first_state}
Second pnpm install state: ${second_state}
Blocked tarball HTTP code: ${block_code}

Expected core validation:
- first install should not install cors-anywhere@0.4.4
- review/audit state should be visible in DB/API/log captures
- manual block override should make the tarball route return HTTP 403
- second install should not install cors-anywhere@0.4.4

Known product gap marker:
- if first-pnpm-add.log says no matching version and direct-tarball-first.httpcode is 404,
  the approved-only packument filtered the package before npm reached the tarball review route.
SUMMARY

cat "$RESULTS_DIR/summary.txt"

if [ "$first_state" = "installed" ] || [ "$second_state" = "installed" ] || [ "$block_code" != "403" ]; then
  echo "E2EValidationScenario completed with validation failures. See $RESULTS_DIR" >&2
  exit 1
fi
