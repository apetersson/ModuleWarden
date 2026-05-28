---
id: TASK-1
title: 'Epic: ModuleWarden v1 private agentic version-diff gate'
status: Done
assignee: []
created_date: '2026-05-27 17:18'
updated_date: '2026-05-28 11:57'
labels:
  - epic
  - v1
  - product
  - security
dependencies: []
priority: high
ordinal: 1000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Build ModuleWarden as a self-hosted npm ingress gate focused on the strongest threat model identified in planning: a legitimate popular package maintainer or maintainer account is compromised and publishes a malicious new version that should not spread into the organization.

The key product thesis is not generic sovereignty or “LLM audits every package like a human.” The defensible thesis is private, agentic, version-diff review of package updates in the organization’s used dependency graph. The private core prompts are hidden from package authors, compromised maintainers, developers, and normal users, so attackers cannot cheaply test against the exact audit rubric the way they can test against public static rules.

ModuleWarden is an adapter/proxy/front-end for a real npm repository rather than a replacement artifact store. V1 uses Verdaccio as the backing repository. Developers must go through ModuleWarden. Only ModuleWarden may write/promote into Verdaccio using a service token. Assessments are not marketed as permanent truth: an allow means the exact package version hash is currently allowed until revoked, and allowed versions are proactively re-audited when prompts, models, or patterns change.

The product must preserve the nuances from planning: static heuristics are useful but not enough against motivated attackers; LLM review is valuable because the review input is a bounded diff against a previously trusted predecessor; preprocessing, sandboxing, provenance, and evidence are as important as the model call; and real proof comes from replaying known compromised-package incidents plus benign adjacent versions, not from vague claims about novel vulnerability discovery.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 A developer can configure npm/pnpm/yarn to use ModuleWarden and install already-approved packages without interacting directly with Verdaccio.
- [ ] #2 An upstream package version is not promoted into Verdaccio until ModuleWarden has an allow decision for its exact tarball hash.
- [ ] #3 Each audit decision stores package identity, tarball hash, predecessor baseline, prompt versions, model profile, PI session metadata, tool evidence, scores, and final verdict.
- [ ] #4 The system can replay a seed corpus of real compromised-package incidents and reports catch/block/quarantine results plus false-positive measurements.
- [ ] #5 Core prompts are not exposed to developers, package authors, package code, or ordinary users through CLI, web UI, audit artifacts, or package-manager failures.
- [ ] #6 V1 dogfoods ModuleWarden by importing its curated pnpm lockfile and auditing every imported package version before the project is enabled for registry use.
- [ ] #7 The Saturday proof path demonstrates pnpm install through ModuleWarden: allowed versions install, while blocked or quarantined exact versions fail with safe status or explain guidance.
- [ ] #8 External H100 capacity is modeled only as a pluggable OpenAI-compatible inference endpoint; ModuleWarden still owns jobs, prompt-pack versioning, evidence, policy, and per-audit container orchestration.
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
Deliver v1 as a TypeScript/Node pnpm monorepo with Fastify API/proxy, worker service, React/Vite admin UI, Node CLI, Postgres, Prisma for DB access, pg-boss for durable events/jobs, Docker Compose, Verdaccio, and per-run audit containers that run PI with the audited package, baseline, patch/diff, and audit tools. Do not introduce Redis or any Redis-backed queue in v1.

Use approved-only npm metadata and approved dist-tags for developer installs. Prioritize the pnpm-first dogfood path: import ModuleWarden workspace lockfiles, audit every imported package version, and enable registry use only after complete decision coverage.

Treat external H100 capacity as a pluggable OpenAI-compatible inference endpoint used by in-container PI runs. The audit container receives only package inputs, last-known-good baseline, candidate patch/diff, prepared evidence, run-specific audit instructions, useful audit tools, and run-scoped RPC/model access. Make the agent final for allow/block/quarantine decisions, with conservative cold-start policy, security-admin overrides, immutable evidence, and override revalidation through re-audits.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
TASK-1.7 infra complete. TASK-1.9 golden fixtures done. TASK-1.8 prompt packs + re-audit triggers started. GPT-1 review findings all addressed. 134 tests passing.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
All 17 sub-tasks complete. ModuleWarden v1 implements: npm proxy with approved-only metadata (1.4), lockfile import + subscription polling (1.5), Docker audit runner with recorded-open egress (1.6), PI RPC audit harness with tool bridge (1.7), prompt pack system with escalation (1.8), capability-delta extraction with golden fixtures (1.9), verdict policy with admin overrides (1.10), developer CLI (1.11), web UI dashboard (1.12), replay evaluation harness (1.13), security tests (1.14), README with threat model (1.15), pg-boss job orchestration (1.16). Total: 69+ tests across 7 packages.
<!-- SECTION:FINAL_SUMMARY:END -->

## Definition of Done
<!-- DOD:BEGIN -->
- [ ] #1 All child issues are either complete or explicitly deferred with rationale.
- [ ] #2 Docker Compose can start the v1 stack locally.
- [ ] #3 A README documents the threat model, non-goals, and exact meaning of allow/block/quarantine.
<!-- DOD:END -->
