# Finding Taxonomy

Use these controlled values in `AuditReport.primary_findings[].category`.

## High-Risk Capability Findings

- `lifecycle_script_added`: A new or materially changed npm lifecycle script.
- `credential_or_env_access`: New access to environment variables, tokens, credentials, config secrets, or CI secrets.
- `network_access_added`: New outbound network behavior or new network-capable dependency path.
- `process_execution_added`: New shell command, child process, binary execution, or spawn behavior.
- `filesystem_sensitive_access`: New access to home directories, SSH/npm/git config, lockfiles, keychains, or broad filesystem traversal.
- `dynamic_code_execution`: New `eval`, `Function`, dynamic import, runtime code generation, or opaque loader behavior.
- `obfuscation_added`: Minified, encoded, packed, or intentionally hard-to-review payloads added to a package that was previously readable.
- `native_or_wasm_added`: New native binary, prebuild, postinstall binary download, or WASM artifact.
- `dependency_indirection`: New dependency, transitive path, registry indirection, tarball URL, git dependency, or maintainer-controlled helper that moves risky behavior outside the package diff.

## Provenance and Intent Findings

- `source_tarball_mismatch`: Published tarball materially diverges from repository source, tags, or release notes.
- `repository_or_maintainer_anomaly`: Repository, maintainer, publishing account, or ownership signals changed suspiciously.
- `release_context_mismatch`: Claimed changelog/release purpose does not justify the observed behavior delta.
- `semver_risk_mismatch`: A patch or minor release introduces behavior normally expected in a major change.
- `cold_start_insufficient_evidence`: Cold-start package lacks enough provenance or behavioral evidence for allow.

## Dynamic Observation Findings

- `install_time_behavior`: Install scripts or install-time imports perform meaningful actions.
- `import_time_behavior`: Requiring/importing the package performs unexpected side effects.
- `network_trace_observed`: DNS or connection metadata indicates outbound behavior.
- `exfiltration_indicator`: Dynamic or static evidence suggests credential/data exfiltration.

## Benign or Mitigating Findings

- `benign_change`: Evidence supports a harmless or expected change.
- `documented_behavior`: Changelog/release notes clearly explain the behavior delta.
- `test_or_build_only`: Risky-looking code appears constrained to tests/build artifacts and is not shipped or executed in normal install/import paths.

## Severity Values

Use one of:

- `info`
- `low`
- `medium`
- `high`
- `critical`

## Verdict Guidance

- `allow`: no material suspicious behavior, or suspicious-looking behavior is convincingly explained and bounded.
- `quarantine`: uncertainty, insufficient evidence, unexplained capability expansion, or high-risk static signal requiring agentic checks.
- `block`: confirmed or strongly evidenced malicious behavior, exfiltration, sabotage, deceptive indirection, or replayed known-bad behavior.
