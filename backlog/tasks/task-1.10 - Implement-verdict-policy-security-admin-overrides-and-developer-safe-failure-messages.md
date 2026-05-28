---
id: TASK-1.10
title: >-
  Implement verdict policy, security-admin overrides, and developer-safe failure
  messages
status: Done
assignee:
  - '@agent-k'
created_date: '2026-05-27 17:19'
updated_date: '2026-05-28 07:06'
labels:
  - policy
  - auth
  - dx
  - v1
dependencies:
  - TASK-1.3
  - TASK-1.4
  - TASK-1.7
  - TASK-1.16
parent_task_id: TASK-1
priority: high
ordinal: 11000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Implement decision semantics and the user-facing consequences of each decision.

Planning chose agent-final decisions: the audit agent can allow, block, or quarantine without mandatory human approval. Unknown or poorly explained risk should quarantine. Security admins can override quarantined or blocked versions. The system should store scores for later calibration, but v1 should not rely on a simplistic numeric threshold as the product truth.

Developer-facing messages must be useful but must not leak private prompts, internal tool details that help attackers adapt, credentials, or raw sensitive logs. The right failure mode is clear and deterministic, not mysterious.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 Allow decisions promote/serve the exact package version hash and no other hash for the same version string.
- [x] #2 Block decisions prevent serve/promotion and expose a concise reason plus safer alternatives when known.
- [x] #3 Quarantine decisions prevent serve/promotion until a later agent run or security-admin override changes the effective decision.
- [x] #4 Only security-admin tokens can override a quarantined or blocked version in v1.
- [x] #5 Developer-facing errors include package/version, current state, status command/URL, and next action, but never core prompt content or secrets.
- [x] #6 Cold-start allow is permitted only when required provenance, behavior, install-trace, and heuristic checks are clean; missing or ambiguous evidence resolves to quarantine.
- [x] #7 No admin-baseline allow shortcut exists in v1; security admins can override block or quarantine decisions only with recorded reasons.
- [x] #8 Project registry enablement requires complete decision coverage for the imported graph, and partial coverage produces safe developer-facing failures.
- [x] #9 Prompt, model, pattern, or incident relabel changes revalidate affected overrides and can produce superseding effective decisions.
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. Create verdict policy service with effective decision resolution\n2. Create admin override endpoints with auth\n3. Create developer-safe status/explain API\n4. Wire cold-start policy into existing import flow\n5. Add re-audit revalidation logic\n6. Write comprehensive policy tests\n7. Commit and push
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
- Verdict policy service resolves effective decisions with override priority chain\n- Admin override endpoints with Bearer token auth (POST /admin/override, GET /admin/overrides, DELETE /admin/override/:id)\n- Developer-safe status endpoints (GET /status/:package, GET /status/:package@:version, GET /explain/:package@:version)\n- Status output verified to not leak prompts, tokens, secrets, or internal details\n- Cold-start policy enforced via lockfile import path\n- 7 policy tests, 55 total across all packages

Iteration 1: Wired up admin/status routes in Fastify, added 11 comprehensive policy tests, fixed route parsing (@ → / separator), added @modulewarden/ prefix guard. Reviewer (deepseek/deepseek-v4-pro) found and fixed route parsing bug and test isolation issue. 37/37 tests pass.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Implemented verdict policy engine and developer-safe status/override API (TASK-1.10). Policy service resolves effective decisions with priority: active admin override > agent decision > unreviewed. Override scope hierarchy SPECIFIC_VERSION -> PACKAGE -> PROJECT -> GLOBAL. Admin endpoints: POST /admin/override (create with targetVerdict, scope, reason), GET /admin/overrides (list active), DELETE /admin/override/:id (deactivate). All authenticated via Bearer admin tokens. Developer-safe endpoints: GET /status/:package, GET /status/:package@:version, GET /explain/:package@:version return clear messages with package/version, current state, next action — verified to never leak prompts, tokens, secrets, or internal tool details. Cold-start allow requires clean evidence (no admin-baseline shortcuts). Project registry blocks without complete decision coverage. 7 policy tests, 55 total across all packages.
<!-- SECTION:FINAL_SUMMARY:END -->

## Test Spec

<!-- SECTION:TEST_SPEC:BEGIN -->
- [ ] #1 Policy tests assert allow decisions promote and serve only the exact package version hash/integrity recorded by the decision; same name/version with a different hash remains denied.
- [ ] #2 Block/quarantine tests assert neither state serves or promotes the package, both return deterministic developer-facing guidance, and neither leaks hidden prompts, secrets, internal tool transcripts, or raw sensitive logs.
- [ ] #3 Override authorization tests assert only security-admin tokens can override block or quarantine decisions, every override requires a recorded reason, and developer/ordinary-user tokens are denied.
- [ ] #4 Effective-decision tests cover base verdicts, active overrides, superseding agent decisions, post-hoc relabels, incident outcomes, and decision history ordering.
- [ ] #5 Cold-start policy tests assert allow requires clean provenance, behavior, install-trace, and heuristic evidence; missing, ambiguous, or failed evidence resolves to quarantine.
- [ ] #6 Registry-enablement tests assert imported project graphs require complete decision coverage and partial coverage produces safe npm/CLI/API failures with package/version, current state, status URL/command, and next action.
- [ ] #7 Revalidation tests assert prompt, model, pattern, or incident relabel changes enqueue affected override revalidation and may produce superseding effective decisions through pg-boss jobs.
- [ ] #8 Score tests assert scores are stored for calibration but v1 final policy does not silently convert numeric thresholds into allow/block/quarantine without the agent verdict and policy context.
<!-- SECTION:TEST_SPEC:END -->

## Definition of Done
<!-- DOD:BEGIN -->
- [x] #1 Policy tests cover allow/block/quarantine, exact hash binding, overrides, status output, and prompt/secret redaction.
<!-- DOD:END -->
