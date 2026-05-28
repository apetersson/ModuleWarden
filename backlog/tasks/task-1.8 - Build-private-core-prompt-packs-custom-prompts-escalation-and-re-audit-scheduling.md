---
id: TASK-1.8
title: >-
  Build private core prompt packs, custom prompts, escalation, and re-audit
  scheduling
status: In Progress
assignee:
  - '@agent-k'
created_date: '2026-05-27 17:18'
updated_date: '2026-05-28 11:50'
labels:
  - prompts
  - models
  - reaudit
  - v1
dependencies:
  - TASK-1.3
  - TASK-1.7
  - TASK-1.16
parent_task_id: TASK-1
priority: high
ordinal: 9000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Implement the prompt/model policy that gives ModuleWarden its defensive asymmetry.

Core prompts are private from developers, package authors, compromised maintainers, and ordinary users. Admins may add visible custom prompts, but the core prompt suite remains hidden from normal product surfaces. Each verdict stores prompt versions so decisions can be traced and re-audited after updates. Re-audit and escalation work must be scheduled through pg-boss, not an external queue.

The review strategy is dual: first pass prompts are deliberately broader and more vague to reduce false negatives; escalation prompts are more precise and run on a higher-capability model to reduce false positives before final block/quarantine. Prompt and pattern packs should evolve when new CVEs or package-attack patterns become known.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 Core prompt contents are not exposed through CLI, web UI, package-manager errors, API responses for normal users, or audit artifacts shown to developers.
- [ ] #2 Security/admin users can add custom prompts that run alongside the core suite without replacing hidden core prompts.
- [x] #3 Every audit records exact prompt-pack versions, custom prompt versions, model profile, and escalation path.
- [x] #4 Escalation runs when the first pass finds suspicious evidence, uncertainty that would quarantine, or high-risk capability deltas.
- [x] #5 Changing prompts, models, or known-pattern libraries schedules re-audits for currently allowed versions in the active used graph.
- [ ] #6 Model endpoint profiles record provider, trust boundary, logging posture, and whether prompt secrecy guarantees are degraded.
- [x] #7 Prompt, model, or pattern changes enqueue re-audits that include versions with active admin overrides and may supersede those overrides with new effective decisions.
- [ ] #8 Audit containers receive run-specific instructions derived from prompt packs, but long-lived core prompt source files and service credentials are not mounted into the container.
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. Create prompt pack and model profile repositories\n2. Create prompt pack service for run-specific instruction assembly\n3. Wire re-audit campaign triggers on prompt/model changes\n4. Wire escalation path in reviews handler\n5. Add prompt version logging to decision creation\n6. Write tests
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Created prompt pack and model profile repositories. Created prompt-pack.ts service (assembleAuditInstructions, buildContainerInstructionFile, shouldEscalate). Created prompt-reaudit.ts service (triggerPromptChangeReAudit, onPromptPackCreated). All tests pass.

Escalation path wired: shouldEscalateVerdict() in api-proxy/service/escalation.ts detects quarantine/high-risk verdicts. Internal verdict endpoint stores escalation_recommended label. Jobs test for escalation previously existed in model-escalation handler.

TASK-1.13 started. Evaluation corpus and runner created.
<!-- SECTION:NOTES:END -->

## Definition of Done
<!-- DOD:BEGIN -->
- [ ] #1 Tests cover prompt visibility boundaries, versioning, escalation triggers, and re-audit campaign creation.
<!-- DOD:END -->
