---
id: TASK-30.2
title: 'Implement actual predecessor-diff computation'
status: To Do
labels:
  - logic
  - critical
---

## Finding
L-1 (CRITICAL): The `/internal/predecessor-diff` endpoint computes the correct predecessor version but always returns empty diffs. Every version-diff audit runs with zero predecessor context, producing systematically wrong verdicts.

**Fix:** Either implement actual diff computation (extract tarballs, compute file diffs, dependency changes, lifecycle script changes) or return `hasPredecessor: false` so PI applies cold-start conservative standards.

**Files:** `packages/api-proxy/src/routes/internal.ts`
