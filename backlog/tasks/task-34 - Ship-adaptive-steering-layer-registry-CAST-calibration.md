---
id: TASK-34
title: 'Ship adaptive steering layer: registry + CAST + calibration'
status: Done
assignee: []
created_date: '2026-05-29 12:36'
labels: []
dependencies: []
ordinal: 50000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Defense that updates after the SFT checkpoint is frozen, no retrain. steering/registry.py (versioned vectors keyed by attack family + clean-accuracy evidence), steering/conditional.py (CAST detector-gated steering), steering/calibrate.py (coefficient sweep with clean-accuracy guardrail). 11 tests green. Answers the UNIQA-track 'control adapts to new attacks without re-certifying a new model' pitch.
<!-- SECTION:DESCRIPTION:END -->
