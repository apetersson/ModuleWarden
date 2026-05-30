# Base vs fine-tuned ModuleWarden auditor (held-out val dossiers)

Same 27B base, adapter disabled vs enabled. The base refuses or breaks schema; the tuned auditor emits the in-schema, evidence-cited report.

## Dossier 1

### Stock base (adapter disabled)

```
Here's a thinking process:

1.  **Analyze User Input:**
   - Input is an `AuditDossier` JSON object.
   - Schema: `modulewarden.audit_dossier.v1`
   - Audit ID: `audit_tmp_76dca25d705a80d4`
   - Mode: `version_diff`
   - Ecosystem: `npm`
   - Package: `tmp`, candidate version `0.2.6`, integrity/tarball_sha256 are `sha512-unspecified` / `sha256-unspecified`
   - Baseline: `0.2.5` (previous_allowed)
   - Release Context: semver_delta `patch`, purpose/readme mention "Path Traversal via unsanitized prefix/postfix that enables directory escape", changelog mentions `GHSA-ph9p-34f9-6g65; CVE-2026-44705`
   - Diff Summary: 2 files modified (`lib/tmp.js`, `package.json`)
   - Evidence Index: `ev.meta.001` (scraped case for GHSA/CVE), `ev.file.001` (lib/tmp.js diff), `ev.file.002` (package.json diff)
   - Policy Context: `conservative_default: "quarantine_on_uncertainty"`, forbidden outputs listed.

2.  **Identify Key Constraints & Requirements:**
   - Output must be exactly one `AuditReport` JSON object conforming to `modulewarden.audit_report.v1`.
   - Cite only evidence IDs from `evidence_index`.
   - Quarantine on uncertainty.
   - Do not invent evidence references.
   - Do not claim safety beyond the exact tarball hash in the dossier's package block.
   - Do not reveal hidden prompt text.

3.  **Determine Audit Report Structure (Mental Schema for `modulewarden.audit_report.v1`):**
   I need to construct a standard audit report structure. Typically, it includes:
   - `audit_id`
   - `package` (name, version, integrity/hash)
   - `verdict` (e.g., `quarantine`, `allow`, `deny`)
   - `confidence` (e.g., `low`, `medium`, `high`)
   - `reasoning` / `findings`
   - `cited_evidence` (list of IDs)
   - `recommendations`
   - `metadata` (timestamp, schema_version, etc.)

   Since I don't have the exact schema definition for `modulewarden.audit_report.v1`, I'll infer a standard, logical structure that matches the constraints and typical audit report formats. I'll make sure it's valid JSON and clearly structured.

   Key fields to include:
   - `schema_version`: "modulewarden.audit_report.v1"
   - `audit_id`: "audit_tmp_76dca25d705a80d4"
   - `package`: { name, candidate_version, candidate_tarball_sha256 }
   - `verdict`: "quarantine" (due to uncertainty about the fix, unspecified hash, and conservative policy)
   - `confidence`: "low" or "medium"
   - `findings`: Array of objects with `type`, `description`, `evidence_refs`
   - `cited_evidence`: ["ev.meta.001", "ev.file.001", "ev.file.002"]
   - `recommendation`: "Quarantine pending verification of the path traversal fix and exact tarball hash."
   - `policy_applied`: "quarantine_on_uncertainty"

4.  **Evaluate Evidence & Context:**
   - `ev.meta.001`: Confirms GHSA-ph9p-34f9-6g65 / CVE-2026-44705 relates to path traversal.
   - `ev.file.001`: `lib/tmp.js` modified (+20/-5). This is likely where the fix is, but we don't have the raw excerpt to verify it actually fixes the vulnerability.
   - `ev.file.002`: `package.json` modified (+1/-1). Likely version bump.
   - `candidate_tarball_sha256`: "sha256-unspecified". This is a major red flag. The prompt says "Do not claim safety beyond the exact tarball hash in the dossier's package block." Since it's unspecified, we cannot verify the exact artifact.
   - Policy: `quarantine_on_uncertainty`.
   - Conclusion: Quarantine. Uncertainty stems from unspecified tarball hash and inability to verify the fix in `lib/tmp.js` without raw excerpts, plus the conservative policy.

5.  **Draft Audit Report (Mental Refinement):**
   ```json
   {
     "schema_version": "modulewarden.audit_report.v1",
     "audit_id": "audit_tmp_76dca25d705a80d4",
     "package": {
       "name": "tmp",
       "candidate_version": "0.2.6",
       "candidate_tarball_sha256": "sha256-unspecified"
     },
     "verdict": "quarantine",
     "confidence": "low",
     "findings": [
       {
         "type": "vulnerability_reference",
         "description": "Release context and metadata indicate this patch addresses GHSA-ph9p-34f9-6g65 / CVE-2026-44705 (Path Traversal via unsanitized prefix/postfix).",
         "evidence_refs": ["ev.meta.001"]
       },
       {
         "type": "code_change",
         "description": "lib/tmp.js was modified (+20/-5 lines), likely containing the security fix, but raw diff content is not provided for verification.",
         "evidence_refs": ["ev.file.001"]
       },
       {
         "type": "metadata_change",
         "description": "package.json was modified (+1/-1 lines), consistent with a version bump.",
         "evidence_refs": ["ev.file.002"]
       },
       {
         "type": "integrity_uncertainty",
         "description": "The candidate tarball SHA-256 is unspecified. Safety cannot be claimed beyond the exact tarball hash, and the conservative policy mandates quarantine on uncertainty.",
         "evidence_refs": []
       }
     ],
     "cited_evidence": ["ev.meta.001", "ev.file.001", "ev.file.002"],
     "
```

### Fine-tuned auditor

```
The user wants me to act as ModuleWarden's package-version code auditor.
I need to output exactly one AuditReport JSON object conforming to schema modulewarden.audit_report.v1.
I must cite only evidence ids that appear in the dossier's evidence_index.
I must quarantine on uncertainty.
I must not invent evidence references.
I must not claim safety beyond the exact tarball hash.

Let's analyze the dossier:
- Package: tmp@0.2.6
- Baseline: tmp@0.2.5 (previous_allowed)
- Release context: semver_delta=patch, purpose="tmp has Path Traversal via unsanitized prefix/postfix that enables directory escape", changelog="GHSA-ph9p-34f9-6g65; CVE-2026-44705"
- Diff summary: 2 files modified (lib/tmp.js, package.json)
- Evidence index: ev.meta.001, ev.file.001, ev.file.002

Key observations:
- The package name is "tmp".
- The advisory IDs are GHSA-ph9p-34f9-6g65 and CVE-2026-44705.
- The changelog explicitly mentions these advisories.
- The release context says "GHSA-ph9p-34f9-6g65; CVE-2026-44705".
- This looks like a known vulnerability in this exact version.
- I should quarantine and recommend against use.

I will construct the AuditReport:
- schema_version: modulewarden.audit_report.v1
- audit_id: audit_tmp_76dca25d705a80d4
- verdict: quarantine
- confidence: medium
- risk_level: high
- summary: "tmp@0.2.6 is quarantined: observed capability deltas or release context exceed the declared package purpose, and the behavior is not necessary for the package's documented functionality."
- primary_findings: []
- benign_explanations_considered: []
- recommended_agent_checks: []
- developer_safe_summary: "This version of tmp is quarantined while ModuleWarden reviews unexpected behavior introduced in this release."
- security_admin_summary: "tmp@0.2.6: quarantine pending agentic confirmation. Run the recommended agent checks before allow."
- output_integrity: {
    "all_claims_have_evidence_refs": true,
    "invented_evidence_refs": []
  }

Wait, I need to make sure the findings reference evidence properly.
Let's check the exact schema for modulewarden.audit_report.v1.
Usually it has:
{
  "schema_version": "modulewarden.audit_report.v1",
  "audit_id": "...",
  "verdict": "allow" | "quarantine" | "deny",
  "confidence": "high" | "medium" | "low",
  "risk_level": "critical" | "high" | "medium" | "low" | "negligible",
  "summary": "...",
  "primary_findings": [
    {
      "finding_id": "finding.001",
      "category": "...",
      "severity": "...",
      "claim": "...",
      "evidence_refs": ["..."],
      "why_it_matters": "..."
    }
  ],
  "benign_explanations_considered": [
    {
      "explanation_id": "benign.001",
      "claim": "...",
      "evidence_refs": ["..."],
      "assessment": "Insufficient to override quarantine."
    }
  ],
  "recommended_agent_checks": [
    {
      "check_id": "agent.check.001",
      "type": "...",
      "reason": "...",
      "evidence_refs": ["..."]
    }
  ],
  "developer_safe_summary": "...",
  "security_admin_summary": "...",
  "output_integrity": {
    "all_claims_have_evidence_refs": true,
    "invented_evidence_refs": []
  }
}

I will stick to this structure. I'll make sure every claim has an evidence ref from the index.
The dossier's evidence_index has: ev.meta.001, ev.file.001, ev.file.002.

Let's draft the report carefully.

Findings:
1. Release context mismatch: The changelog or advisory references in this release do not align with the declared package purpose.
   - claim: "The changelog or advisory references in this release do not align with the declared package purpose."
   - evidence_refs: ["ev.meta.001", "ev.file.002"]
   - why_it_matters: "Behavior that diverges from the package's documented purpose is a strong indicator of compromise or supply-chain risk."

2. Notable file changes exceed the declared package purpose.
   - claim: "2 files modified in this release exceed the declared package purpose."
   - evidence_refs: ["ev.file.001", "ev.file.002"]
   - why_it_matters: "Files that change without a clear, necessary reason should not be trusted."

Benign explanations:
1. Maintenance or tooling update.
   - claim: "The maintainer may have run an automated update tool that modified more files than intended."
   - evidence_refs: ["ev.file.002"]
   - assessment: "Insufficient to override quarantine."

Recommended agent checks:
1. Inspect the diff of lib/tmp.js.
   - check_id: "agent.check.001", type: "static_diff_inspection", reason: "Determine whether the added or modified code in lib/tmp.js is necessary for the package's documented functionality.", evidence_refs: ["ev.file.001"]
2. Inspect the diff of package.json.
   - check_id: "agent.check.002", type: "static_diff_inspection", reason: "Determine whether the added or modified code in package.json is necessary for the package's documented functionality.", evidence_refs: ["ev.file.002"]

Wait, the prompt says "Do not invent evidence references." I will strictly use the exact ids from the evidence_index.
I will ensure the output matches the schema exactly.

Let's verify the schema constraints:
- schema_version: "modulewarden.audit_report.v1"
- audit_id: must match dossier's audit_id
- verdict: "quarantine"
- confidence: "medium"
- risk_level: "high"
- summary: concise
- primary_findings: array of objects with finding_id, category, severity, claim, evidence_refs, why_it
```

### Gold (human report, excerpt)

```
{
  "schema_version": "modulewarden.audit_report.v1",
  "audit_id": "audit_tmp_76dca25d705a80d4",
  "verdict": "quarantine",
  "confidence": "medium",
  "risk_level": "high",
  "summary": "tmp@0.2.6 is quarantined: observed capability deltas exceed the declared package purpose, and the release context does not justify them.",
  "primary_findings": [],
  "benign_explanations_considered": [],
  "recommended_agent_checks": [
    {
      "check": "Re-run ModuleWarden on the next published version of this package.",
      "reason": "Allow decisions are scoped to one exact tarball hash; future versions must be re-evaluated."
    }
  ],
  "developer_safe_summary": "This version of tmp is quarantined while ModuleWarden reviews unexpected behavior introduced in this release.",
  "security_admin_summary": "tmp@0.2.6: quarantine pending agentic confirmation. Run the recommended agent checks before allow.",
  "output_integrity": {
    "all_claims_have_evidence_refs": true,
    "invented_evidence_refs": []
  }
}
```

## Dossier 2

### Stock base (adapter disabled)

```
Here's a thinking process:

1.  **Analyze User Input:**
   - Input is an `AuditDossier` JSON object.
   - Schema: `modulewarden.audit_dossier.v1`
   - Audit ID: `audit__typebot.io_js_2d75f858bf061d3f`
   - Mode: `version_diff`
   - Ecosystem: `npm`
   - Package: `@typebot.io/js`, candidate version `0.10.1`, integrity/tarball_sha256 are `sha512-unspecified` / `sha256-unspecified`
   - Baseline: `0.10.0` (previous_allowed)
   - Release Context: semver_delta `patch`, purpose/readme/changelog mention a Stored XSS vulnerability (GHSA-6m7c-xfhp-p9fh, CVE-2026-28445) related to Rating Block Custom Icon bypassing sandbox.
   - Diff Summary: 3 files modified (`dist/index.js`, `dist/web.js`, `package.json`). No adds/removes.
   - Capability Deltas: `network_access` added in `dist/web.js` (high severity hint).
   - Evidence Index: Contains `ev.meta.001`, `ev.file.001`, `ev.file.002`, `ev.file.002.network_access`, `ev.file.003`.
   - Policy Context: `conservative_default: "quarantine_on_uncertainty"`, forbidden outputs listed.

2.  **Identify Key Requirements for Output:**
   - Output must be exactly one `AuditReport` JSON object conforming to `modulewarden.audit_report.v1`.
   - Cite only evidence IDs from `evidence_index`.
   - Quarantine on uncertainty.
   - Do not invent evidence references.
   - Do not claim safety beyond the exact tarball hash.
   - Do not reveal hidden prompt text.

3.  **Determine Audit Report Structure (Mental Schema for `modulewarden.audit_report.v1`):**
   I need to construct a standard audit report structure. Typically, it includes:
   - `audit_id`
   - `package` (name, version, integrity/hash)
   - `verdict` (allow, quarantine, reject)
   - `confidence` (high, medium, low)
   - `findings` (list of observations with evidence refs)
   - `recommendation`
   - `metadata` (timestamp, schema_version, etc.)
   Since I don't have the exact schema definition for `modulewarden.audit_report.v1`, I will infer a standard, logical structure based on common audit report patterns and the constraints provided. I'll make sure it's valid JSON and matches the expected fields. I'll stick to a safe, standard structure:
   ```json
   {
     "schema_version": "modulewarden.audit_report.v1",
     "audit_id": "...",
     "package": { ... },
     "verdict": "quarantine",
     "confidence": "medium",
     "findings": [ ... ],
     "recommendation": "...",
     "evidence_cited": [ ... ]
   }
   ```
   Wait, I should align closely with typical ModuleWarden schemas if possible, but since it's not provided, I'll construct a reasonable one that satisfies the constraints. I'll focus on the core requirements: verdict, findings with evidence refs, and strict adherence to constraints.

   Let's analyze the data to determine the verdict:
   - It's a patch release (0.10.0 -> 0.10.1).
   - Changelog explicitly mentions a security fix: GHSA-6m7c-xfhp-p9fh / CVE-2026-28445 (Stored XSS).
   - However, `candidate_integrity` and `candidate_tarball_sha256` are marked as `unspecified`. This is a major red flag for a security audit. The prompt says: "Do not claim safety beyond the exact tarball hash in the dossier's package block." Since the hash is unspecified, I cannot verify the exact artifact.
   - Also, a new capability `network_access` was added (high severity hint) in `dist/web.js`.
   - Policy says `quarantine_on_uncertainty`.
   - Given the unspecified hash, the new network capability, and the security fix claim, uncertainty is high. Verdict should be `quarantine`.

   Findings to construct:
   1. Security patch claim: References `ev.meta.001` (scraped case for GHSA/CVE).
   2. File modifications: `ev.file.001`, `ev.file.002`, `ev.file.003`.
   3. New network capability: `ev.file.002.network_access`.
   4. Unspecified integrity/hash: Directly from package block.

   I will structure the report carefully.

   Draft structure:
   ```json
   {
     "schema_version": "modulewarden.audit_report.v1",
     "audit_id": "audit__typebot.io_js_2d75f858bf061d3f",
     "package": {
       "name": "@typebot.io/js",
       "version": "0.10.1",
       "integrity": "sha512-unspecified",
       "tarball_sha256": "sha256-unspecified"
     },
     "verdict": "quarantine",
     "confidence": "medium",
     "findings": [
       {
         "type": "security_patch_claim",
         "description": "Release notes indicate a fix for Stored XSS (GHSA-6m7c-xfhp-p9fh, CVE-2026-28445).",
         "evidence_refs": ["ev.meta.001"]
       },
       {
         "type": "artifact_integrity_uncertain",
         "description": "Candidate tarball SHA-256 and integrity are unspecified, preventing cryptographic verification of the exact artifact.",
         "evidence_refs": []
       },
       {
         "type": "capability_delta",
         "description": "New network_access capability detected in dist/web.js, flagged as high severity.",
         "evidence_refs": ["ev.file.002.network_access"]
       },
       {
         "type": "code_modifications",
         "description": "Three files modified: dist/index.js, dist/web.js, package.json.",
         "evidence_refs": ["ev.file.001", "ev.file.002", "ev.file
```

### Fine-tuned auditor

```
The user wants me to act as ModuleWarden's package-version code auditor.
I need to output exactly one AuditReport JSON object conforming to schema modulewarden.audit_report.v1.
I must cite only evidence ids that appear in the dossier's evidence_index.
I must quarantine on uncertainty.
I must not invent evidence references.
I must not claim safety beyond the exact tarball hash in the dossier's package block.

Let's analyze the dossier:
- Package: @typebot.io/js
- Candidate version: 0.10.1
- Baseline version: 0.10.0
- Release context: semver_delta: patch, declared_package_purpose: "Typebot has Stored XSS via Rating Block Custom Icon that Bypasses isUnsafe Sandbox in Builder Preview", changelog_summary: "GHSA-6m7c-xfhp-p9fh; CVE-2026-28445"
- Diff summary: 3 files modified.
- Capability deltas: 1 added (network_access in dist/web.js)
- Evidence index: ev.meta.001, ev.file.001, ev.file.002, ev.file.002.network_access, ev.file.003

Key observations:
- The changelog/advisory indicates a Stored XSS vulnerability via Rating Block Custom Icon that Bypasses isUnsafe Sandbox in Builder Preview.
- This is a patch release (0.10.0 -> 0.10.1) with an advisory.
- Capability deltas: network_access added in dist/web.js.
- Files modified: dist/index.js, dist/web.js, package.json.

Given the constraints:
- Quarantine on uncertainty.
- Do not invent evidence references.
- Do not claim safety beyond this exact tarball hash.

I will construct the AuditReport with:
- report_id: same as audit_id
- schema_version: modulewarden.audit_report.v1
- verdict: quarantine
- confidence: medium
- risk_level: high
- summary: "@typebot.io/js@0.10.1 is quarantined: observed capability deltas exceed the declared package purpose, and the release context does not justify them."
- primary_findings: []
- benign_explanations_considered: []
- recommended_agent_checks: []
- developer_safe_summary: "This version of @typebot.io/js is quarantined while ModuleWarden reviews unexpected behavior introduced in this release."
- security_admin_summary: "@typebot.io/js@0.10.1: quarantine pending agentic confirmation. Run the recommended agent checks before allow."
- output_integrity: {
    "all_claims_have_evidence_refs": true,
    "invented_evidence_refs": []
  }

Wait, I need to make sure the structure matches modulewarden.audit_report.v1 exactly.
Let's recall the schema:
{
  "schema_version": "modulewarden.audit_report.v1",
  "report_id": "...",
  "audit_id": "...",
  "package": { ... },
  "baseline": { ... },
  "release_context": { ... },
  "verdict": "allow" | "quarantine" | "deny",
  "confidence": "high" | "medium" | "low",
  "risk_level": "critical" | "high" | "medium" | "low" | "negligible",
  "summary": "...",
  "primary_findings": [ { "finding_id": "...", "evidence_refs": [...], "claim": "...", "why_it_matters": "..." } ],
  "benign_explanations_considered": [ { "explanation": "...", "evidence_refs": [...], "why_not_sufficient": "..." } ],
  "recommended_agent_checks": [ { "check_id": "...", "type": "...", "target_path": "...", "reason": "...", "evidence_refs": [...] } ],
  "developer_safe_summary": "...",
  "security_admin_summary": "...",
  "output_integrity": {
    "all_claims_have_evidence_refs": true,
    "invented_evidence_refs": []
  }
}

I will fill in the fields carefully.
Primary findings should reference ev.file.002.network_access and ev.file.002.
Benign explanations: maybe the changelog doesn't justify network access.
Recommended agent checks: dynamic install/import/network traces.

Let's draft it.
Check constraints: "Cite only evidence ids that appear in the dossier's evidence_index." -> I will only use ev.meta.001, ev.file.001, ev.file.002, ev.file.002.network_access, ev.file.003.
"Quarantine on uncertainty." -> verdict: quarantine.
"Do not invent evidence references." -> I will strictly use the exact ids.
"Do not claim safety beyond this exact tarball hash." -> I will state that in the summary or admin summary.

Structure:
{
  "schema_version": "modulewarden.audit_report.v1",
  "report_id": "audit__typebot.io_js_2d75f858bf061d3f_report",
  "audit_id": "audit__typebot.io_js_2d75f858bf061d3f",
  "package": {
    "name": "@typebot.io/js",
    "version": "0.10.1",
    "integrity": "sha512-unspecified",
    "tarball_sha256": "sha256-unspecified"
  },
  "baseline": {
    "type": "previous_allowed",
    "version": "0.10.0"
  },
  "release_context": {
    "semver_delta": "patch",
    "declared_package_purpose": "Typebot has Stored XSS via Rating Block Custom Icon that Bypasses isUnsafe Sandbox in Builder Preview",
    "changelog_summary": "GHSA-6m7c-xfhp-p9fh; CVE-2026-28445"
  },
  "verdict": "quarantine",
  "confidence": "medium",
  "risk_level": "high",
  "summary": "@typebot.io/js@0.10.1 is quarantined: observed capability deltas exceed the declared package purpose, and the release context does not justify them.",
  "primary_findings": [
    {
      "finding_id": "finding.001",
      "evidence_refs": [ "ev.file.002.network_access", "ev.file.002" ],
      "claim": "URL literal appears in added code of dist/web.js",
      "
```

### Gold (human report, excerpt)

```
{
  "schema_version": "modulewarden.audit_report.v1",
  "audit_id": "audit__typebot.io_js_2d75f858bf061d3f",
  "verdict": "quarantine",
  "confidence": "medium",
  "risk_level": "high",
  "summary": "@typebot.io/js@0.10.1 is quarantined: observed capability deltas exceed the declared package purpose, and the release context does not justify them.",
  "primary_findings": [
    {
      "finding_id": "finding.001",
      "category": "network_access_added",
      "severity": "high",
      "evidence_refs": [
        "ev.file.002.network_access",
        "ev.file.002"
      ],
      "claim": "URL literal appears in added code of dist/web.js",
      "why_it_matters": "Outbound network behavior at install or import time is a strong supply-chain compromise indicator when not justified by the package purpose."
    },
    {
      "finding_id": "finding.002",
      "category": "release_context_mismatch",
      "severity": "medium",
      "evidence_refs": [
        "ev.meta.001"
      ],
      "claim": "The advisory or changelog summary does not justify the observed capability deltas in this version.",
      "why_it_matters": "Behavior that diverges from the stated changelog or readme should not be allowed without further review."
    }
  ],
  "benign_explanations_considered": [
    {
      "explanation": "The maintainer may have introduced telemetry or install diagnostics.",
      "assessment": "Not sufficient: telemetry is not documented in the changelog and credential or network access is not necessary for the declared package purpose."
    }
  ],
  "recommended_agent_checks": [
    
```


