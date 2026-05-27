---
id: TASK-1.6
title: Create isolated per-job Docker audit runner with recorded-open egress
status: To Do
assignee: []
created_date: '2026-05-27 17:18'
updated_date: '2026-05-27 18:15'
labels:
  - sandbox
  - docker
  - security
  - v1
dependencies:
  - TASK-1.2
  - TASK-1.3
  - TASK-1.16
parent_task_id: TASK-1
priority: high
ordinal: 7000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Build the execution boundary for agentic research runs.

The user explicitly required every agentic research run to be isolated in an individual Docker instance from a custom container. Each job gets a fresh container, a run-specific temp workspace mount, and no shared mutable state. After the job finishes, only declared artifacts and evidence are persisted, then the container is destroyed.

The network policy for v1 is recorded-open: egress is allowed because research may need web/package/source/advisory access, but DNS and connection metadata must be captured and preserved as evidence. This is intentionally different from a package execution sandbox that silently blocks everything; unexpected network behavior can itself be evidence.

The container must not receive model API credentials, core prompt files, DB credentials, or Verdaccio service credentials. It receives only a run-scoped RPC token to talk to ModuleWarden-controlled services.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 Every audit run starts in a fresh container from the configured audit image and a fresh temp workspace.
- [ ] #2 The worker injects only package inputs, run configuration, and a run-scoped RPC token into the container.
- [ ] #3 Core prompts, model endpoint secrets, Postgres credentials, and Verdaccio service tokens are never mounted into or exposed as environment variables in the audit container.
- [ ] #4 Network egress metadata is captured and attached to the audit evidence bundle.
- [ ] #5 The worker destroys the container after completion, timeout, cancellation, or crash, preserving only declared artifacts.
- [ ] #6 Container egress permits public internet access through recorded networking while blocking host services, internal/private networks, link-local metadata IPs, Postgres, and Verdaccio admin endpoints.
- [ ] #7 The only ModuleWarden-facing capability available inside a container is the run-scoped tool/RPC bridge for its own audit job.
- [ ] #8 Audit containers run PI plus package inspection tools, and receive only package artifacts, last-known-good baseline, candidate patch/diff, prepared evidence, run-specific instructions, and run-scoped access tokens.
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
Build the modulewarden-audit-runner Docker image with PI runtime, Node/npm/pnpm/yarn, git, ripgrep, jq, static-rule tooling, deobfuscation helpers, network capture/proxy tools, and minimal system utilities for package inspection. Implement pg-boss worker orchestration that creates, monitors, captures artifacts from, and removes one container per audit job. Each container receives the audited package, last-known-good baseline, patch/diff, prepared evidence, run-specific instructions, useful audit tools, recorded public-internet egress, internal-network blocking, and only run-scoped RPC/model access.
<!-- SECTION:PLAN:END -->

## Definition of Done
<!-- DOD:BEGIN -->
- [ ] #1 Sandbox tests verify isolation, absence of forbidden secrets, evidence capture, timeout cleanup, and no container reuse.
<!-- DOD:END -->
