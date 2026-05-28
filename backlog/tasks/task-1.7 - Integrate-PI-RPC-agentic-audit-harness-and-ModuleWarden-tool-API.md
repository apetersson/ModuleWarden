---
id: TASK-1.7
title: Integrate PI RPC agentic audit harness and ModuleWarden tool API
status: In Progress
assignee:
  - '@agent-k'
created_date: '2026-05-27 17:18'
updated_date: '2026-05-28 10:30'
labels:
  - pi
  - agent
  - tools
  - v1
dependencies:
  - TASK-1.3
  - TASK-1.6
  - TASK-1.16
parent_task_id: TASK-1
priority: high
ordinal: 8000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Integrate PI as the core agentic audit harness for each version audit.

Planning clarified that PI runs inside the same fresh isolated audit container as the code under audit. Each run receives the package version, its last-known-good predecessor state when one exists, the candidate patch/diff, prepared evidence, run-specific audit instructions, and useful local audit tools. The container has no shared mutable state and can reach ModuleWarden only through run-scoped RPC/model access.

The agent should not be a bare LLM prompt over a tarball. It must have access to auditing tools, heuristics/checkers, web/search/advisory lookup, source/package metadata, version diffs, sandbox traces, and a run-specific workspace. The whole point is to make the model context meaningful while keeping long-lived service credentials and unrelated system state out of the audit container.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 PI audit runs are launched by pg-boss jobs and persist job/run correlation IDs for retry and failure analysis.
- [ ] #2 RPC tools include package fetch/unpack, predecessor diff retrieval, source metadata lookup, static checks, sandbox install/import execution, web/search/advisory lookup, evidence write, and verdict submission.
- [ ] #3 The structured verdict supports allow, block, quarantine, risk summary, capability deltas, intent mismatch findings, exploit hypotheses, scores, and evidence references.
- [ ] #4 PI session output stored for auditability excludes core prompt disclosure in user-facing views.
- [ ] #5 The model adapter supports an external H100-backed OpenAI-compatible endpoint plus a pluggable fallback reviewer for development or missing credentials.
- [ ] #6 Stored PI/session output references prompt pack versions and summaries but does not persist or expose hidden core prompt text in user-facing evidence.
- [ ] #7 Worker can start a PI RPC audit run inside a fresh isolated audit container for a specific package version and predecessor.
- [ ] #8 The audit container includes the code under audit, last-known-good baseline, candidate patch/diff, prepared evidence, run-specific audit instructions, and useful audit tools.
- [ ] #9 PI can use full shell/tool access inside its audit container but can access ModuleWarden state only through run-scoped RPC tools for the current audit job.
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
Implement the ModuleWarden RPC server/tool bridge consumed by PI inside the audit container. Launch PI in the per-run container with run-specific instructions derived from the active prompt pack, local package artifacts, predecessor baseline, candidate patch/diff, prepared evidence, tool definitions, and a pluggable OpenAI-compatible model endpoint that can point at external H100 inference or a fallback reviewer. Capture PI session logs, tool calls, model metadata, evidence references, and final structured verdict without exposing hidden core prompt source or service secrets in user-facing evidence.
<!-- SECTION:PLAN:END -->

## Definition of Done
<!-- DOD:BEGIN -->
- [ ] #1 A fake package audit can run end-to-end through PI RPC and persist a structured decision with evidence.
<!-- DOD:END -->
