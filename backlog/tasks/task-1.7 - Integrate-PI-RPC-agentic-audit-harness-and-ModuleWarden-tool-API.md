---
id: TASK-1.7
title: Integrate PI RPC agentic audit harness and ModuleWarden tool API
status: To Do
assignee: []
created_date: '2026-05-27 17:18'
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
Integrate PI as the core task package for each version audit.

Planning clarified that PI is not the policy engine. ModuleWarden launches a custom agentic research run instrumented with the LLM harness PI in RPC mode. PI runs inside the isolated audit container with full sandbox shell access, while ModuleWarden exposes narrow RPC tools for fetching package data, recording evidence, running controlled checks, and submitting verdicts.

The agent should not be a bare LLM prompt over a tarball. It must have access to auditing tools, heuristics/checkers, web/search/advisory lookup, source/package metadata, version diffs, sandbox traces, and a run-specific workspace. The whole point is to make the model’s context meaningful.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 Worker can start a PI RPC audit run inside an audit container for a specific package version and predecessor.
- [ ] #6 PI audit runs are launched by pg-boss jobs and persist job/run correlation IDs for retry and failure analysis.
- [ ] #2 PI can use full shell inside the container but can only access ModuleWarden state through run-scoped RPC tools.
- [ ] #3 RPC tools include package fetch/unpack, predecessor diff retrieval, source metadata lookup, static checks, sandbox install/import execution, web/search/advisory lookup, evidence write, and verdict submission.
- [ ] #4 The structured verdict supports allow, block, quarantine, risk summary, capability deltas, intent mismatch findings, exploit hypotheses, scores, and evidence references.
- [ ] #5 PI session output stored for auditability excludes core prompt disclosure in user-facing views.
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
Implement the ModuleWarden RPC server/tool bridge consumed by PI. Launch PI with --mode rpc, local OpenAI-compatible model configuration, core prompt pack, custom prompt additions, and tool definitions. Capture PI session logs, tool calls, model metadata, and final structured verdict.
<!-- SECTION:PLAN:END -->

## Definition of Done
<!-- DOD:BEGIN -->
- [ ] #1 A fake package audit can run end-to-end through PI RPC and persist a structured decision with evidence.
<!-- DOD:END -->
