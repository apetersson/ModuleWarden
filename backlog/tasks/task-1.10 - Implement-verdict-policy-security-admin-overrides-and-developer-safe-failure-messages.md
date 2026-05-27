---
id: TASK-1.10
title: >-
  Implement verdict policy, security-admin overrides, and developer-safe failure
  messages
status: To Do
assignee: []
created_date: '2026-05-27 17:19'
updated_date: '2026-05-27 18:09'
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
Build policy evaluation around PI structured verdicts, effective decision resolution with overrides, static-token roles, failure response templates, and status/explain APIs. Implement security-admin-only override endpoints and audit logs. Verdict side effects, such as promotion, re-audit scheduling, or follow-up escalation, must be emitted through pg-boss jobs with idempotent payloads.
<!-- SECTION:PLAN:END -->

## Definition of Done
<!-- DOD:BEGIN -->
- [ ] #1 Policy tests cover allow/block/quarantine, exact hash binding, overrides, status output, and prompt/secret redaction.
<!-- DOD:END -->
