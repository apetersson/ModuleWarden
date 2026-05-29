---
id: TASK-33
title: Ship injection-hardening + activation-steering for the audit LLM
status: Done
assignee: []
created_date: '2026-05-29 11:56'
labels:
  - finetune
  - security
  - saturday-afternoon
dependencies: []
ordinal: 49000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Defense-in-depth so the auditor resists prompt injection in untrusted package text, not just the gate. (1) ingestion normalize strips invisible-unicode smuggling, wired into corpus_walker; (2) adversarial SFT data generator keeps the gold label structural under injection, CLI at 10-20pct rate per StruQ/SecAlign; (3) injection-robustness metric (flip-rate/ASR/WAVS) per decision-4; (4) activation-steering harness (Turner 2308.10248) computes a security-skeptical steering vector at inference, gpt2-tested, ready to point at the Qwen checkpoint and sweep with the robustness metric. Activation steering chosen as the inference layer; training-time adversarial data is primary. Steering resources evaluated: gemini-cli model-steering and ExploitBench skipped as off-domain.
<!-- SECTION:DESCRIPTION:END -->
