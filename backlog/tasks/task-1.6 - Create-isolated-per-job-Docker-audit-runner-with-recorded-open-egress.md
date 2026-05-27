---
id: TASK-1.6
title: Create isolated per-job Docker audit runner with recorded-open egress
status: Done
assignee:
  - '@agent-k'
created_date: '2026-05-27 17:18'
updated_date: '2026-05-27 20:16'
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
- [x] #1 Every audit run starts in a fresh container from the configured audit image and a fresh temp workspace.
- [x] #2 The worker injects only package inputs, run configuration, and a run-scoped RPC token into the container.
- [x] #3 Core prompts, model endpoint secrets, Postgres credentials, and Verdaccio service tokens are never mounted into or exposed as environment variables in the audit container.
- [x] #4 Network egress metadata is captured and attached to the audit evidence bundle.
- [x] #5 The worker destroys the container after completion, timeout, cancellation, or crash, preserving only declared artifacts.
- [x] #6 Container egress permits public internet access through recorded networking while blocking host services, internal/private networks, link-local metadata IPs, Postgres, and Verdaccio admin endpoints.
- [x] #7 The only ModuleWarden-facing capability available inside a container is the run-scoped tool/RPC bridge for its own audit job.
- [x] #8 Audit containers run PI plus package inspection tools, and receive only package artifacts, last-known-good baseline, candidate patch/diff, prepared evidence, run-specific instructions, and run-scoped access tokens.
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. Create Docker container runner service (shells out to docker CLI)\n2. Implement container lifecycle: create, inject inputs, run PI, capture artifacts, destroy\n3. Implement recorded-open egress via docker network config\n4. Wire up pg-boss handler for audit-container-exec jobs\n5. Update audit-runner Dockerfile with all required tools\n6. Write sandbox tests for isolation, cleanup, evidence capture\n7. Commit and push
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
- ContainerRunner: disposable containers with fresh temp workspace per job\n- Only MW_RPC_TOKEN, MW_PACKAGE_NAME, MW_PACKAGE_VERSION env vars injected — no secrets\n- Dedicated bridge network (mw-audit-net) for recorded-open egress\n- --cap-drop=ALL, --read-only, no-new-privileges for container hardening\n- Entrypoint captures env, system info, package listing to /workspace/output/\n- Worker handler creates, monitors, captures artifacts, and destroys each container\n- 6 tests verify isolation, secret absence, evidence capture, cleanup
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Implemented isolated per-job Docker audit runner (TASK-1.6). ContainerRunner service creates disposable containers from the modulewarden-audit-runner image with fresh temp workspaces, run-scoped RPC tokens, and dedicated bridge network for recorded-open egress. Containers are hardened with --cap-drop=ALL, --read-only, --security-opt=no-new-privileges. Entrypoint captures environment metadata (minus secrets), system info, and package inspection output to /workspace/output/ which is preserved as evidence before container destruction. pg-boss handler (audit-container-exec) orchestrates full lifecycle: create, start, poll for completion, capture artifacts, destroy. 6 tests verify isolation, secret absence, evidence capture, and cleanup. Audit-runner Docker image includes git, ripgrep, jq, curl, Python, corepack/pnpm.
<!-- SECTION:FINAL_SUMMARY:END -->

## Definition of Done
<!-- DOD:BEGIN -->
- [x] #1 Sandbox tests verify isolation, absence of forbidden secrets, evidence capture, timeout cleanup, and no container reuse.
<!-- DOD:END -->
