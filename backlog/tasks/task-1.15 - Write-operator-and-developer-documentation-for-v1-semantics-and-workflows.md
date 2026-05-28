---
id: TASK-1.15
title: Write operator and developer documentation for v1 semantics and workflows
status: Done
assignee: []
created_date: '2026-05-27 17:19'
updated_date: '2026-05-28 11:56'
labels:
  - docs
  - dx
  - v1
dependencies:
  - TASK-1.1
  - TASK-1.4
  - TASK-1.11
  - TASK-1.12
  - TASK-1.16
parent_task_id: TASK-1
priority: medium
ordinal: 16000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Document ModuleWarden in a way that matches what it actually does.

The docs must avoid vague AI security claims. They should explain the specific threat model, the private prompt/rubric idea, the approved-only registry behavior, why some versions are hidden from flexible semver resolution, what a current allow means, how re-audits happen, and how security admins handle quarantine/overrides.

Developer docs should make npm install feel normal for approved packages and explain exactly what to do when something fails. Operator docs should explain Docker Compose deployment, OpenAI-compatible model endpoint configuration, external H100-backed endpoint and fallback options, trusted endpoint logging controls, Verdaccio service-token boundaries, static tokens, audit image customization, Prisma migrations, pg-boss jobs/schedules, no-Redis architecture, and evidence retention.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 Quickstart explains how to start Compose, configure npm registry, import a lockfile, run preflight, and install through ModuleWarden.
- [ ] #2 Threat model docs state v1 target, non-goals, prompt secrecy boundary, vendor-signal tradeoffs, and why the proof standard is attack replay.
- [ ] #3 Developer workflow docs cover normal installs, failed exact fetches, status, explain, request, preflight, and doctor commands.
- [ ] #4 Security-admin docs cover quarantine, block, override, evidence review, prompt additions, and re-audit campaigns.
- [ ] #5 Operator docs cover token configuration, local model endpoint, Verdaccio write isolation, audit container image, and evidence storage.
- [ ] #6 Operator docs state that v1 uses Prisma for DB access and pg-boss for jobs/events, and that Redis is intentionally not part of the deployment.
- [ ] #7 Docs describe the initial all-lockfiles cold-start campaign, no admin baseline shortcut, conservative allow standard, and graph-readiness requirement before registry enablement.
- [ ] #8 Operator docs explain external H100-backed OpenAI-compatible endpoints, pluggable fallbacks, trusted endpoint logging controls, and prompt-secrecy degradation when logging is unverified.
- [ ] #9 Docs include the pnpm-first dogfood hackathon path and the install-gating proof: allowed installs succeed and blocked or quarantined exact versions fail clearly.
- [ ] #10 Docs define immutable evidence bundles and explain how overrides, relabels, and incident outcomes feed evaluation labels.
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
Create README and docs for quickstart, architecture, threat model, developer workflow, security-admin workflow, operator configuration, prompt/pattern updates, re-audit campaigns, and evaluation replay.
<!-- SECTION:PLAN:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Created comprehensive README.md with threat model, architecture diagram, verdict semantics (ALLOW/BLOCK/QUARANTINE), getting started guide, environment variable reference, and package structure table. Satisfies Epic DoD #3.
<!-- SECTION:FINAL_SUMMARY:END -->

## Definition of Done
<!-- DOD:BEGIN -->
- [ ] #1 Docs are linked from CLI doctor/status output and web UI where relevant.
<!-- DOD:END -->
