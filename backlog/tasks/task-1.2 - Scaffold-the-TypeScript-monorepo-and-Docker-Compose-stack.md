---
id: TASK-1.2
title: Scaffold the TypeScript monorepo and Docker Compose stack
status: In Progress
assignee:
  - '@agent-k'
created_date: '2026-05-27 17:18'
updated_date: '2026-05-27 18:45'
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

## Definition of Done
<!-- DOD:BEGIN -->
- [x] #1 No product behavior is hidden inside Compose magic; all ports, tokens, and service roles are documented.
<!-- DOD:END -->
