---
id: TASK-29
title: Remove all fallback paths — replace with fail-early validation
status: Done
assignee:
  - '@agent'
created_date: '2026-05-28'
updated_date: '2026-05-28T22:15:00Z'
labels:
  - quality
  - reliability
  - startup-validation
  - hardening
dependencies: []
supersedes:
  - TASK-28
priority: high
ordinal: 45000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->

Fallbacks are "silent killers." They mask misconfiguration, missing dependencies, and broken setups at runtime, making failures harder to debug and giving the operator a false sense that the system is working correctly.

The principle: **a fallback should not exist.** Either something is correctly configured or it is validated early (at startup / build time / container entry) to **fail fast** with a clear error message.

ModuleWarden currently has **10 distinct fallback mechanisms** across the stack.

> ⚠️ This task supersedes **TASK-28** which previously tackled only the file-only audit fallback in `entrypoint.sh`. That scope is folded into item **#5** below.
<!-- SECTION:DESCRIPTION:END -->

## Fallback Inventory

### 1. Model Endpoint Fallback — `packages/shared/src/config.ts`

**What happens today:** The model endpoint config has `fallbackBaseUrl`, `fallbackApiKey`, and `fallbackModelName` fields, each defaulting to a secondary model (`llama-3-8b`). When primary env vars are unset, the system silently uses a different model without warning.

**Required fix:** Remove the three fallback fields from the `modelEndpoint` config type and defaults. The env vars `MW_MODEL_ENDPOINT_BASE_URL`, `MW_MODEL_ENDPOINT_API_KEY`, and `MW_MODEL_ENDPOINT_MODEL` become required — the system must validate their presence at startup and crash with a clear message if any are missing.

**Files:** `packages/shared/src/config.ts`

---

### 2. DB-Level `isFallback` Flag — `packages/prisma-client/prisma/schema.prisma`

**What happens today:** The `ModelProfile` model has an `isFallback Boolean @default(false)` column that semantically demotes certain profiles to "second class."

**Required fix:** Remove the `isFallback` column from the schema (and the migration). Every model profile is a first-class profile. If a profile is missing or misconfigured, the system should fail when it tries to select it — not silently pick whatever is tagged as the fallback.

**Files:** `packages/prisma-client/prisma/schema.prisma`, associated migration file, `packages/prisma-client/src/repositories/model-profiles.ts`

---

### 3. Active Profile Fallback — `packages/prisma-client/src/repositories/model-profiles.ts`

**What happens today:** `getActiveModelProfile()` first looks for a non-fallback profile; if none exists, it silently returns the most recent fallback profile. This means a completely unconfigured system can still "work" with whatever model happened to be seeded as fallback.

**Required fix:** `getActiveModelProfile()` must throw or return null if no primary (non-fallback) profile exists. The caller must handle the absence explicitly. A startup health-check should verify at least one primary profile is seeded.

**Files:** `packages/prisma-client/src/repositories/model-profiles.ts`

---

### 4. `isFallback` in Audit Instructions — `packages/worker/src/services/prompt-pack.ts`

**What happens today:** The `AuditInstructions` interface carries `isFallback: boolean` in `modelProfile`, propagating the degraded status into the container so the orchestrator "knows it's degraded."

**Required fix:** Remove the `isFallback` field from `AuditInstructions` and its population in `assembleAuditInstructions()`. If the model profile is not resolved, the audit should not be dispatched at all — the worker must fail the review job early.

**Files:** `packages/worker/src/services/prompt-pack.ts`

---

### 5. Container Entrypoint File-Only Inspection — `packages/audit-runner/entrypoint.sh`

**What happens today:** When the PI orchestrator binary (`/app/orchestrator/index.js`) is missing from the container image, the entrypoint silently dumps package.json, env, system info, and a file tree into the output directory instead of running a real audit, then exits with code 0.

**Required fix:** Crash the container at startup (non-zero exit) if the orchestrator binary is absent. This is a build-time invariant — the Dockerfile must include the binary. Remove the entire `else` branch that performs the fallback inspection.

**Files:** `packages/audit-runner/entrypoint.sh`

---

### 6. CLI `explain` → `status` Fallback — `packages/cli/src/index.ts`

**What happens today:** When `modulewarden explain <pkg>@<ver>` is called and the dedicated `/explain` endpoint returns non-200, the CLI silently falls back to the less-detailed `/status` endpoint and returns its output.

**Required fix:** Remove the fallback. If `/explain` fails, propagate the error. The user should know when the full explanation is unavailable rather than getting a degraded response without warning.

**Files:** `packages/cli/src/index.ts`

---

### 7. Web UI API Base URL Fallback — `packages/web-ui/index.html`

**What happens today:** `window.__MW_API_BASE__` falls back to empty string (same-origin) when the build-time env var `VITE_MW_API_BASE_URL` is not set.

**Required fix:** Fail at build time if `VITE_MW_API_BASE_URL` is not set. This is a build-time invariant that should never be optional.

**Files:** `packages/web-ui/index.html`

---

### 8. Chat Agent `fallback` Route — `chat/agent.py`

**What happens today:** `ChatTurn.route` has `"fallback"` as a route value, marking degraded answers that are neither fully deterministic nor LLM-augmented.

**Required fix:** Remove the `"fallback"` route value. The router must either produce a valid answer or return an explicit error state. The `ChatTurn.route` type/field should be narrowed to `"router" | "llm"`.

**Files:** `chat/agent.py`

---

### 9. PI Harness Unavailable Fallback — `finetune/python/eval/pi_harness_wrapper.py`

**What happens today:** The orchestrator wrapper degrades to `status='unavailable'` when Node or the orchestrator binary is not found, allowing the matrix runner to continue with non-agentic arms.

**Required fix:** Throw an error immediately at import or invocation time if the orchestrator is not found. Let the caller decide how to handle absence rather than silently degrading.

**Files:** `finetune/python/eval/pi_harness_wrapper.py`

---

### 10. Config Read Helpers — `packages/shared/src/config.ts`

**What happens today:** Every `readInt()`, `readList()`, `readConcurrency()` call silently falls back to hardcoded defaults when env vars are absent. There is no distinction between "optional with default" and "required."

**Required fix:** Introduce a clear distinction between optional and required config keys. Required keys must throw at startup if absent. Optional keys may still use defaults but should log a warning. Audit all config reads and classify each as required vs optional.

**Files:** `packages/shared/src/config.ts`

---

## Acceptance Criteria

<!-- AC:BEGIN -->
- [ ] #1 All 10 fallback paths listed above are removed.
- [ ] #2 Every component validates its required inputs at startup / build time / container entry / import time.
- [ ] #3 Error messages clearly state what is missing and how to fix it (e.g. "MW_MODEL_ENDPOINT_BASE_URL is not set. Set this environment variable to the OpenAI-compatible endpoint URL.")
- [ ] #4 The `isFallback` column is dropped from the Prisma schema and the migration is committed.
- [ ] #5 TASK-28 is marked superseded by this task; its acceptance criteria are subsumed into AC items above.
- [ ] #6 Existing tests that relied on fallback behavior are updated to expect early failures.
- [ ] #7 The manual e2e runbook (`docs/manual-e2e-demo-problematic-dependency.md`) is updated to remove any references to "acceptable fallback gaps" or "fallback as a known gap."
- [ ] #8 A startup health-check or preflight command is added (or extended) to verify required config, model profiles, and container invariants before the stack accepts traffic.
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. Start with config.ts (#1, #10) — refactor to distinguish required vs optional fields, add startup validation hook.
2. Remove `isFallback` column from schema, update model-profiles.ts (#2, #3).
3. Remove `isFallback` from audit instructions (#4).
4. Fix entrypoint.sh (#5) — crash on missing orchestrator.
5. Fix CLI (#6) — remove fallback to /status.
6. Fix web UI (#7) — enforce VITE_MW_API_BASE_URL at build time.
7. Fix chat/agent.py (#8) — remove "fallback" route value.
8. Fix pi_harness_wrapper.py (#9) — throw on missing orchestrator.
9. Update all tests.
10. Update runbook documentation.
11. Mark TASK-28 as superseded.
<!-- SECTION:PLAN:END -->
