# Manual E2E Test Drive: Problematic Dependency Through ModuleWarden

## Goal

Validate the first end-to-end operator story with a fresh demo repository that accidentally adds a low-impact problematic dependency, routes package installation through a local ModuleWarden proxy backed by Verdaccio, queues an LLM audit through a DeepSeek-compatible endpoint, shows the audit in the dashboard, and blocks the dependency on retry after the audit verdict.

This runbook is intentionally manual. It should expose product gaps clearly instead of hiding them behind test helpers.

## Scenario

The demo repository tries to add a dependency with an intentionally risky security posture. Use a harmless low-impact package/version for the first drive, preferably one whose risk can be explained without executing attacker-controlled behavior.

Recommended first target:

- Package: `cors-anywhere`
- Version: pin an old/stable version available from npm, for example `0.4.4`
- Demo risk story: permissive CORS proxy behavior is dangerous when accidentally introduced into an application dependency graph.

If `cors-anywhere@0.4.4` is unavailable or unsuitable, replace it with another harmless package that has an obvious policy problem. Keep the package small and non-destructive.

## Expected Product Behavior

1. A developer creates a demo repo and configures npm/pnpm to use `http://localhost:8080/`.
2. The first install attempt for the problematic package does not install the package immediately.
3. ModuleWarden returns a safe pending/audit message and queues an audit.
4. Worker launches the audit flow using the configured DeepSeek OpenAI-compatible endpoint.
5. The admin dashboard shows the submitted audit run, job state, evidence/result, and blocked/quarantined outcome.
6. A second attempt to add the same dependency is denied by ModuleWarden with a clear block/quarantine message.

## Known Implementation Gaps To Watch

As of this runbook, `TASK-1.12` says the dashboard is not complete. The current web UI has stubbed queue behavior, so dashboard validation may fail until the admin visibility dashboard API/UI work is finished.

The audit container must not fall back to file-only inspection if PI, the RPC bridge, or model endpoint wiring is incomplete. Andreas explicitly required that fallback to be removed because it masks the missing agent conversation. The target behavior is a real model-backed audit using `DEEPSEEK_API_KEY`; otherwise the audit should fail clearly.

## Prerequisites

- Docker and Docker Compose are running.
- Node.js 20+ and pnpm 9+ are available.
- The shell has `DEEPSEEK_API_KEY` set.
- Commands are run from the ModuleWarden repo root, `main-modulewarden`, unless a step explicitly changes directories.
- The demo project will be created at `../demo-project` relative to the ModuleWarden repo root.
- Ports `8080`, `3000`, and `5422` are available.

Do not expose Verdaccio directly to the demo repo. Developers should talk only to ModuleWarden at `http://localhost:8080/`.

## 1. Configure The Model Endpoint

From the ModuleWarden repo root:

```bash
test -n "$DEEPSEEK_API_KEY" || {
  echo "DEEPSEEK_API_KEY is not set"
  exit 1
}

export MW_MODEL_ENDPOINT_BASE_URL="https://api.deepseek.com/v1"
export MW_MODEL_ENDPOINT_API_KEY="$DEEPSEEK_API_KEY"
export MW_MODEL_ENDPOINT_MODEL="deepseek-v4-flash"
export MW_AUTH_ADMIN_TOKENS="mw-admin-token-change-me"
export MW_AUTH_DEV_TOKENS="mw-dev-token-change-me"
```

If the intended model slug is different, change `MW_MODEL_ENDPOINT_MODEL` before starting Compose. Preserve the value used in the notes for this test drive.

By default the worker can process four lightweight `package-review` jobs in parallel, but only two expensive `audit-container-exec` jobs at once. In practice, that means at most two package audit containers/model runs execute concurrently per worker container. To change this for a local run, export overrides before starting Compose:

```bash
export MW_JOB_CONCURRENCY_PACKAGE_REVIEW=4
export MW_JOB_CONCURRENCY_AUDIT_CONTAINER_EXEC=2
```

For a faster local machine or a stronger model endpoint, increase `MW_JOB_CONCURRENCY_AUDIT_CONTAINER_EXEC`; for a quieter demo, lower it to `1`.

If an audit run shows PI/model errors such as `401 Authentication Fails` or a placeholder model/key like `x`, re-export the model endpoint settings in the shell that runs Compose and restart the services that pass those values into audit containers:

```bash
export MW_MODEL_ENDPOINT_BASE_URL="https://api.deepseek.com/v1"
export MW_MODEL_ENDPOINT_API_KEY="$DEEPSEEK_API_KEY"
export MW_MODEL_ENDPOINT_MODEL="deepseek-v4-flash"

docker compose up -d --build api-proxy worker web-ui
```

## 2. Start ModuleWarden

Build the audit-runner image first, then start the stack.

```bash
docker compose build audit-runner
docker compose up -d --build postgres verdaccio searxng api-proxy worker web-ui
```

Validate services:

```bash
curl -fsS http://localhost:8080/health | jq .
docker compose ps
docker compose logs --tail=100 api-proxy
docker compose logs --tail=100 worker
```

Expected:

- API health returns JSON.
- `postgres`, `verdaccio`, `searxng`, `api-proxy`, `worker`, and `web-ui` are running.
- Worker logs do not show database connection or Docker socket failures.

The `searxng` service is internal-only. Audit containers do not call it directly; they call ModuleWarden's `web-search` RPC tool, and `api-proxy` brokers the request to SearXNG plus npm/OSV advisory sources.

## 3. Create A Fresh Demo Repo

Use a sibling directory outside the ModuleWarden repo.

```bash
DEMO_DIR="../demo-project"
rm -rf "$DEMO_DIR"
mkdir -p "$DEMO_DIR"
cd "$DEMO_DIR"

# Do not use `pnpm init` here. Some pnpm versions create a
# devEngines.packageManager block with a non-exact version such as "^11.0.8",
# which later pnpm commands reject. Keep this throwaway package.json minimal.
cat > package.json <<'EOF'
{
  "name": "modulewarden-demo-project",
  "version": "1.0.0",
  "type": "module"
}
EOF

# Keep the registry override scoped to this demo project only.
# Do not use `pnpm config set` or `npm config set` here; those can mutate
# user/global config. Package managers read this local .npmrc from DEMO_DIR.
cat > .npmrc <<'EOF'
registry=http://localhost:8080/
EOF

cat > index.js <<'EOF'
console.log("ModuleWarden demo app");
EOF
```

Validate registry config:

```bash
pnpm config get registry
npm config get registry
```

Expected:

- Both commands print `http://localhost:8080/`.
- The registry override is local to `../demo-project/.npmrc`.

## 4. First Install Attempt Should Queue Audit And Not Install

Try to add the problematic dependency through ModuleWarden.

```bash
cd "$DEMO_DIR"
pnpm add cors-anywhere@0.4.4
```

Expected:

- The install does not succeed immediately.
- The package is not present in `node_modules`.
- The terminal shows a safe ModuleWarden message indicating the package/version is pending, unreviewed, quarantined, or awaiting audit.

Validate local package state:

```bash
test ! -d node_modules/cors-anywhere && echo "not installed as expected"
```

Validate ModuleWarden status:

```bash
cd ../main-modulewarden

MW_API_BASE=http://localhost:8080 \
MW_AUTH_DEV_TOKENS=mw-dev-token-change-me \
pnpm --filter @modulewarden/cli exec modulewarden status cors-anywhere
```

Also inspect the API directly:

```bash
curl -fsS http://localhost:8080/status/cors-anywhere | jq .
```

Expected:

- `cors-anywhere@0.4.4` appears as known, pending, unreviewed, queued, blocked, or quarantined.
- If it does not appear, inspect API and worker logs before continuing.

## 5. Validate Audit Job Was Queued

Check worker/API logs first:

```bash
cd ../main-modulewarden

docker compose logs --tail=200 api-proxy | grep -Ei "cors-anywhere|review|queue|audit|tarball" || true
docker compose logs --tail=300 worker | grep -Ei "cors-anywhere|package-review|audit-container|deepseek|model|verdict|quarantine|block" || true
```

Check Postgres for review jobs and audit runs:

```bash
docker compose exec -T postgres psql -U modulewarden -d modulewarden <<'SQL'
select
  r.id,
  pv."packageName",
  pv.version,
  r.trigger,
  r.status,
  r."auditContext",
  r."pgBossJobId",
  r."createdAt",
  r."updatedAt"
from "ReviewJob" r
join "PackageVersion" pv on pv.id = r."packageVersionId"
where pv."packageName" = 'cors-anywhere'
order by r."createdAt" desc;

select
  ar.id,
  pv."packageName",
  pv.version,
  ar.status,
  ar."containerId",
  ar."startedAt",
  ar."completedAt",
  ar."errorMessage"
from "AuditRun" ar
join "ReviewJob" r on r.id = ar."reviewJobId"
join "PackageVersion" pv on pv.id = r."packageVersionId"
where pv."packageName" = 'cors-anywhere'
order by ar."createdAt" desc;
SQL
```

Expected:

- At least one `ReviewJob` exists for `cors-anywhere@0.4.4`.
- A job moves from `PENDING`/`QUEUED` to `RUNNING` and then `COMPLETED`, `FAILED`, `CRASHED`, `TIMED_OUT`, `BLOCKED`, or `QUARANTINED` depending on implementation state.
- If no job exists, the tarball request path did not enqueue a review and that is a blocking gap for this scenario.

## 6. Validate DeepSeek/LLM Audit Path

Inspect worker and audit-runner logs:

```bash
cd ../main-modulewarden

docker compose logs --tail=500 worker | grep -Ei "deepseek|MW_MODEL_ENDPOINT|model endpoint|PI|orchestrator|verdict|RPC bridge|required|Fatal" || true
```

Expected target behavior:

- Logs show the configured model endpoint/model being used.
- PI/model-backed audit produces a structured verdict.

Failure gap to record:

- Logs show `PI not available`, `RPC bridge ... required`, `MW_MODEL_ENDPOINT_BASE_URL ... required`, or another fatal agentic-audit prerequisite failure. Record this as an audit harness/model wiring gap.

## 7. Validate Dashboard Visibility

Open the dashboard:

```bash
open http://localhost:3000
```

Manual checks:

- The dashboard should show the submitted `cors-anywhere@0.4.4` audit run.
- The audit should be visible in a queue/kanban state such as queued, running, quarantined, blocked, failed, or completed.
- The detail view should show the package/version, trigger source, job state, evidence/result, and final verdict.

Known current expected gap:

- The current `QueuePage` may show `No queue data available` because dashboard endpoints are not implemented yet. If so, record that `TASK-1.12` remains incomplete.

Fallback validation through API/DB:

```bash
curl -fsS http://localhost:8080/status | jq .

docker compose exec -T postgres psql -U modulewarden -d modulewarden <<'SQL'
select
  pv."packageName",
  pv.version,
  d.verdict,
  d."reasonSummary",
  d."actorType",
  d."createdAt"
from "Decision" d
join "PackageVersion" pv on pv.id = d."packageVersionId"
where pv."packageName" = 'cors-anywhere'
order by d."createdAt" desc;

select
  ea."artifactType",
  ea.name,
  ea."contentHash",
  ea."createdAt"
from "EvidenceArtifact" ea
join "AuditRun" ar on ar.id = ea."auditRunId"
join "ReviewJob" r on r.id = ar."reviewJobId"
join "PackageVersion" pv on pv.id = r."packageVersionId"
where pv."packageName" = 'cors-anywhere'
order by ea."createdAt" desc;
SQL
```

## 8. If Needed, Force A Block Verdict For The Demo

Use this only if the audit path does not yet produce a blocking/quarantine verdict but you still need to validate install denial.

```bash
cd ../main-modulewarden

MW_API_BASE=http://localhost:8080 \
MW_AUTH_ADMIN_TOKENS=mw-admin-token-change-me \
pnpm --filter @modulewarden/cli exec modulewarden admin override \
  cors-anywhere 0.4.4 BLOCK \
  "Manual demo policy block: permissive CORS proxy dependency is not allowed in this project."
```

Validate:

```bash
curl -fsS http://localhost:8080/status/cors-anywhere/0.4.4 | jq .
```

Expected:

- Effective status/verdict is `BLOCK` or equivalent denied state.

## 9. Retry Dependency Add And Confirm Block

Return to the demo repo and retry:

```bash
cd "$DEMO_DIR"
rm -rf node_modules pnpm-lock.yaml

pnpm add cors-anywhere@0.4.4
```

Expected:

- Install fails.
- Error explains that `cors-anywhere@0.4.4` is blocked or quarantined.
- Error includes safe next action such as `modulewarden status` or a status URL.
- `node_modules/cors-anywhere` is absent.

Validate:

```bash
test ! -d node_modules/cors-anywhere && echo "blocked as expected"

cd ../main-modulewarden
MW_API_BASE=http://localhost:8080 \
MW_AUTH_DEV_TOKENS=mw-dev-token-change-me \
pnpm --filter @modulewarden/cli exec modulewarden explain cors-anywhere@0.4.4
```

## 10. Capture Results

Create a notes file for the run:

```bash
RUN_ID="$(date -u +%Y%m%dT%H%M%SZ)"
RESULTS_DIR="../e2e-results-$RUN_ID"
mkdir -p "$RESULTS_DIR"

cd ../main-modulewarden

curl -sS http://localhost:8080/health > "$RESULTS_DIR/health.json" || true
curl -sS http://localhost:8080/status > "$RESULTS_DIR/status.json" || true
curl -sS http://localhost:8080/status/cors-anywhere > "$RESULTS_DIR/cors-anywhere-status.json" || true

docker compose ps > "$RESULTS_DIR/compose-ps.txt"
docker compose logs --tail=500 api-proxy > "$RESULTS_DIR/api-proxy.log"
docker compose logs --tail=800 worker > "$RESULTS_DIR/worker.log"

docker compose exec -T postgres psql -U modulewarden -d modulewarden <<'SQL' > "$RESULTS_DIR/db-snapshot.txt"
select pv."packageName", pv.version, pv."tarballHash", pv."createdAt"
from "PackageVersion" pv
where pv."packageName" = 'cors-anywhere'
order by pv."createdAt" desc;

select r.id, pv."packageName", pv.version, r.trigger, r.status, r."auditContext", r."pgBossJobId", r."createdAt", r."updatedAt"
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

echo "Saved results to $RESULTS_DIR"
```

## Pass/Fail Checklist

- [ ] ModuleWarden stack starts locally with Verdaccio internal-only.
- [ ] Demo repo has local `.npmrc` registry pointing to `http://localhost:8080/`.
- [ ] First `pnpm add cors-anywhere@0.4.4` does not install immediately.
- [ ] First install creates a known package version in ModuleWarden.
- [ ] First install queues a review job.
- [ ] Worker launches or attempts an audit-container run.
- [ ] DeepSeek endpoint/model configuration is visible in the audit path, or fallback is clearly recorded as a gap.
- [ ] Dashboard shows the audit run/job/result, or the missing dashboard wiring is recorded against `TASK-1.12`.
- [ ] Final verdict is `BLOCK` or `QUARANTINE`, either from audit or manual demo override.
- [ ] Second `pnpm add cors-anywhere@0.4.4` is denied by ModuleWarden.
- [ ] Developer-facing failure does not leak prompts, secrets, model credentials, DB details, or raw sensitive logs.

## Cleanup

```bash
rm -rf ../demo-project

cd ../main-modulewarden
docker compose down
```

Use `docker compose down -v` only when you intentionally want to delete Postgres and Verdaccio state from this test drive.
