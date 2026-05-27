---
id: TASK-1.8
title: >-
  Build private core prompt packs, custom prompts, escalation, and re-audit
  scheduling
status: To Do
assignee: []
created_date: '2026-05-27 17:18'
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
- [ ] #3 Every audit records exact prompt-pack versions, custom prompt versions, model profile, and escalation path.
- [ ] #4 Escalation runs when the first pass finds suspicious evidence, uncertainty that would quarantine, or high-risk capability deltas.
- [ ] #5 Changing prompts, models, or known-pattern libraries schedules re-audits for currently allowed versions in the active used graph.
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
Create a prompt-pack registry with hidden core prompts and visible custom prompts. Implement first-pass and escalation model profiles against a local OpenAI-compatible endpoint. Add pg-boss re-audit campaign scheduling when prompt packs, model profiles, or pattern libraries change.
<!-- SECTION:PLAN:END -->

## Definition of Done
<!-- DOD:BEGIN -->
- [ ] #1 Tests cover prompt visibility boundaries, versioning, escalation triggers, and re-audit campaign creation.
<!-- DOD:END -->
