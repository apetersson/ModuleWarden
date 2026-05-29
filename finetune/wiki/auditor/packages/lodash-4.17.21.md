---
node_type: package
name: lodash
version: 4.17.21
verdict: allow
confidence: high
risk_level: none
advisory_ids:
  - CVE-2021-23337
capability_signals: []
attack_chain_depth: 0
threat_actor_class: none
last_seen: 2021-02-20
verdict_source: incident_replay
sft_record_ids:
  - audit_demo_lodash_41721
linked_nodes: []
---

## Summary

Patch release of lodash fixes CVE-2021-23337 (command injection in _.template) and tightens a ReDoS-prone regex. No new capabilities, no install-time behavior added, no dependency changes. Mainstream popular package baseline.

## Key Evidence

- No primary findings recorded for this release.

## Correction Notes

Empty. Confirmed verdict via incident replay.

## SFT Derivation

Seeded from demo incident replay. Eligible to feed the SFT corpus under source `wiki_derived` once the post-audit writer is wired.
