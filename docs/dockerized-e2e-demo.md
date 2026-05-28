# Dockerized E2E Demo: Problematic Dependency In `E2EValidationScenario`

## Goal

Validate the problematic-dependency operator story inside an isolated Docker Compose project named `e2e-validation-scenario`, while keeping fast iteration on ModuleWarden service source code.

The scenario mounts ModuleWarden service sources into containers for quick edits:

- `packages/api-proxy`
- `packages/worker`
- `packages/web-ui`
- `packages/shared`
- `packages/prisma-client`

The intentionally bad demo repository is not created on the host filesystem. It lives entirely in the Docker named volume `e2e-validation-scenario_e2e-demo-project`.

## Scenario

The demo project attempts to install:

- Package: `cors-anywhere`
- Version: `0.4.4`
- Risk story: permissive CORS proxy behavior is unsafe when accidentally introduced into an application dependency graph.

The scenario starts ModuleWarden with Postgres, Verdaccio, API proxy, worker, web UI, and the audit-runner image. It then creates a fresh demo project inside Docker, points npm/pnpm at ModuleWarden, attempts to install the package, drives review/audit validation, forces a deterministic block verdict, and retries the install.

## Expected Product Behavior

Target behavior:

1. The Dockerized demo project configures npm/pnpm to use ModuleWarden at `http://api-proxy:8080/`.
2. The first `pnpm add cors-anywhere@0.4.4` does not install the package.
3. ModuleWarden queues a review for `cors-anywhere@0.4.4`.
4. Worker runs an audit container for the package.
5. The dashboard/API/DB show package version, review job, audit run, evidence, and final decision state.
6. A block verdict makes the tarball route return HTTP `403`.
7. The second `pnpm add cors-anywhere@0.4.4` does not install the package.

Current known behavior:

- The first `pnpm add` may fail with `ERR_PNPM_NO_VERSIONS` before npm reaches the tarball route because ModuleWarden currently filters unapproved versions out of the packument.
- When that happens, the scenario records the gap and directly calls the tarball URL to validate the review/audit path:

```bash
curl http://localhost:8080/cors-anywhere/-/cors-anywhere-0.4.4.tgz
```

This direct call is expected to return HTTP `404` with a safe `Version not yet reviewed` response and enqueue a review job.

## Files

Scenario entrypoint:

```bash
scripts/e2e-validation-scenario.sh
```

Compose overlay:

```bash
docker-compose.e2e-validation.yml
```

The script combines the base Compose file and the overlay:

```bash
docker compose \
  -p e2e-validation-scenario \
  -f docker-compose.yml \
  -f docker-compose.e2e-validation.yml
```

## Prerequisites

- Docker and Docker Compose are running.
- Node.js and pnpm are available on the host.
- The command is run from the ModuleWarden repo root:

```bash
cd /Users/andreas/code/ModuleWarden/main-ModuleWarden
```

Optional for model-backed audit attempts:

```bash
export DEEPSEEK_API_KEY="..."
```

If `DEEPSEEK_API_KEY` is not set, the script uses `sk-change-me`. The audit runner is intentionally not allowed to fabricate a file-only audit verdict. If the PI/RPC bridge/model path is unavailable, the audit container must fail loudly and the preserved session/logs should show the missing prerequisite.

## Default Ports And Paths

Host-facing defaults:

- API: `http://localhost:8080`
- Web UI: `http://localhost:13000`
- Compose project: `e2e-validation-scenario`

Internal container URLs:

- Demo npm registry: `http://api-proxy:8080/`
- Internal Verdaccio: `http://verdaccio:4873`
- Internal Postgres: `postgres:5432`

Host paths created by the script:

```bash
.e2e/audit-workspaces
.e2e/audit-sessions
.e2e/results
```

`.e2e/` is intentionally ignored by git.

## Why The Audit Workspace Is Host-Mounted

The worker container mounts `/var/run/docker.sock` and asks the host Docker daemon to create disposable audit containers. Any directory bind-mounted into those disposable audit containers must exist at a path visible to the host Docker daemon.

For that reason the script sets:

```bash
MW_E2E_AUDIT_WORKSPACE_HOST="$PWD/.e2e/audit-workspaces"
MW_AUDIT_WORKSPACE_ROOT="$MW_E2E_AUDIT_WORKSPACE_HOST"
```

The overlay mounts that host path into the worker at the same absolute path, so the worker and host Docker daemon agree on audit workspace locations.

## Preserved Audit Sessions

The worker normally cleans up per-run audit workspaces after copying declared evidence into the database. The Dockerized scenario preserves a full post-run copy on a host-mounted archive volume:

```bash
.e2e/audit-sessions
```

The script enables this by default:

```bash
MW_PRESERVE_AUDIT_SESSIONS=true
MW_E2E_AUDIT_SESSION_ARCHIVE_HOST="$PWD/.e2e/audit-sessions"
MW_AUDIT_SESSION_ARCHIVE_ROOT="$MW_E2E_AUDIT_SESSION_ARCHIVE_HOST"
```

The Compose overlay mounts `MW_E2E_AUDIT_SESSION_ARCHIVE_HOST` into the worker at the same absolute path. After each audit run, the worker copies the completed workspace there before deleting the temporary workspace from `.e2e/audit-workspaces`.

Archive directory names are based on audit run identity and package:

```text
.e2e/audit-sessions/<auditRunId>-<package>-<version>/
```

The archived `run-config.json` has the short-lived runtime RPC token redacted after the run. The rest of the workspace is preserved for inspection, including package inputs, output files, evidence files, and PI session logs when the PI path runs.

## Environment Overrides

The script has safe defaults, but these variables can be overridden:

```bash
export RUN_ID="manual-run-001"
export MW_E2E_PROJECT_NAME="e2e-validation-scenario"
export MW_E2E_API_PORT="8080"
export MW_E2E_WEB_UI_PORT="13000"
export MW_E2E_HOST_API_BASE_URL="http://localhost:${MW_E2E_API_PORT}"
export MW_E2E_HOST_WEB_URL="http://localhost:${MW_E2E_WEB_UI_PORT}"
export MW_E2E_BROWSER_API_BASE_URL="$MW_E2E_HOST_API_BASE_URL"
export MW_E2E_AUDIT_WORKSPACE_HOST="$PWD/.e2e/audit-workspaces"
export MW_E2E_AUDIT_SESSION_ARCHIVE_HOST="$PWD/.e2e/audit-sessions"
export MW_E2E_RESULTS_HOST="$PWD/.e2e/results"
export MW_MODEL_ENDPOINT_BASE_URL="https://api.deepseek.com/v1"
export MW_MODEL_ENDPOINT_API_KEY="$DEEPSEEK_API_KEY"
export MW_MODEL_ENDPOINT_MODEL="deepseek-flash-4"
export MW_PRESERVE_AUDIT_SESSIONS="true"
export MW_AUTH_ADMIN_TOKENS="mw-admin-token-change-me"
export MW_AUTH_DEV_TOKENS="mw-dev-token-change-me"
```

If `8080` is already in use, run with a different API port:

```bash
MW_E2E_API_PORT=18080 \
MW_E2E_HOST_API_BASE_URL=http://localhost:18080 \
MW_E2E_BROWSER_API_BASE_URL=http://localhost:18080 \
scripts/e2e-validation-scenario.sh run
```

If `13000` is already in use, run with a different web UI port:

```bash
MW_E2E_WEB_UI_PORT=13001 \
MW_E2E_HOST_WEB_URL=http://localhost:13001 \
scripts/e2e-validation-scenario.sh run
```

## Run The Scenario

From the repo root:

```bash
scripts/e2e-validation-scenario.sh run
```

The script performs these steps:

1. Creates `.e2e/audit-workspaces`, `.e2e/audit-sessions`, and `.e2e/results/<RUN_ID>`.
2. Builds `@modulewarden/audit-runner` locally so the audit-runner Docker image can copy `dist/orchestrator.js`.
3. Builds Docker images for `audit-runner`, `api-proxy`, `worker`, `web-ui`, and `migrate`.
4. Starts the Compose project `e2e-validation-scenario`.
5. Runs Prisma migrations through the one-shot `migrate` service.
6. Starts API, worker, Verdaccio, Postgres, and web UI.
7. Waits for `GET /health` on the API.
8. Seeds an enabled ready project named `E2EValidationScenario` in Postgres.
9. Creates a fresh demo project inside the `e2e-demo-project` Docker volume.
10. Configures npm and pnpm inside the demo container to use `http://api-proxy:8080/`.
11. Runs the first `pnpm add cors-anywhere@0.4.4`.
12. If no review job appears, calls the tarball route directly to continue review/audit validation.
13. Waits for an audit run to leave `PENDING`/`RUNNING`.
14. Creates a deterministic admin `BLOCK` override.
15. Runs the second `pnpm add cors-anywhere@0.4.4`.
16. Calls the tarball route again and expects HTTP `403`.
17. Captures API responses, DB snapshots, service logs, and a summary file.

## Expected Successful Summary

At the end, the script prints a summary similar to:

```text
E2EValidationScenario run: 20260528T192022Z
Project: e2e-validation-scenario
API: http://localhost:8080
Web UI: http://localhost:13000
Results: /Users/andreas/code/ModuleWarden/main-ModuleWarden/.e2e/results/20260528T192022Z
Audit sessions: /Users/andreas/code/ModuleWarden/main-ModuleWarden/.e2e/audit-sessions

First pnpm install state: not-installed
Second pnpm install state: not-installed
Blocked tarball HTTP code: 403
```

The script exits non-zero if either install leaves `node_modules/cors-anywhere` present or if the blocked tarball route does not return HTTP `403`.

## Inspect Running Services

The script leaves the stack running after a successful run.

```bash
MW_E2E_AUDIT_WORKSPACE_HOST="$PWD/.e2e/audit-workspaces" \
MW_E2E_RESULTS_HOST="$PWD/.e2e/results" \
docker compose \
  -p e2e-validation-scenario \
  -f docker-compose.yml \
  -f docker-compose.e2e-validation.yml \
  ps
```

Expected services:

- `postgres`
- `verdaccio`
- `api-proxy`
- `worker`
- `web-ui`

Validate API and UI:

```bash
curl -fsS http://localhost:8080/health | jq .
open http://localhost:13000
```

## Inspect Results

Find the latest run directory:

```bash
ls -td .e2e/results/* | head -1
```

Important files:

```text
summary.txt
health.json
health-final.json
status.json
cors-anywhere-status.json
cors-anywhere-0.4.4-status.json
first-pnpm-add.log
first-pnpm-add.exitcode
first-install-state.txt
direct-tarball-first.json
direct-tarball-first.httpcode
latest-audit-status.txt
admin-override-block.json
admin-override-block.httpcode
second-pnpm-add.log
second-pnpm-add.exitcode
second-install-state.txt
direct-tarball-after-block.json
direct-tarball-after-block.httpcode
compose-ps.txt
api-proxy.log
worker.log
web-ui.log
db-snapshot.txt
audit-sessions.txt
```

Expected current first install log:

```text
ERR_PNPM_NO_VERSIONS No versions available for cors-anywhere.
```

This is the known packument-filtering gap.

Expected direct tarball first response:

```json
{
  "error": "Version not yet reviewed",
  "reason": "cors-anywhere@0.4.4 has not been reviewed yet. A review has been enqueued.",
  "package": "cors-anywhere",
  "requestedVersion": "0.4.4",
  "cliCommand": "modulewarden status"
}
```

Expected direct tarball first HTTP code:

```text
404
```

Expected direct tarball after block response:

```json
{
  "error": "Version blocked",
  "reason": "Package cors-anywhere@0.4.4 is blocked by security policy",
  "package": "cors-anywhere",
  "requestedVersion": "0.4.4",
  "cliCommand": "modulewarden status"
}
```

Expected direct tarball after block HTTP code:

```text
403
```

## Inspect Database State

The captured DB snapshot should show:

- One `PackageVersion` for `cors-anywhere@0.4.4`.
- One `PREFLIGHT` review job for `preflight:tarball:cors-anywhere@0.4.4`.
- One completed `AuditRun`.
- One admin `BLOCK` decision.

The same queries can be run against the live stack:

```bash
MW_E2E_AUDIT_WORKSPACE_HOST="$PWD/.e2e/audit-workspaces" \
MW_E2E_RESULTS_HOST="$PWD/.e2e/results" \
docker compose \
  -p e2e-validation-scenario \
  -f docker-compose.yml \
  -f docker-compose.e2e-validation.yml \
  exec -T postgres psql -U modulewarden -d modulewarden <<'SQL'
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
```

## Inspect Evidence Artifacts

The audit run must not use file-only inspection. A missing RPC bridge, PI binary, or model endpoint is an audit harness failure, not a successful quarantine verdict.

Inspect evidence:

```bash
MW_E2E_AUDIT_WORKSPACE_HOST="$PWD/.e2e/audit-workspaces" \
MW_E2E_RESULTS_HOST="$PWD/.e2e/results" \
docker compose \
  -p e2e-validation-scenario \
  -f docker-compose.yml \
  -f docker-compose.e2e-validation.yml \
  exec -T postgres psql -U modulewarden -d modulewarden <<'SQL'
select ea.name, ea."artifactType", left(ea.content::text, 300) as content_preview
from "EvidenceArtifact" ea
join "AuditRun" ar on ar.id = ea."auditRunId"
join "ReviewJob" r on r.id = ar."reviewJobId"
join "PackageVersion" pv on pv.id = r."packageVersionId"
where pv."packageName" = 'cors-anywhere'
order by ea."createdAt";
SQL
```

Expected evidence names may include:

- `verdict.json`
- `initial-prompt.md`
- `container.log`
- `env.txt`
- `files.txt`
- `system.txt`
- `output-manifest.txt`
- `session-archive`

`initial-prompt.md` is present when the agentic path starts and records the exact initial prompt sent to PI. If `verdict.json` contains `File-only inspection` or `Minimal inspection`, the audit runner has regressed.

## Inspect Preserved Session Directories

List archived sessions:

```bash
find .e2e/audit-sessions -maxdepth 2 -print
```

Inspect the latest archived session:

```bash
SESSION_DIR="$(find .e2e/audit-sessions -mindepth 1 -maxdepth 1 -type d | sort | tail -1)"
find "$SESSION_DIR" -maxdepth 3 -type f -print
```

Important files/directories:

```text
run-config.json
inputs/package.tgz
inputs/package/
output/
output/container.log
output/initial-prompt.md
output/verdict.json
output/inspection/
output/pi-session.log
output/pi-session-error.log
evidence/
```

`pi-session.log` and `pi-session-error.log` are present only when the PI/model-backed path runs far enough to create them. Missing agentic prerequisites should now leave a failed audit run plus preserved logs/session state, not a file-only verdict.

## Cleanup

Stop and delete the E2E stack, volumes, and demo project:

```bash
scripts/e2e-validation-scenario.sh down
```

Remove captured local artifacts if desired:

```bash
rm -rf .e2e
```

## Pass/Fail Checklist

- [ ] Compose project `e2e-validation-scenario` builds.
- [ ] Postgres starts without publishing host port `5422`.
- [ ] Verdaccio remains internal-only.
- [ ] API is healthy at the configured host API URL.
- [ ] Web UI is reachable at the configured host web URL.
- [ ] Demo project is created inside Docker volume `e2e-validation-scenario_e2e-demo-project`.
- [ ] Demo npm/pnpm registry is `http://api-proxy:8080/`.
- [ ] First `pnpm add cors-anywhere@0.4.4` does not install the package.
- [ ] If first `pnpm add` does not enqueue a review, `direct-tarball-first.httpcode` records `404` and `direct-tarball-first.json` records safe review-enqueued messaging.
- [ ] `PackageVersion` exists for `cors-anywhere@0.4.4`.
- [ ] `ReviewJob` exists for `preflight:tarball:cors-anywhere@0.4.4`.
- [ ] `AuditRun` reaches a terminal state, preferably `COMPLETED`.
- [ ] Evidence artifacts are captured.
- [ ] Full audit session directory is preserved under `.e2e/audit-sessions`.
- [ ] Preserved `run-config.json` redacts the runtime RPC token.
- [ ] No `File-only inspection` or `Minimal inspection` verdict is emitted.
- [ ] Admin override creates an effective `BLOCK` decision.
- [ ] Direct tarball request after block returns HTTP `403`.
- [ ] Second `pnpm add cors-anywhere@0.4.4` does not install the package.
- [ ] Results are captured under `.e2e/results/<RUN_ID>`.
- [ ] Any missing PI/RPC/model prerequisite is recorded as a failed audit harness gap.
- [ ] The packument-filtering install gap is recorded when `first-pnpm-add.log` shows `ERR_PNPM_NO_VERSIONS`.

## Known Gaps To Track

1. Package-manager first-install UX:
   `pnpm add cors-anywhere@0.4.4` currently may fail on filtered packument metadata before reaching the tarball route. The desired UX is a ModuleWarden pending/audit message that queues review directly from the package-manager flow.

2. Model-backed audit:
   The audit container must not complete with file-only inspection if PI, the RPC bridge, or model endpoint wiring is unavailable. Andreas explicitly required this fallback to be removed; the target behavior is a structured model-backed verdict using the configured OpenAI-compatible endpoint, otherwise a clear failed audit.

3. Deterministic block:
   The scenario currently uses an admin override to force `BLOCK` after audit completion. That keeps retry validation deterministic while the audit verdict pipeline is still maturing.
