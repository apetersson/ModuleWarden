---
node_type: chain
chain_name: credential-thief
threat_actor_class: credential_thief
technique_sequence:
  - T1027
  - T1059
  - T1552.001
  - T1041
depth: 4
observed_packages:
  - eslint-scope@3.7.2
estimated_blast_radius_usd: 8000000
insurance_rider: business_interruption_and_credential_theft
preconditions:
  - Compromised npm publish token bypassing 2FA
  - Obfuscated loader hooks module._compile to intercept require()
  - Reads ~/.npmrc or credential files at install or runtime
---

## Chain Narrative

### eslint-scope@3.7.2
- [RECON] version_diff: v3.7.2 adds 1,200 lines of obfuscated code not present in v3.7.1
- [RECON] maintainer_osint: Compromised npm publish token  -  attacker bypassed 2FA via token reuse
- [EXPLOIT] static_analysis: Obfuscated loader hooks into module._compile to intercept require() calls
- [EXPLOIT] behavioral_trace: Harvests ~/.npmrc auth tokens and sends base64 blob to pastebin-like drop
- [POST-EX] lateral_movement: Stolen npm tokens used to publish further compromised packages (eslint-config-eslint, etc.)
- [POST-EX] blast_radius: Widespread CI/CD compromise; any build pulling eslint-scope leaked registry credentials

## Preconditions for Auditor

Fields the auditor model should look for to elevate suspicion when this chain is partially matched.

- Compromised npm publish token bypassing 2FA
- Obfuscated loader hooks module._compile to intercept require()
- Reads ~/.npmrc or credential files at install or runtime
