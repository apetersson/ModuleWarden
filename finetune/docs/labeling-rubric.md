# Labeling Rubric

## Verdicts

### `allow`

Use `allow` only when the exact candidate tarball hash is identified and the available evidence supports the package behavior.

Allowed examples:

- A patch release changes docs, tests, or clearly scoped implementation code without new risky capabilities.
- A dependency update is documented, expected, and does not introduce risky install/import behavior.
- A cold-start package has clean metadata, no suspicious install/import traces, no sensitive capability signals, and enough provenance to support initial allow.

Never use `allow` to mean permanently safe. It means the exact package version hash is currently allowed until revoked.

### `quarantine`

Use `quarantine` when evidence is suspicious, ambiguous, missing, or requires agentic follow-up.

Quarantine examples:

- Cold-start package lacks enough provenance or behavioral evidence.
- New lifecycle script, network access, process execution, native/WASM, dynamic execution, obfuscation, or sensitive filesystem/env access appears without convincing release context.
- The changelog does not explain the observed behavior delta.
- A CVE-derived pattern appears but exploitability is not confirmed.
- Dynamic traces show unexpected behavior but not enough proof for block.

`quarantine` is the default for uncertainty.

### `block`

Use `block` when evidence strongly indicates malicious behavior or confirmed exploit behavior.

Block examples:

- Install/import behavior exfiltrates or attempts to exfiltrate tokens, credentials, SSH keys, npm config, cloud metadata, or CI secrets.
- Candidate version matches a known malicious package incident.
- Package uses deceptive dependency indirection, obfuscation, or binary payloads with evidence of harmful behavior.
- Dynamic traces confirm command execution, persistence, sabotage, or credential theft.

## Confidence

- `high`: evidence is direct, cited, and sufficient.
- `medium`: evidence is credible but needs agentic confirmation.
- `low`: evidence is incomplete or mostly heuristic.

## Risk Level

- `none`: no material risk found.
- `low`: minor suspicious signal with benign explanation.
- `medium`: suspicious signal requiring follow-up.
- `high`: strong supply-chain risk signal.
- `critical`: confirmed or near-confirmed harmful behavior.

## Finding Requirements

Every `primary_findings` item must:

- use a controlled category from `finding-taxonomy.md`;
- cite one or more evidence IDs from the dossier;
- make a specific claim;
- explain why the claim matters for package supply-chain risk.

Do not invent evidence references. If evidence is missing, cite the relevant missing/insufficient context as a finding.

## Cold-Start Rule

Cold starts are not normal diffs. Because there is no previously allowed predecessor, labelers should require stronger provenance and dynamic evidence for `allow`.

Default cold-start behavior:

- clean provenance plus clean behavior: `allow`;
- missing provenance or unexplained sensitive behavior: `quarantine`;
- confirmed harmful behavior: `block`.

## Benign Neighbor Rule

Benign neighboring versions are important negative examples. Do not overfit to package reputation or advisory association.

If a neighboring version lacks the suspicious behavior and no other evidence indicates risk, label it `allow` even when the same package has a malicious or vulnerable version elsewhere.

## CVE-Derived Diff Rule

CVE-derived cases teach dangerous code shapes, not necessarily maintainer compromise.

Use:

- `quarantine` for vulnerability-introducing patterns without confirmed malicious intent;
- `block` only when exploit behavior is confirmed or the version is known malicious;
- `allow` for fixed versions when the evidence shows the risky behavior was removed and no new suspicious capability appears.
