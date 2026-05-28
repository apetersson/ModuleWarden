---
id: TASK-1.9
title: >-
  Implement capability-delta extraction and evidence preparation for version
  diffs
status: In Progress
assignee:
  - '@agent-k'
created_date: '2026-05-27 17:19'
updated_date: '2026-05-28 07:00'
labels:
  - analysis
  - diff
  - evidence
  - v1
dependencies:
  - TASK-1.3
  - TASK-1.7
parent_task_id: TASK-1
priority: high
ordinal: 10000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Build the deterministic preprocessing that makes the LLM review useful.

The highest-value review question is not “is this whole package malicious?” It is “does this new version introduce behavior inconsistent with the package’s purpose, changelog, prior behavior, or allowed predecessor?” The system should therefore extract concise but rich evidence from the diff before and during the PI run.

The risk lens includes all three categories selected in planning: exploit discovery, intent mismatch, and known-pattern/prompt repository checks. Capability creep is especially important: new network, filesystem, process, env/credential access, dynamic code execution, native/WASM usage, dependency indirection, obfuscation, and lifecycle scripts should be surfaced even if they do not match a public static rule.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 For a version with an allowed predecessor, the audit bundle includes source/tarball metadata, dependency changes, lifecycle script changes, file-level diff summaries, and capability-delta summaries.
- [ ] #2 Capability extraction flags new or materially changed network, filesystem, process, env/credential, dynamic code, native/WASM, dependency indirection, obfuscation, and install-time behavior.
- [ ] #3 Intent evidence includes package purpose, changelog/release notes when available, README summary, repository/source links, and mismatch indicators.
- [ ] #4 Cold-start audits without a predecessor are marked differently and produce a full-package evidence bundle rather than a fake diff.
- [ ] #5 The PI agent receives ranked evidence plus raw artifact access so it can inspect beyond summaries.
- [ ] #6 Cold-start evidence bundles include provenance, maintainer and repository signals, package purpose, scripts, capability summary, dependency graph, install/import traces, and network observations.
- [ ] #7 Cold-start findings are scored and summarized separately from predecessor diffs so the policy layer can apply the conservative allow-or-quarantine standard.
- [ ] #8 Golden fixtures include ModuleWarden dogfood dependencies as cold-start examples in addition to malicious and benign version-diff fixtures.
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. Create package diff service (tarball unpack, file listing, diff)\n2. Create capability extraction service (static analysis)\n3. Create dependency diff service\n4. Create lifecycle script detector\n5. Create evidence bundle assembler\n6. Create intent evidence collector (changelog, README, repo)\n7. Write tests with golden fixtures\n8. Commit and push
<!-- SECTION:PLAN:END -->

## Definition of Done
<!-- DOD:BEGIN -->
- [ ] #1 Golden-fixture tests verify capability extraction on benign diffs, malicious-looking diffs, obfuscated changes, and dependency-only attacks.
<!-- DOD:END -->
