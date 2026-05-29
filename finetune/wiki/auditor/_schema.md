---
node_type: schema
name: auditor-wiki-schema
---

# Auditor Wiki Node Schema

Every node is a markdown file with a YAML front-matter block followed by a
prose body. Seeded by `seed_wiki.py` from `demo/incidents/*.dossier.json`
plus `demo/curated-threat-chains.json`. Read at inference by `query.py`
(BM25 retrieval, top-3 into the audit system prompt).

## Front-matter fields

| field | type | meaning |
|-------|------|---------|
| node_type | string | package, advisory, pattern, false_positive |
| name | string | canonical package name |
| version | string | specific version (omit for package-level nodes) |
| verdict | string | allow, quarantine, block, contested, unknown |
| confidence | string | high, medium, low |
| risk_level | string | none, low, medium, high, critical |
| advisory_ids | list | GHSA / OSV / SSVE ids |
| capability_signals | list | subset of the mapper.py capability keys |
| attack_chain_depth | int | from mapper.py kill_chain_narrative().depth |
| threat_actor_class | string | supply_chain_pivot, credential_thief, etc. |
| last_seen | string | ISO date the version was observed |
| verdict_source | string | incident_replay, sft_feedback, manual_golden |
| sft_record_ids | list | audit_ids from sft-records.jsonl that cite this |
| linked_nodes | list | wikilinks to related nodes |

## Body sections

- `## Summary` what happened, what confirmed it, what the verdict was.
- `## Key Evidence` evidence_ref ids and what they showed.
- `## Correction Notes` empty for confirmed blocks; explains revisions.
- `## SFT Derivation` whether the node fed an SFT record and the source label.

The model reads these nodes as read-only context. Only the pipeline writes
nodes. The verdict is pinned; the model narrates, it does not decide.
