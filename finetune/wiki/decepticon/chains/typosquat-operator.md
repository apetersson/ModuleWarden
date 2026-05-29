---
node_type: chain
chain_name: typosquat-operator
threat_actor_class: typosquat_operator
technique_sequence:
  - T1195.002
  - T1059.007
  - T1041
depth: 3
observed_packages:
  - rc@1.2.9
  - coa@2.0.3
estimated_blast_radius_usd: 1200000
insurance_rider: supply_chain_contamination
preconditions:
  - Sudden major version bump with no changelog or matching commits
  - Author email shared with other malicious packages in the same campaign
  - High-entropy minified blob that deobfuscates to a fetch+eval loop
---

## Chain Narrative

### rc@1.2.9
- [RECON] typo_analysis: Not a typosquat of 'rc' itself, but published alongside coa and ua-parser-js in coordinated campaign
- [RECON] metadata_analysis: Author email matches other malicious packages in same timeframe
- [EXPLOIT] static_analysis: Minified blob with high string entropy (6.8 bits/char); deobfuscates to fetch+eval loop
- [POST-EX] blast_radius: Low individual impact but high signal-to-noise for detection training
### coa@2.0.3
- [RECON] typo_analysis: Name 'coa' is legitimate CLI option parser; v2.0.3 published by compromised account
- [RECON] version_history: Sudden major version bump with no changelog; no commits on GitHub matching publish date
- [EXPLOIT] static_analysis: postinstall script fetches remote binary and chmod +x executes it
- [EXPLOIT] behavioral_trace: Binary contacts C2 every 60s awaiting commands (suggesting botnet recruitment)
- [POST-EX] blast_radius: Part of same campaign as rc@1.2.9; combined installs ~500K before takedown

## Preconditions for Auditor

Fields the auditor model should look for to elevate suspicion when this chain is partially matched.

- Sudden major version bump with no changelog or matching commits
- Author email shared with other malicious packages in the same campaign
- High-entropy minified blob that deobfuscates to a fetch+eval loop
