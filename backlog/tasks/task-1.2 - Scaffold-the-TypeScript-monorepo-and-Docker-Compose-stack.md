---
id: TASK-1.2
title: Scaffold the TypeScript monorepo and Docker Compose stack
status: Done
assignee:
  - '@agent-k'
created_date: '2026-05-27 17:18'
updated_date: '2026-05-27 18:46'
labels:
  - infra
  - typescript
  - docker
  - prisma
  - pg-boss
  - v1
dependencies:
  - TASK-1.1
parent_task_id: TASK-1
priority: high
ordinal: 3000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Create the greenfield implementation skeleton for ModuleWarden.

The chosen stack is TypeScript/Node because npm protocol handling, Verdaccio integration, PI orchestration, and a bundled CLI are all naturally Node-shaped. The first deploy target is Docker Compose, not Kubernetes, so the system is runnable locally and suitable for self-hosted evaluation without pretending to be enterprise-ready.

The Compose stack should include ModuleWarden API/proxy, worker, web UI, Postgres, Verdaccio, and a build target for the custom audit-runner image. The local model endpoint is configured as an external OpenAI-compatible service rather than bundled. Static tokens are acceptable for v1 auth. Postgres backs both Prisma application data and pg-boss job/event state; no Redis service should be scaffolded.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 A fresh checkout can install dependencies with pnpm and start the local stack with Docker Compose.
- [x] #2 Verdaccio is only reachable as an internal backing service in the Compose topology; the intended developer entrypoint is ModuleWarden.
- [x] #3 The audit-runner image can be built separately and referenced by worker jobs.
- [x] #4 Development scripts exist for lint, test, typecheck, and running the API/worker/UI locally.
- [x] #5 The workspace includes Prisma schema/migration/client generation scripts and pg-boss dependencies/configuration, with no Redis dependency or Compose service.
- [x] #6 The scaffold is pnpm-first and includes a dogfood lockfile path for importing ModuleWarden workspace dependencies as the initial curated audit set.
- [x] #7 Configuration supports a pluggable OpenAI-compatible model endpoint, including an external H100-backed endpoint and a deterministic or lightweight fallback for development.
- [x] #8 Docker Compose can run the control plane, proxy, workers, UI, Postgres, Verdaccio, and local tool containers without requiring H100 credentials.
- [x] #9 The API/proxy and worker share typed configuration for Postgres, Verdaccio, token auth, PI/tool orchestration, pluggable OpenAI-compatible model endpoints, fallback reviewer behavior, and audit image name.
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. Initialize pnpm workspace with root package.json, pnpm-workspace.yaml\n2. Create workspace packages: api-proxy, worker, cli, web-ui, shared, prisma-client, audit-runner\n3. Add TypeScript config, lint/prettier config, dev scripts\n4. Create Docker Compose stack with Postgres, Verdaccio, API, worker, UI, audit-runner build\n5. Add shared typed configuration module\n6. Add dogfood lockfile placeholder\n7. Commit scaffold
<!-- SECTION:PLAN:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Scaffolded the complete ModuleWarden monorepo with Docker Compose stack. Created 7 workspace packages (api-proxy, worker, cli, web-ui, shared, prisma-client, audit-runner) with TypeScript configs, pnpm workspace configuration, shared typed config module, Docker Compose with Postgres/Verdaccio/API/worker/UI/audit-runner build, dev scripts, audit-runner Dockerfile with PI RPC entrypoint, Prisma schema placeholder, and dogfood lockfile. Verified: pnpm install, prisma generate, docker compose config all pass. No Redis services.
<!-- SECTION:FINAL_SUMMARY:END -->

## Test Spec

<!-- SECTION:TEST_SPEC:BEGIN -->
- [ ] #1 Scaffold smoke tests verify a fresh clone can run pnpm install and `pnpm -r build` with no manual local bootstrap.
- [ ] #2 Compose integration tests verify stack starts with Postgres, Verdaccio, API, worker, UI, and audit-runner build target.
- [ ] #3 Config tests verify `.env` and shared config expose typed Postgres, token, model-endpoint, and audit-runner controls.
- [ ] #4 Workspace tests verify pnpm workspace resolves `@modulewarden/*` packages and script fan-out works.
- [ ] #5 Network tests verify Redis is absent from compose and startup checks.
- [ ] #6 Script tests verify shared local workflow commands for lint/test/typecheck are executable.
- [ ] #7 Image tests verify audit-runner image exists as a separate Dockerfile target and worker references it.
<!-- SECTION:TEST_SPEC:END -->

## Definition of Done
<!-- DOD:BEGIN -->
- [x] #1 No product behavior is hidden inside Compose magic; all ports, tokens, and service roles are documented.
<!-- DOD:END -->
