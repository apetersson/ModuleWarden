---
id: TASK-1.1
title: Design the v1 architecture and threat model contract
status: In Progress
assignee:
  - '@agent-k'
created_date: '2026-05-27 17:18'
updated_date: '2026-05-27 18:29'
labels:
  - architecture
  - threat-model
  - v1
dependencies: []
parent_task_id: TASK-1
priority: high
ordinal: 2000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Document the implementation contract for ModuleWarden v1 before deep feature work starts. The contract must be explicit enough to prevent future scope drift back into a vague AI artifactory idea.

V1 scope is npm-only and focused on compromised-maintainer malicious version bumps in packages already present in the organization dependency graph. It may include exploit-discovery prompts, intent-mismatch review, and known-pattern checks, but the market claim to prove is compromise catcher, not general novel vulnerability oracle.

The architecture must capture the actual trust boundaries: developers only talk to ModuleWarden; ModuleWarden is the only writer/promoter into Verdaccio; each PI audit runs inside its own disposable isolated container with the audited code, last-known-good state, patch/diff, prepared evidence, run-specific instructions, and useful audit tools; OpenAI-compatible model endpoints may be local or external H100-backed trusted infrastructure; core prompts are hidden from developers and attackers but not promised to be secret from root infrastructure admins or trusted model endpoint operators.

The architecture must also lock the persistence and asynchronous execution choices: Prisma is the application DB access layer, Postgres is the system of record, and pg-boss is the only durable event/job orchestration mechanism. Redis and Redis-backed queues are out of scope for v1.

The document should also explain the important critique from planning: shared vendor telemetry is valuable, static rules are bypassable, LLMs are not magic on arbitrary minified tarballs, and the defensible advantage is private semantic diff review over bounded version changes with rich evidence collection. Cold starts are treated as a conservative initial audit campaign rather than proof of the diff thesis.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 The document distinguishes supply-chain malware, compromised-maintainer version bumps, and novel vulnerability discovery as separate threat classes.
- [x] #2 The document states that v1 optimizes for package-version diff review against a previously allowed predecessor.
- [x] #3 The document explains why private prompts help: attackers cannot cheaply test against the exact prompt/rubric, unlike public static rules.
- [x] #4 The document explicitly says prompts are hidden from developers and package code, but not protected from root administrators in v1.
- [x] #5 The document defines allow, block, quarantine, override, re-audit, and currently allowed until revoked semantics.
- [x] #6 The document states that Prisma owns DB access and pg-boss owns durable jobs/events; it explicitly excludes Redis from v1 architecture.
- [x] #7 The architecture defines cold start as an initial all-lockfiles audit campaign, not a normal diff, and explicitly rejects admin baseline allow shortcuts for v1.
- [x] #8 Cold-start verdict semantics are conservative: allow requires clean provenance, behavior, install traces, and heuristic evidence; uncertainty quarantines.
- [x] #9 The trust model treats the model endpoint operator as trusted infrastructure and documents logging controls plus the prompt-secrecy degradation when logging is unverified.
- [x] #10 Recorded-open egress means public internet only, with host, internal networks, link-local metadata services, and direct backing-service access blocked.
- [x] #11 The architecture specifies in-container PI audit execution: each run gets its own disposable container containing the audited package, last-known-good baseline, candidate patch/diff, prepared evidence, run-specific instructions, and audit tools.
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. Write docs/architecture.md covering all 11 ACs\n2. Review against planning decisions in the thread\n3. Commit the document
<!-- SECTION:PLAN:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Created docs/architecture.md — the v1 implementation contract covering all 11 acceptance criteria. The document defines threat classification (compromised-maintainer bumps, supply-chain malware, novel vulnerabilities), core diff-review thesis, private-prompts rationale, prompt secrecy model, verdict semantics (allow/block/quarantine/override/re-audit), persistence choices (Prisma + pg-boss, Redis excluded), cold-start definition and conservative verdict rules, trust boundaries with model-endpoint operator as trusted infrastructure, recorded-open egress model, in-container PI audit execution, non-goals, success criteria, architecture diagram, component inventory, and planning critique/rationale.
<!-- SECTION:FINAL_SUMMARY:END -->

## Definition of Done
<!-- DOD:BEGIN -->
- [ ] #1 Architecture document reviewed against every major planning decision in this thread.
<!-- DOD:END -->
