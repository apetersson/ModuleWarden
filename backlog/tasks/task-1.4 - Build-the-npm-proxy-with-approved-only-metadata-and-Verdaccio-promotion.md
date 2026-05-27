---
id: TASK-1.4
title: Build the npm proxy with approved-only metadata and Verdaccio promotion
status: To Do
assignee: []
created_date: '2026-05-27 17:18'
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
- [ ] #1 Packuments returned to npm clients contain only currently allowed versions and approved dist-tags.
- [ ] #2 If no approved version satisfies a requested semver range, the package-manager failure explains the package/version state and links to CLI or web status.
- [ ] #3 An exact unapproved tarball request creates or reuses a review job and returns a clear non-success response without leaking internal prompts or credentials.
- [ ] #4 ModuleWarden can publish/promote an allowed tarball into Verdaccio using a service token unavailable to developers.
- [ ] #5 Known blocked versions are never served or promoted unless a security-admin override changes the effective decision.
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
Proxy npm packument and tarball endpoints. Fetch upstream metadata for internal tracking. Filter packument versions to allowed decisions, rewrite dist-tags to allowed versions, serve allowed tarballs via Verdaccio, and enqueue pg-boss promotion jobs so upstream tarballs enter Verdaccio only after allow decisions.
<!-- SECTION:PLAN:END -->

## Definition of Done
<!-- DOD:BEGIN -->
- [ ] #1 Integration tests cover npm install behavior for approved, missing, reviewing, blocked, and newly allowed versions.
<!-- DOD:END -->
