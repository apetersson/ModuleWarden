---
id: TASK-30.3
title: 'Fix escalation heuristic and implement second-pass model review'
status: To Do
labels:
  - logic
  - medium
---

## Finding
L-5 (MEDIUM): Escalation heuristic uses `riskSummary.length > 50` which matches nearly all BLOCK verdicts. Escalation only creates a label — no second-pass model audit is enqueued.

**Fix:** Replace string-length heuristic with structured risk signals. Enqueue actual `model-escalation` job when triggered.

**Files:** `packages/api-proxy/src/services/escalation.ts`, `packages/worker/src/handlers/model-escalation.ts`
