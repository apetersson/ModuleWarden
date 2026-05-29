---
node_type: schema
name: decepticon-wiki-schema
---

# Decepticon Wiki Node Schema

Decepticon's offensive knowledge graph. Seeded by `seed_decepticon_wiki.py`
from `demo/curated-threat-chains.json` plus the technique table in
`finetune/python/decepticon/mapper.py`. The defensive auditor consumes only
what is derived from this graph; it never reads the offensive graph directly.

## Technique node (techniques/T*.md)

| field | type | meaning |
|-------|------|---------|
| node_type | string | technique |
| technique_id | string | ATT&CK technique id |
| technique_name | string | ATT&CK technique name |
| tactic | string | ATT&CK tactic |
| mapper_capability_key | string | the key in mapper.py that maps to this |
| observed_packages | list | wikilinks to package nodes |
| observed_chains | list | wikilinks to chain nodes |
| detection_gaps | list | where the mapper.py static lookup is blind |
| variant_count | int | known procedure variants |
| last_updated | string | ISO date |

## Chain node (chains/*.md)

| field | type | meaning |
|-------|------|---------|
| node_type | string | chain |
| chain_name | string | named chain (supply-chain-pivot, etc.) |
| threat_actor_class | string | supply_chain_pivot, credential_thief, etc. |
| technique_sequence | list | ordered ATT&CK technique ids |
| depth | int | kill-chain phase count |
| observed_packages | list | package@version strings |
| estimated_blast_radius_usd | int | from curated-threat-chains.json |
| insurance_rider | string | from curated-threat-chains.json |
| preconditions | list | what must be true for the chain to trigger |

## Body sections

Technique: Technique Description, Observed Package Instances, Detection Gaps,
Procedure Variants. Chain: Chain Narrative, Preconditions for Auditor.

The mapper stays deterministic. `detection_gaps` records what the lookup
misses; that field feeds future `_CAPABILITY_TO_ATTACK` extension PRs. The
automation (gap_reporter.py) is narrate-only at hackathon scale.
