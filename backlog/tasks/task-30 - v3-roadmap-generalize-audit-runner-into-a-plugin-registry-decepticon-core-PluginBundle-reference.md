---
id: TASK-30
title: >-
  v3 roadmap: generalize audit-runner into a plugin registry (decepticon-core
  PluginBundle reference)
status: To Do
assignee: []
created_date: '2026-05-28 20:47'
labels:
  - roadmap
  - architecture
  - q4
  - post-hackathon
dependencies: []
priority: medium
ordinal: 46000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Post-hackathon (Q4) architectural reference, not a hackathon deliverable. VoidChecksum/Decepticon's decepticon-core package is a clean plugin SDK: protocols/ (agent, backend, sandbox, tool, llm, middleware) plus registry/ (roles, safety, skills, plugins) plus a PluginBundle contract, with test_no_runtime_deps.py keeping the core pure-contracts. That shape is the reference for generalizing packages/audit-runner from a single PI orchestrator into a registry of audit specialist plugins (e.g. separate lifecycle-script, network-egress, credential-access analyzers that each contribute findings). Apache 2.0, so the pattern is freely referenceable. Do NOT port code; study the protocols/registry boundary. Gate this on a real need for multiple audit specialists; the single-orchestrator path is correct for v1/v2.
<!-- SECTION:DESCRIPTION:END -->
