---
id: decision-9
title: >-
  Adopt Stanford Meta-Harness and an LLM-wiki for the models; Decepticon gets
  its own attack-chain wiki; BitGN-PAC is a hardening reference not a meta-harness
date: '2026-05-29 20:10'
status: accepted
---
## Context

Researched three things for ModuleWarden's models: a karpathy/LLM-wiki
knowledge graph for the models, Stanford's Meta-Harness
(https://yoonholee.com/meta-harness/, arXiv:2603.28052,
github.com/stanford-iris-lab/meta-harness), and the BitGN-PAC agent
(github.com/Kanevry/bitgn-pac-agent-public). Full analysis:
`docs/winning-research/06-llm-wiki-for-models.md` and `07-meta-harness-fit.md`.

## Decision

1. LLM-wiki for the models (build-now, ~12h): an auditor wiki at
   `finetune/wiki/auditor/` (markdown+YAML nodes; BM25 query via rank_bm25 (~80
   lines) injects top-3 prior cases into the audit system prompt; post-audit
   nodes feed back as `source="wiki_derived"` SFT rows) and a Decepticon-owned
   wiki at `finetune/wiki/decepticon/` (8 technique nodes one-per-mapper
   capability key, 4 chain nodes seeded from curated-threat-chains.json, a
   `detection_gaps` field). The mapper stays deterministic; the wiki is the
   learn-from-production and offense-feeds-defense layer. Tasks 40, 41.

2. Stanford Meta-Harness: HIGH fit, adopt (task 42). ModuleWarden already has 3
   of the 4 required pieces (a scorer in local_finetune_eval / matrix_runner, a
   held-out task set, the harness files: system.md + gate thresholds +
   dossier/report logic). Missing: a per-case trace format and the proposer
   loop wiring. It auto-optimizes the audit prompt + defense policy against the
   real eval metrics. The "self-improving audit harness" is a judge-rewarded
   angle. 6-10h.

3. BitGN-PAC: NOT a meta-harness and not a knowledge graph (it says so). It is
   the 1st-place winner of the Vienna BitGN PAC hackathon (same scene), MIT.
   Adopt its hardening ring selectively into the audit runner (task 43): B5
   secret-redaction (strip secrets from tarball file contents before they enter
   the audit LLM, highest value), B3 grounding-refs validation (enforce that
   cited evidence IDs exist in the dossier evidence_index), B4 spiral brake
   (max-tool-calls in the PI harness). Do not adopt B2 (PII refusal).

## Consequences

- The wiki closes the auditor's context gap NOW (RAG over precedents) before the
  60GB retraining is feasible, and gives Decepticon a real knowledge surface.
- Meta-Harness gives a genuine self-improving-harness story backed by real eval
  metrics, not a claim.
- BitGN-PAC adoptions are real defense hardening, citable (MIT), but not a
  headline learning-system claim.
- Honesty: wiki post-audit automation, retraining on wiki-derived rows, and the
  full ATT&CK STIX graph are narrate-only at hackathon scale.
