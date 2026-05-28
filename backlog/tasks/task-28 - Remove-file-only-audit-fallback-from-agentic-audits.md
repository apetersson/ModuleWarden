---
id: TASK-28
title: Remove file-only audit fallback from agentic audits
status: Superseded
assignee: []
created_date: '2026-05-28 19:45'
labels:
  - audit-runner
  - e2e
  - requirement
dependencies: []
documentation:
  - docs/dockerized-e2e-demo.md
modified_files:
  - packages/audit-runner/src/orchestrator.ts
  - packages/audit-runner/entrypoint.sh
priority: high
superseded_by: TASK-29
ordinal: 44000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Andreas explicitly required removal of the file-only audit fallback after the Dockerized E2E run produced a quarantine verdict without an agent conversation. Missing PI/RPC/model wiring must fail loudly instead of fabricating a file-only inspection result.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 Audit runner does not emit File-only inspection or Minimal inspection verdicts.
- [ ] #2 Missing RPC bridge, PI binary, or model endpoint causes the audit container to fail clearly.
- [ ] #3 The preserved audit session includes the initial prompt when the agentic path starts.
<!-- AC:END -->
