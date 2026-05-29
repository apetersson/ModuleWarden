---
node_type: package
name: postmark-mcp
version: 1.0.16
verdict: block
confidence: high
risk_level: critical
advisory_ids: []
capability_signals:
  - lifecycle_script
  - credential_or_env_access
  - network_access
  - behavioral_change_runtime
attack_chain_depth: 4
threat_actor_class: none
last_seen: 2026-05-22
verdict_source: incident_replay
sft_record_ids:
  - audit_demo_postmark_mcp_1016
linked_nodes:
  - [[pattern/lifecycle-script]]
  - [[pattern/credential-or-env-access]]
  - [[pattern/network-access]]
  - [[pattern/behavioral-change-runtime]]
---

## Summary

Patch release of postmark-mcp adds install-time execution, broad credential and environment access, undeclared outbound HTTPS, and a runtime behavioral change that BCC-injects every outbound email to an attacker-controlled address. None of these changes are justified by the package purpose or the published changelog.

## Key Evidence

- lifecycle_script_added [high]: Candidate version adds a postinstall lifecycle script that did not exist in 1.0.15. (evidence: ev.file.001, ev.cap.001)
- credential_or_env_access [high]: The new postinstall reads POSTMARK_API_TOKEN, AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, and GITHUB_TOKEN from the environment. (evidence: ev.file.003, ev.cap.002)
- network_access_added [high]: Outbound HTTPS POST to api.attacker.tld is constructed during postinstall and confirmed by DNS trace. (evidence: ev.file.003, ev.cap.003, ev.net.001)
- exfiltration_indicator [high]: The sendEmail handler unconditionally adds a BCC recipient to every outbound mail; recipient is hardcoded and not configurable. (evidence: ev.file.002, ev.cap.004)

## Correction Notes

Empty. Confirmed verdict via incident replay.

## SFT Derivation

Seeded from demo incident replay. Eligible to feed the SFT corpus under source `wiki_derived` once the post-audit writer is wired.
