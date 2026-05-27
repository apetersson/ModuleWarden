---
id: TASK-1.13
title: Create real-incident replay evaluation harness and quality metrics
status: To Do
assignee: []
created_date: '2026-05-27 17:19'
labels:
  - evaluation
  - security
  - v1
dependencies:
  - TASK-1.7
  - TASK-1.9
  - TASK-1.10
  - TASK-1.16
parent_task_id: TASK-1
priority: high
ordinal: 14000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Build the proof loop for the product thesis.

The selected proof standard is attack replay using real compromised-package or malicious-version incidents plus adjacent benign versions as controls. The pass bar is to catch every high-confidence critical replay attack in the seed corpus with explainable evidence, accepting some manual-review or quarantine noise early. False positives, quarantine rate, model escalation impact, scores, and developer-facing consequences must be measured rather than hand-waved.

This harness should not overclaim “novel vulnerability discovery.” It proves whether ModuleWarden catches known classes of compromised maintainer/package-version attacks and creates the measurement bed for improving agentic prompts over time.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 Corpus entries can define package name, benign predecessor, malicious/suspicious version, benign control versions, expected behavior, and incident notes.
- [ ] #2 Evaluation runs use the same audit container, PI harness, prompts, tools, and verdict policy as production runs.
- [ ] #6 Evaluation can run through the same pg-boss-backed job pipeline as production, while also supporting a deterministic single-run mode for local debugging.
- [ ] #3 Reports separate caught/block, quarantine, missed, false-positive block/quarantine, escalation usage, and evidence quality.
- [ ] #4 Scores from both first-pass and escalation runs are retained for later threshold and prompt calibration.
- [ ] #5 The initial pass criterion is documented as catch all critical seed incidents with explainable evidence, not zero false positives.
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
Create an evaluation runner that loads a curated corpus manifest, reconstructs predecessor/malicious/benign version pairs, runs the same audit pipeline used in production, and emits precision/recall/quarantine/escalation metrics plus evidence links.
<!-- SECTION:PLAN:END -->

## Definition of Done
<!-- DOD:BEGIN -->
- [ ] #1 A documented seed corpus exists and can be run locally from Docker Compose or a CI job.
<!-- DOD:END -->
