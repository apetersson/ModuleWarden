---
id: TASK-1.14
title: >-
  Add security tests for prompt secrecy, secret isolation, and malicious package
  behavior
status: To Do
assignee: []
created_date: '2026-05-27 17:19'
labels:
  - security-tests
  - prompts
  - sandbox
  - v1
dependencies:
  - TASK-1.6
  - TASK-1.7
  - TASK-1.8
  - TASK-1.10
parent_task_id: TASK-1
priority: high
ordinal: 15000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Test the adversarial assumptions that make the product credible.

The strongest v1 moat is private prompt/rubric secrecy plus isolated evidence-rich audit runs. That means prompt leakage, secret leakage, package-controlled prompt injection, and sandbox escape-by-configuration are product-breaking failures.

Test packages should attempt to read environment variables, discover mounted files, exfiltrate data, print instructions to override the auditor, trigger network calls, modify shared state, and cause misleading reports. The expected outcome is not that every package is magically safe, but that the audit environment contains no sensitive secrets and the report correctly treats suspicious behavior as evidence.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 A package cannot access core prompts, model API credentials, DB credentials, Verdaccio service token, or unrelated run workspaces from inside the audit container.
- [ ] #2 Prompt-injection text inside package files, README, changelog, scripts, or generated output does not cause core prompts or secrets to appear in stored or user-facing output.
- [ ] #3 Network exfiltration attempts are captured as evidence and do not receive sensitive data to exfiltrate.
- [ ] #4 A malicious audit run cannot alter decisions for other package versions except through authenticated run-scoped verdict submission for its own job.
- [ ] #5 Logs and evidence shown to developers are redacted while preserving enough detail for security admins to investigate.
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
Create adversarial fixtures and integration tests that run through the real audit container and PI harness. Add redaction tests for CLI/API/UI outputs and evidence artifacts.
<!-- SECTION:PLAN:END -->

## Definition of Done
<!-- DOD:BEGIN -->
- [ ] #1 Security tests run in CI and fail closed on secret/prompt leakage.
<!-- DOD:END -->
