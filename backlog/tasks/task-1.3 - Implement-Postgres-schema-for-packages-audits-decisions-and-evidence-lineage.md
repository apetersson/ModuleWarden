---
id: TASK-1.3
title: >-
  Implement Postgres schema for packages, audits, decisions, and evidence
  lineage
status: In Progress
assignee:
  - '@agent-k'
created_date: '2026-05-27 17:18'
updated_date: '2026-05-27 18:47'
labels:
  - database
  - prisma
  - provenance
  - v1
dependencies:
  - TASK-1.1
  - TASK-1.2
parent_task_id: TASK-1
priority: high
ordinal: 4000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Design and implement the persistence layer that makes ModuleWarden more than a transient LLM wrapper. All application DB access in v1 must go through Prisma; do not introduce ad hoc SQL clients or ORM alternatives for normal product reads/writes.

The database must preserve decision provenance. Every verdict needs enough information to explain why a package version was allowed, blocked, or quarantined, and to later reassess whether prompt/model/pattern changes should revoke or re-audit it.

Important nuance: an allowed verdict is currently valid until revoked, not proof that a package is clean forever. Scores are retained even if v1 does not use numeric thresholds for final decisions, because later evaluation should determine which scores predict real outcomes or review noise.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 Package versions are keyed by package name, version, registry source, and exact tarball hash/integrity.
- [ ] #2 A review job dedupes by package version hash and audit context so tarball fetches and CLI preflight cannot spawn duplicate work.
- [ ] #3 A decision records verdict, reason summary, predecessor version/hash, prompt versions, model profile, scores, evidence references, PI session/run IDs, and actor type.
- [ ] #4 Overrides record security-admin identity, scope, reason, timestamp, and the decision they supersede.
- [ ] #5 Re-audit campaigns can select currently allowed versions in the active used graph after prompts, models, or patterns change.
- [ ] #6 Projects store graph readiness state and cannot be marked registry-enabled until every imported package version has an effective allow, block, or quarantine decision.
- [ ] #7 Evidence bundles are immutable once attached to an audit decision; later redaction, pruning, or superseding evidence must be represented as new records.
- [ ] #8 Admin overrides, post-hoc relabels, and incident outcomes are stored as first-class evaluation labels linked to the original decision and evidence bundle.
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. Design full Prisma schema with all required models\n2. Write schema.prisma with models for projects, lockfile imports, package subscriptions, upstream metadata, package versions, tarball artifacts, predecessor links, review jobs, audit runs, prompt packs, model profiles, evidence artifacts, decisions, scores, overrides, re-audit campaigns\n3. Generate migration via prisma migrate dev\n4. Write repository/service APIs for each domain\n5. Test schema constraints and relationships\n6. Commit and push
<!-- SECTION:PLAN:END -->

## Definition of Done
<!-- DOD:BEGIN -->
- [ ] #1 Database tests cover Prisma migrations, constraints, dedupe, decision history, and re-audit selection.
<!-- DOD:END -->
