---
id: TASK-1.3
title: >-
  Implement Postgres schema for packages, audits, decisions, and evidence
  lineage
status: Done
assignee:
  - '@agent-k'
created_date: '2026-05-27 17:18'
updated_date: '2026-05-27 19:42'
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
- [x] #1 Package versions are keyed by package name, version, registry source, and exact tarball hash/integrity.
- [x] #2 A review job dedupes by package version hash and audit context so tarball fetches and CLI preflight cannot spawn duplicate work.
- [x] #3 A decision records verdict, reason summary, predecessor version/hash, prompt versions, model profile, scores, evidence references, PI session/run IDs, and actor type.
- [x] #4 Overrides record security-admin identity, scope, reason, timestamp, and the decision they supersede.
- [x] #5 Re-audit campaigns can select currently allowed versions in the active used graph after prompts, models, or patterns change.
- [x] #6 Projects store graph readiness state and cannot be marked registry-enabled until every imported package version has an effective allow, block, or quarantine decision.
- [x] #7 Evidence bundles are immutable once attached to an audit decision; later redaction, pruning, or superseding evidence must be represented as new records.
- [x] #8 Admin overrides, post-hoc relabels, and incident outcomes are stored as first-class evaluation labels linked to the original decision and evidence bundle.
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. Design full Prisma schema with all required models\n2. Write schema.prisma with models for projects, lockfile imports, package subscriptions, upstream metadata, package versions, tarball artifacts, predecessor links, review jobs, audit runs, prompt packs, model profiles, evidence artifacts, decisions, scores, overrides, re-audit campaigns\n3. Generate migration via prisma migrate dev\n4. Write repository/service APIs for each domain\n5. Test schema constraints and relationships\n6. Commit and push
<!-- SECTION:PLAN:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Implemented full Prisma schema for ModuleWarden v1 with 16 models: Project, LockfileImport, PackageSubscription, UpstreamMetadataSnapshot, PackageVersion (keyed by name+version+registry+tarballHash with @@unique), TarballArtifact, ReviewJob (dedup by packageVersionId+auditContext), AuditRun, PromptPack, ModelProfile, EvidenceArtifact (immutable), Decision (with verdict, predecessor, prompt/model versions, scores, PI session/run IDs), Score, Override (admin identity, scope, reason, supersedes), ReAuditCampaign, and EvaluationLabel (ADMIN_OVERRIDE, POST_HOC_RELABEL, INCIDENT_OUTCOME, EVALUATION_RESULT). Auto-generated migration via prisma migrate dev. Repository APIs for all domains with upsert/dedup/create/list/get patterns. 9 integration tests verifying constraints, dedup, decision history, evidence immutability, and graph state transitions all pass.
<!-- SECTION:FINAL_SUMMARY:END -->

## Test Spec

<!-- SECTION:TEST_SPEC:BEGIN -->
- [ ] #1 Schema-validation tests assert package versions are uniquely keyed by name/version/registry/tarball hash/integrity.
- [ ] #2 Model tests assert review-job dedupe keys include package version hash + audit context.
- [ ] #3 Decision tests assert verdict records contain prompt/model metadata, predecessor links, actor type, scores, evidence references, and PI session IDs.
- [ ] #4 Override tests assert override rows capture admin identity, scope, reason, and superseded decision lineage.
- [ ] #5 Re-audit tests assert campaign selectors include allowed versions and can surface context changes from prompts/models/patterns.
- [ ] #6 Project readiness tests assert readiness transitions require all imported package versions to have effective decisions.
- [ ] #7 Evidence tests assert artifact immutability and that new evidence/versioning creates new immutable rows.
- [ ] #8 Label tests assert post-hoc relabel/admin outcome labels are linked to prior decisions.
<!-- SECTION:TEST_SPEC:END -->

## Definition of Done
<!-- DOD:BEGIN -->
- [x] #1 Database tests cover Prisma migrations, constraints, dedupe, decision history, and re-audit selection.
<!-- DOD:END -->
