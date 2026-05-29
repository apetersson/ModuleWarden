---
node_type: chain
chain_name: supply-chain-pivot
threat_actor_class: supply_chain_pivot
technique_sequence:
  - T1195.002
  - T1059.007
  - T1552.001
  - T1041
depth: 4
observed_packages:
  - event-stream@3.3.6
estimated_blast_radius_usd: 15000000
insurance_rider: cyber_extortion_and_data_breach
preconditions:
  - Maintainer account accessible to attacker (ownership transfer or token reuse)
  - Package has high weekly install count (supply-chain leverage)
  - Downstream consumer matches a specific env or wallet pattern
---

## Chain Narrative

### event-stream@3.3.6
- [RECON] dependency_graph: Package has 1 dependency: flatmap-stream@0.1.1 (unusual transitive add)
- [RECON] maintainer_osint: Original maintainer (dominictarr) transferred ownership to 'right9ctrl' after burnout
- [EXPLOIT] static_analysis: flatmap-stream v0.1.1 contains AES-256 encrypted payload targeting require() of 'copay-dash'
- [EXPLOIT] behavioral_trace: Payload decrypts only when process.env.npm_package_description matches Bitcoin wallet regex
- [POST-EX] network_forensics: Exfiltrates private keys + wallet seeds to 111.90.151.134:8080 via HTTPS POST
- [POST-EX] blast_radius: 3.2M weekly installs at peak; Copay wallet users lost ~$15M+ in aggregated crypto assets

## Preconditions for Auditor

Fields the auditor model should look for to elevate suspicion when this chain is partially matched.

- Maintainer account accessible to attacker (ownership transfer or token reuse)
- Package has high weekly install count (supply-chain leverage)
- Downstream consumer matches a specific env or wallet pattern
