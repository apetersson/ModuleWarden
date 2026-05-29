---
node_type: package
name: postmark-mcp
version: 1.0.12
verdict: allow
confidence: high
risk_level: low
advisory_ids: []
capability_signals: []
attack_chain_depth: 0
threat_actor_class: none
last_seen: 2025-08-04
verdict_source: incident_replay
sft_record_ids:
  - audit_demo_postmark_mcp_1012
linked_nodes: []
---

## Summary

Patch release modifies only the HTTP retry backoff and a test fixture. No capability deltas, no lifecycle changes, no new dependencies, no network egress added. Consistent with the published changelog and the package purpose.

## Key Evidence

- No primary findings recorded for this release.

## Correction Notes

Empty. Confirmed verdict via incident replay.

## SFT Derivation

Seeded from demo incident replay. Eligible to feed the SFT corpus under source `wiki_derived` once the post-audit writer is wired.
