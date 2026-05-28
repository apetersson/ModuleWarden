---
id: TASK-30.4
title: 'Add rate limiting to all API endpoints'
status: To Do
labels:
  - security
  - medium
---

## Finding
S-5 (MEDIUM): No rate limiting on any API endpoint — public, admin, and internal RPC endpoints all unbounded.

**Fix:** Add `@fastify/rate-limit` with tiered limits (public: 60/min, admin: 10/min, internal RPC: 5/sec).

**Files:** `packages/api-proxy/src/index.ts`
