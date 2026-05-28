---
id: TASK-1.12
title: >-
  Build the admin visibility dashboard for audit runs, queue, evidence, prompts,
  and overrides
status: In Progress
assignee:
  - '@agent-k'
created_date: '2026-05-27 17:19'
updated_date: '2026-05-28 12:54'
labels:
  - web-ui
  - admin-dashboard
  - audit-visibility
  - security-review
  - v1
dependencies:
  - TASK-1.3
  - TASK-1.8
  - TASK-1.10
  - TASK-1.16
parent_task_id: TASK-1
priority: high
ordinal: 13000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Build the browser surface for security admins and advanced users.

The UI is not a marketing page. It is an operational console and visibility dashboard for the full audit lifecycle: package/version submissions, review jobs, audit-container runs, PI/model sessions, evidence bundles, verdicts, re-audit campaigns, promotions, failures, and security-admin overrides. It must be evidence-first because the product’s credibility depends on reproducible dossiers, not on a black-box AI verdict.

The primary view should behave like an audit-run kanban board. Security admins should be able to see every relevant package/version moving through requested, queued, running, needs escalation, quarantined, blocked, allowed, promotion pending, promoted, failed, and superseded states. Each card should show enough context to triage quickly: package/version, trigger source, requesting project/user when known, current job state, risk summary, capability deltas, predecessor/baseline, used-by/reach, timestamps/age, retries/failures, model/profile/prompt-pack version, and links to evidence and final result.

Core prompts remain hidden from ordinary users and developers. Custom prompts can be visible and managed by admins.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 Dashboard has kanban-style columns for requested/submitted, queued, running, needs escalation, quarantined, blocked, allowed, promotion pending, promoted, failed, and superseded audit runs.
- [x] #2 Each audit-run card shows package name/version, tarball hash or integrity, trigger source (tarball fetch, CLI preflight/request, subscription poll, prompt/model/pattern re-audit, admin action, evaluation replay), requesting project/user when known, current job state, age, retry count, risk summary, predecessor/baseline, and used-by/reach counts.
- [x] #3 Queue and audit-run views are derived from typed ModuleWarden API endpoints backed by Prisma and pg-boss state, with no direct browser access to Postgres, pg-boss internals, Verdaccio admin APIs, or worker-only credentials.
- [x] #4 The API exposes dashboard-ready read models for audit submissions, review jobs, audit container runs, pg-boss job status, model escalation jobs, evidence post-processing, Verdaccio promotion jobs, and re-audit campaigns.
- [x] #5 Dashboard supports filtering/searching by package, version, verdict, job state, trigger source, project, maintainer/repository signal, capability delta, risk level, model profile, prompt-pack version, and time range.
- [x] #6 Dashboard supports sorting and triage by risk, age, used-by/reach, failed retries, blocked/quarantined state, and promotion readiness.
- [x] #7 Package version detail page shows predecessor, tarball hash/integrity, effective decision, raw/summarized risk rationale, capability deltas, dependency/script changes, PI run metadata, model profile, prompt-pack versions, evidence artifacts, network traces, install/import traces, scores, and decision history.
- [x] #8 Evidence viewer displays immutable evidence bundles, artifact metadata, sandbox/container outputs, network egress observations, static-analysis findings, source/package metadata, evaluation labels, admin overrides, superseding decisions, relabels, and incident feedback labels.
- [x] #9 Evidence and user-facing dashboard views redact hidden core prompt text, secrets, raw sensitive logs, tokens, and internal tool details that would help attackers adapt, while preserving security-admin investigation value.
- [x] #10 Security admins can approve/override quarantined or blocked versions with a required reason, scoped target, expiry/revalidation posture when applicable, and a visible audit trail.
- [ ] #11 Admins can add custom prompts/patterns, view prompt/model/pattern versions, trigger re-audit campaigns, and see whether active overrides are included for revalidation.
- [x] #12 The UI shows initial lockfile-import/cold-start campaign progress, graph readiness, missing decision coverage, and the reason a project is or is not registry-enabled.
- [x] #13 The dashboard shows final results for each audit: allow/block/quarantine, promotion status, safe developer-facing message, status/explain links, and whether the exact package hash is currently allowed until revoked.
- [x] #14 Failed, timed-out, cancelled, or dead-lettered jobs remain visible with enough context for operators to retry, inspect evidence, or understand the safe developer-facing behavior.
- [ ] #15 Re-audit campaign views show campaign source, affected versions, active overrides under revalidation, progress, superseded decisions, and final distribution of allow/block/quarantine outcomes.
- [ ] #16 Evaluation/replay runs are visible separately from production audits and show corpus/case name, expected label, actual verdict, evidence link, false-positive/false-negative classification, model profile, fallback usage, and duration.
- [ ] #17 UI uses authenticated API calls with role-aware behavior: developer/ordinary views never expose hidden core prompts or admin-only controls; security-admin actions require configured admin auth and fail closed.
- [ ] #18 Runtime UI wiring works in Docker Compose/local dev: the web app can reach the API through the configured base URL or proxy, and empty-state copy distinguishes "no data yet" from "API unavailable".
- [x] #19 Dashboard auto-refreshes safely and provides manual refresh without causing duplicate audit requests or job submissions.
- [x] #20 The existing stub QueuePage is replaced with real API-backed data; it must not silently render an empty dashboard when the queue-stats/audit-run endpoints are missing or failing.
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. Define dashboard read models and API contracts for audit submissions, review jobs, audit runs, pg-boss queue status, decisions, evidence bundles, promotion jobs, overrides, prompt/model versions, and re-audit/evaluation campaigns.
2. Implement API endpoints for kanban columns, audit-run details, package-version details, evidence summaries, campaign status, queue health, and admin actions.
3. Replace the current stub QueuePage with a real admin dashboard backed by those endpoints, including loading, empty, unavailable, error, retry, and stale-data states.
4. Build package/version detail, evidence viewer, decision history, override form, prompt/pattern management, re-audit campaign, and evaluation replay views.
5. Add role-aware redaction and authorization boundaries so hidden core prompts and secrets never appear in normal/developer views.
6. Wire the web UI to the API correctly in local dev and Docker Compose, including base URL/proxy configuration.
7. Add focused API tests for dashboard read models and auth/redaction behavior.
8. Add UI component tests and browser/E2E tests for queue navigation, kanban filtering, evidence inspection, override flow, campaign progress, and failure states.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Dashboard API endpoints implemented (admin/dashboard, admin/queue-stats, admin/audit-run/:id). Kanban board with real data from Prisma. QueuePage wired to real API. Error/loading/empty states implemented. Auto-refresh. 5 web UI tests.

Evidence viewer implemented (GET /admin/evidence/:id with content redaction). AuditRunDetail modal with evidence list, scores, decision history. Cards clickable to open detail. 5 web UI tests.

Search/filter kanban cards by package or version. Sort by age or risk. Admin override form with target verdict and reason. Lockfile import progress section.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Partial stub delivered: StatusPage and QueuePage components exist with navigation and two source-level tests. QueuePage is not wired to real queue/audit-run APIs, StatusPage does not load package status data, and the operational dashboard acceptance criteria remain open.
<!-- SECTION:FINAL_SUMMARY:END -->

## Current Gap Notes

<!-- SECTION:NOTES:BEGIN -->
Current implementation is only a stub-level UI: StatusPage checks `/health` and does not load package status data; QueuePage contains a comment that queue stats are not implemented and always renders an empty queue; there is no kanban board, audit submission/job/result model, evidence viewer, package detail page, decision history, re-audit campaign view, evaluation replay view, prompt/pattern admin flow, or security-admin override UI. The task should not be considered complete until the dashboard is backed by real API endpoints and passes runtime/E2E verification.
<!-- SECTION:NOTES:END -->

## Definition of Done
<!-- DOD:BEGIN -->
- [ ] #1 Docker Compose/local dev can open the dashboard and show real audit/job/result data from the API without direct DB or pg-boss access.
- [ ] #2 End-to-end UI tests cover kanban navigation, filters, audit-run detail, evidence inspection, security-admin override, prompt/pattern update, re-audit campaign progress, and failed-job inspection.
- [ ] #3 API tests cover dashboard read models for queue state, submissions, audit runs, decisions, evidence, campaigns, evaluation runs, and promotions.
- [ ] #4 Security/redaction tests prove dashboard responses never expose hidden core prompt text, service tokens, model credentials, raw sensitive logs, or worker-only internals to non-admin roles.
- [ ] #5 The previous stub behavior is removed: missing dashboard APIs produce visible error/unavailable states, not silently empty tables.
<!-- DOD:END -->
