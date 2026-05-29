---
id: TASK-41
title: Decepticon-owned attack-chain wiki (offense-feeds-defense)
status: Done
assignee: []
created_date: '2026-05-29 20:12'
labels: [wiki, decepticon]
dependencies: [TASK-44]
ordinal: 57000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Build Decepticon's own knowledge graph at `finetune/wiki/decepticon/` (design in `docs/winning-research/06-llm-wiki-for-models.md`): subdirs techniques/, chains/, threat-actors/, package-patterns/. Seed 8 ATT&CK technique nodes (one per mapper.py capability key) and 4 named chain nodes (supply-chain-pivot, credential-thief, crypto-miner, typosquat-operator) from curated-threat-chains.json `attack_chain` phases, via `seed_decepticon_wiki.py`. Technique nodes carry a `detection_gaps` field (where mapper.py's static lookup is blind, e.g. WebSocket exfil, env-conditional payloads). Chain nodes carry `insurance_rider` + `estimated_blast_radius_usd` - wire these into chat/agent.py's underwriter memo (~20 lines).

Offense-feeds-defense loop: `gap_reporter.py` reads technique `detection_gaps` into gap_list.json, a human extends mapper.py's `_CAPABILITY_TO_ATTACK`, decepticon_augmentor.py re-runs. The mapper stays deterministic throughout. Build-now ~4h for seeds + memo wiring; gap_reporter automation is narrate-only.
<!-- SECTION:DESCRIPTION:END -->
