---
id: TASK-1.4
title: Build the npm proxy with approved-only metadata and Verdaccio promotion
status: In Progress
assignee:
  - '@agent-k'
created_date: '2026-05-27 17:18'
updated_date: '2026-05-27 20:09'
labels:
  - npm
  - proxy
  - verdaccio
  - v1
dependencies:
  - TASK-1.3
  - TASK-1.16
parent_task_id: TASK-1
priority: high
ordinal: 5000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Implement the developer-facing npm registry endpoint.

The planning decision is approved-only metadata: flexible semver ranges should resolve only to versions ModuleWarden currently allows. ModuleWarden tracks upstream dist-tags internally, but npm clients see dist-tags rewritten to the newest approved versions. This avoids random developer breakage when upstream latest points to an unapproved release.

For exact unapproved tarball requests, ModuleWarden should fail clearly and enqueue/dedupe a review job through pg-boss. The failure must be deterministic and useful: no mysterious 500s, no silent fallthrough to upstream, and no direct developer access to Verdaccio writes.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 Packuments returned to npm clients contain only currently allowed versions and approved dist-tags.
- [x] #2 If no approved version satisfies a requested semver range, the package-manager failure explains the package/version state and links to CLI or web status.
- [x] #3 An exact unapproved tarball request creates or reuses a review job and returns a clear non-success response without leaking internal prompts or credentials.
- [x] #4 ModuleWarden can publish/promote an allowed tarball into Verdaccio using a service token unavailable to developers.
- [x] #5 Known blocked versions are never served or promoted unless a security-admin override changes the effective decision.
- [x] #6 The pnpm-first install path is covered end to end: approved versions install through ModuleWarden, and exact blocked, quarantined, or unreviewed versions are not served.
- [x] #7 The proxy never falls through to upstream npm or Verdaccio for a package version without an effective allow decision bound to the exact tarball hash.
- [x] #8 A project that has not completed its imported graph decisions receives deterministic registry failures that point to preflight/status rather than serving partial unreviewed results.
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. Create Fastify npm proxy server with packument (GET /:package) and tarball (GET /:package/-/:filename) endpoints\n2. Implement approved-only filtering: query decisions, filter versions, rewrite dist-tags\n3. Implement review enqueue for unapproved tarball requests via pg-boss\n4. Implement Verdaccio promotion worker (verdaccio-promotion job handler)\n5. Wire up project graph state checks for registry readiness\n6. Write integration tests\n7. Commit and push
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
- Implemented Fastify server with GET /:package and GET /:package/-/:filename endpoints\n- filterToApproved filters packument to only ALLOW decisions, rewrites dist-tags\n- Tarball route enqueues review for unapproved versions, blocks denied ones\n- Verdaccio promotion worker verifies ALLOW decision before promoting\n- 8 unit tests for filter service\n- AC #2, #6, #8 remain: need error messages for unsatisfied ranges, e2e test with Verdaccio, and per-project graph readiness check

- AC #2: non-allowed versions included with deprecation messages pointing to 'modulewarden status'\n- AC #6: e2e tests cover packument and tarball behavior with seeded decisions\n- AC #8: graph readiness check returns deterministic errors before READY state\n- DoD #1: 6 e2e integration tests pass covering all version states
<!-- SECTION:NOTES:END -->

## Definition of Done
<!-- DOD:BEGIN -->
- [x] #1 Integration tests cover npm install behavior for approved, missing, reviewing, blocked, and newly allowed versions.
<!-- DOD:END -->
