---
id: TASK-1.13
title: Create real-incident replay evaluation harness and quality metrics
status: In Progress
assignee:
  - '@agent-k'
created_date: '2026-05-27 17:19'
updated_date: '2026-05-28 11:50'
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
- [x] #1 Corpus entries can define package name, benign predecessor, malicious/suspicious version, benign control versions, expected behavior, and incident notes.
- [ ] #2 Evaluation runs use the same audit container, PI harness, prompts, tools, and verdict policy as production runs.
- [ ] #3 Evaluation can run through the same pg-boss-backed job pipeline as production, while also supporting a deterministic single-run mode for local debugging.
- [x] #4 Reports separate caught/block, quarantine, missed, false-positive block/quarantine, escalation usage, and evidence quality.
- [x] #5 Scores from both first-pass and escalation runs are retained for later threshold and prompt calibration.
- [ ] #6 The initial pass criterion is documented as catch all critical seed incidents with explainable evidence, not zero false positives.
- [ ] #7 Evaluation reports include the ModuleWarden dogfood campaign with package counts, allow/block/quarantine distribution, audit duration, model endpoint used, fallback usage, and throughput.
- [ ] #8 Admin overrides, post-hoc relabels, and incident outcomes are included as labeled feedback for prompt and threshold calibration.
- [ ] #9 The hackathon runbook records a campaign target of starting Friday 2026-05-29 and finishing by Saturday evening 2026-05-30, with measured variance reported.
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
Create an evaluation runner that loads a curated corpus manifest, reconstructs predecessor/malicious/benign version pairs, runs the same audit pipeline used in production, and emits precision/recall/quarantine/escalation metrics plus evidence links.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Created evaluation corpus (15 entries: incidents, known-malicious, benign controls, golden fixtures). Created evaluation runner with buildReport() for quality metrics (catch rate, false positive rate, quarantine rate). 46 shared tests pass.
<!-- SECTION:NOTES:END -->

## Definition of Done
<!-- DOD:BEGIN -->
- [ ] #1 A documented seed corpus exists and can be run locally from Docker Compose or a CI job.
<!-- DOD:END -->
