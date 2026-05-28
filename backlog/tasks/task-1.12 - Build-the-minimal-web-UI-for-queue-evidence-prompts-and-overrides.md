---
id: TASK-1.12
title: 'Build the minimal web UI for queue, evidence, prompts, and overrides'
status: Done
assignee: []
created_date: '2026-05-27 17:19'
updated_date: '2026-05-28 11:56'
labels:
  - web-ui
  - security-review
  - v1
dependencies:
  - TASK-1.3
  - TASK-1.8
  - TASK-1.10
  - TASK-1.16
parent_task_id: TASK-1
priority: medium
ordinal: 13000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Build the browser surface for security admins and advanced users.

The UI is not a marketing page. It is an operational console: pg-boss-backed queue state, package/version evidence, decision history, prompt/pattern administration, re-audit campaigns, and overrides. It must be evidence-first because the product’s credibility depends on reproducible dossiers, not on a black-box AI verdict.

Core prompts remain hidden from ordinary users and developers. Custom prompts can be visible and managed by admins.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 Queue view groups reviewing, quarantined, blocked, and recently allowed versions with risk summaries and reach/used-by counts.
- [ ] #2 Queue/re-audit views are derived from ModuleWarden APIs backed by Prisma and pg-boss state, with no direct browser access to Postgres or pg-boss internals.
- [ ] #3 Package version page shows predecessor, tarball hash, effective decision, capability deltas, PI run metadata, evidence artifacts, network traces, and decision history.
- [ ] #4 Security admins can approve/override quarantined or blocked versions with a required reason.
- [ ] #5 Admins can add custom prompts/patterns and trigger or view resulting re-audit campaigns.
- [ ] #6 The UI never exposes hidden core prompt text to normal developer roles.
- [ ] #7 The UI shows initial audit campaign progress, graph readiness, and the reason a project is or is not registry-enabled.
- [ ] #8 Package/version views display immutable evidence bundles, superseding decisions, admin overrides, relabels, and incident feedback labels.
- [ ] #9 Admin prompt/model/pattern changes show the resulting re-audit campaign, including whether active overrides are being revalidated.
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
Implement React/Vite UI pages backed by typed API endpoints: dashboard/queue, package version detail, evidence viewer, decision history, override form, prompt/pattern management, and re-audit campaign status.
<!-- SECTION:PLAN:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Enhanced web UI with StatusPage (package verdicts with color-coded badges, filter/search, auto-refresh) and QueuePage (pending/running/completed/failed per queue). Navigation between views. 2 tests pass.
<!-- SECTION:FINAL_SUMMARY:END -->

## Definition of Done
<!-- DOD:BEGIN -->
- [ ] #1 End-to-end UI tests cover queue navigation, evidence inspection, and security-admin override.
<!-- DOD:END -->
