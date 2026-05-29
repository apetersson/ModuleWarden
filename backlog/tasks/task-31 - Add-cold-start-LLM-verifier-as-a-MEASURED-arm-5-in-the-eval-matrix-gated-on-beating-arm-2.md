---
id: TASK-31
title: >-
  Add cold-start LLM verifier as a MEASURED arm-5 in the eval matrix (gated on
  beating arm-2)
status: To Do
assignee: []
created_date: '2026-05-29 06:23'
labels:
  - finetune
  - eval
  - roadmap
  - decision-4
dependencies: []
priority: medium
ordinal: 47000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Per decision-4: do NOT add a blind LLM verifier. If added, it ships as a measured fifth arm in finetune/python/eval/matrix_runner.py, not as an assumed win. The verifier is a second model call that receives ONLY the audit_dossier.v1 JSON plus the verdict spec (cold-start, no producer reasoning trace, per the Mavis pattern). Keep arm-5 only if the matrix shows it beats arm-2 (fine-tuned one-shot) on malicious_catch_rate without raising false_quarantine_block_rate, and only if the added latency/token cost is justified by the delta. Stanford's subtraction-principle result (verifiers can hurt) is the reason this is gated, not assumed. Deferred until a Saturday SFT checkpoint exists to measure against. The deterministic 5-rule gate remains the primary, compute-free, injection-proof verifier regardless of arm-5's outcome.
<!-- SECTION:DESCRIPTION:END -->
