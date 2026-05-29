---
id: TASK-43
title: Adopt BitGN-PAC hardening (B5 secret-redaction, B3 grounding-refs, B4 spiral-brake)
status: Done
assignee: []
created_date: '2026-05-29 20:14'
labels: [security, hardening, audit-runner]
dependencies: []
ordinal: 59000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Adopt three hardening patterns from the BitGN-PAC agent (github.com/Kanevry/bitgn-pac-agent-public, MIT, 1st place at the Vienna BitGN PAC hackathon; fit analysis in `docs/winning-research/07-meta-harness-fit.md`). BitGN-PAC is NOT a meta-harness, do not frame it as one; these are defense-in-depth references for the agentic audit path.

- B5 secret-redaction (highest value): add `redact_secrets(text)` to `finetune/python/data/ingestion_hardening.py` (high-precision regexes for AWS keys, GitHub tokens, Anthropic/OpenAI creds, JWT, PEM). Call it on tool output BEFORE it re-enters the audit LLM context. The audit runner reads package source/READMEs that may carry real secrets; this stops them leaking into the audit log.
- B3 grounding-refs validation: after generation, compare the report's cited evidence IDs against the dossier `evidence_index` keys; flag or re-request on any cited ID not present. The system prompt says "cite only evidence ids from the index" but nothing enforces it at runtime.
- B4 spiral brake: add a max-tool-calls counter to the PI agentic harness so a crafted README cannot trigger a tool-call runaway.

Do NOT adopt B2 (PII refusal) - not applicable. Effort: 1-2h each. MIT-licensed, citable in architecture notes.
<!-- SECTION:DESCRIPTION:END -->
