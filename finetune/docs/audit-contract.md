# Audit Dossier and Report Contract

## Purpose

The fine-tuned model is a one-shot package-diff auditor. It receives a prepared `AuditDossier` and returns an `AuditReport`.

This is not a raw-code free-form review. Deterministic ModuleWarden preprocessors should create stable evidence references for package metadata, diffs, capability deltas, install/import traces, network observations, and release context. The model must cite those references when making claims.

## Input: AuditDossier

An `AuditDossier` represents one audit target.

Required high-level fields:

- `schema_version`: currently `modulewarden.audit_dossier.v1`.
- `audit_id`: stable run identifier.
- `audit_mode`: `version_diff`, `cold_start`, `re_audit`, `override_revalidation`, or `incident_replay`.
- `ecosystem`: currently `npm`.
- `package`: candidate package identity and tarball integrity.
- `baseline`: previous allowed version, no predecessor, or re-audit baseline.
- `release_context`: purpose, changelog/readme summary, repository context, and source mismatch signal.
- `diff_summary`: file-level change summary.
- `dependency_changes`: direct dependency additions/removals/updates.
- `capability_deltas`: new or materially changed capability signals.
- `dynamic_observations`: install/import/network evidence references.
- `evidence_index`: all evidence IDs the report is allowed to cite.
- `policy_context`: decision defaults and output restrictions.

## Output: AuditReport

An `AuditReport` is the model output used by ModuleWarden policy and PI follow-up.

Required high-level fields:

- `schema_version`: currently `modulewarden.audit_report.v1`.
- `audit_id`: must match the dossier.
- `verdict`: `allow`, `quarantine`, or `block`.
- `confidence`: `low`, `medium`, or `high`.
- `risk_level`: `none`, `low`, `medium`, `high`, or `critical`.
- `summary`: concise evidence-grounded finding summary.
- `primary_findings`: claims with controlled categories and evidence references.
- `benign_explanations_considered`: plausible benign explanations and why they do or do not hold.
- `recommended_agent_checks`: follow-up checks for PI.
- `developer_safe_summary`: safe package-manager/CLI wording.
- `security_admin_summary`: richer operational summary.
- `output_integrity`: self-check for evidence citation validity.

## Policy Expectations

The model should prefer `quarantine` when:

- evidence is missing or ambiguous;
- a cold-start package has insufficient provenance or behavioral evidence;
- package behavior materially expands beyond the package purpose;
- install-time behavior, credential access, network access, dynamic execution, native/WASM, or obfuscation is introduced without convincing release context.

The model should use `block` when:

- evidence strongly indicates malicious behavior, exfiltration, sabotage, or deceptive indirection;
- a known incident replay version matches the suspicious behavior;
- dynamic traces confirm harmful install/import behavior.

The model should use `allow` only when:

- the candidate tarball hash is identified;
- the predecessor or cold-start evidence is sufficient for the mode;
- suspicious deltas are absent or convincingly explained;
- claims are grounded in cited evidence.

An `allow` means only that the exact package version hash is currently allowed until revoked.

## Agentic Follow-Up

The one-shot report is a triage and briefing artifact. PI can run inside the isolated audit container with the package under audit, predecessor baseline, patch/diff, prepared evidence, run-specific instructions, and audit tools.

PI should use the one-shot report to focus tool use, but it may confirm, refine, or overturn the report.
