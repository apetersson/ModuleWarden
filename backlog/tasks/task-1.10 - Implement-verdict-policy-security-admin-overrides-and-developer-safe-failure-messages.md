---
id: TASK-1.10
title: >-
  Implement verdict policy, security-admin overrides, and developer-safe failure
  messages
status: In Progress
assignee:
  - '@agent-k'
created_date: '2026-05-27 17:19'
updated_date: '2026-05-28 06:57'
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
- [ ] #1 Allow decisions promote/serve the exact package version hash and no other hash for the same version string.
- [ ] #2 Block decisions prevent serve/promotion and expose a concise reason plus safer alternatives when known.
- [ ] #3 Quarantine decisions prevent serve/promotion until a later agent run or security-admin override changes the effective decision.
- [ ] #4 Only security-admin tokens can override a quarantined or blocked version in v1.
- [ ] #5 Developer-facing errors include package/version, current state, status command/URL, and next action, but never core prompt content or secrets.
- [ ] #6 Cold-start allow is permitted only when required provenance, behavior, install-trace, and heuristic checks are clean; missing or ambiguous evidence resolves to quarantine.
- [ ] #7 No admin-baseline allow shortcut exists in v1; security admins can override block or quarantine decisions only with recorded reasons.
- [ ] #8 Project registry enablement requires complete decision coverage for the imported graph, and partial coverage produces safe developer-facing failures.
- [ ] #9 Prompt, model, pattern, or incident relabel changes revalidate affected overrides and can produce superseding effective decisions.
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. Create verdict policy service with effective decision resolution\n2. Create admin override endpoints with auth\n3. Create developer-safe status/explain API\n4. Wire cold-start policy into existing import flow\n5. Add re-audit revalidation logic\n6. Write comprehensive policy tests\n7. Commit and push
<!-- SECTION:PLAN:END -->

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
- [ ] #1 Policy tests cover allow/block/quarantine, exact hash binding, overrides, status output, and prompt/secret redaction.
<!-- DOD:END -->
