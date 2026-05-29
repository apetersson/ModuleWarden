---
id: TASK-44
title: Auditor LLM-wiki with BM25 RAG into the audit prompt
status: Done
assignee: []
created_date: '2026-05-29 20:11'
labels: [wiki, model, finetune]
dependencies: []
ordinal: 56000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Build the auditor knowledge-graph wiki (design in `docs/winning-research/06-llm-wiki-for-models.md`). `finetune/wiki/auditor/` holds markdown+YAML nodes (packages, advisories, patterns, false-positives) with fields capability_signals, verdict, advisory_ids, sft_record_ids, linked_nodes (wikilinks). Add `query.py` (~80 lines, rank_bm25) that injects the top-3 matching prior cases into the audit system prompt before each audit. Seed from demo/incidents (3 nodes) and curated-threat-chains.json (10 nodes) via `seed_wiki.py`. Close the learn-from-production loop: a post-audit node feeds back into the SFT corpus as `source="wiki_derived"` (one-line addition to sft_pair_builder.py).

Build-now ~6-8h. Demo story: "the auditor consulted 3 prior cases." Honest scope: the post-audit auto-writer + retraining on wiki_derived rows are narrate-only at hackathon scale.
<!-- SECTION:DESCRIPTION:END -->
