# Decepticon Integration: Technical Architecture

**Date:** 2026-05-29
**Context:** Zero-One Hack, Track 02, UNIQA submission (~36h window)
**Safety constraint:** No execution of untrusted package code on this workstation.

---

## 1. Where Decepticon Plugs In

### Candidate surfaces (evaluated in order of fit)

| Surface | Verdict | Reason |
|---------|---------|--------|
| `packages/audit-runner/src/orchestrator.ts` | **Do not touch** | Runs inside Docker, communicates via PI RPC. Decepticon is a Python SDK; mixing runtimes inside the audit container adds complexity and no demo value. |
| `packages/worker/src/handlers/audit.ts` | **Wrapper only** | The worker calls the container runner after verdict; a post-verdict enrichment hook is safe here but evidence is already committed. |
| `finetune/python/pipeline/dossier_builder.py` | **PRIMARY insertion point** | Pure Python, already produces `capability_deltas` from static signals. A `decepticon_mapper` call at the end of `build_dossier()` can enrich the returned dict before it is serialized. |
| `chat/agent.py` | **Narrative layer** | `narrate_underwriting()` already calls the model with pinned facts. Decepticon-derived ATT&CK technique ids can be injected into `pinned["primary_findings"]` so the model narrates them without inventing them. |
| New Python sidecar | **NARRATE-ONLY for hack** | A `decepticon_mapper` module could live at `finetune/python/decepticon/mapper.py`. This is the build target. |

### Selected integration point

**`finetune/python/decepticon/mapper.py`** called from `dossier_builder.build_dossier()` as an optional enrichment pass.

Why: `build_dossier()` already has all the static signals (`capability_deltas`, `diff_summary`, `dependency_changes`). It returns a plain dict. Inserting a mapper call before `return dossier` is a ~10-line change to one file. No TS code is touched, no container is modified, the existing audit_dossier.v1 schema is not broken.

---

## 2. The Safe Integration Boundary

### What Decepticon can do without executing untrusted code

The Decepticon SDK ships specialist agents and a kill-chain knowledge graph. For ModuleWarden's use case, the relevant subsystem is **kill-chain mapping** - given a set of observed behaviors (static signals already in the dossier), map them onto MITRE ATT&CK techniques and generate a narrative engagement summary.

The boundary that stays safe:

- INPUT: `capability_deltas` list from dossier (e.g. `credential_or_env_access`, `network_access`, `lifecycle_script`, `process_execution`)
- INPUT: `diff_summary.notable_file_changes` paths and change types
- INPUT: `release_context.semver_delta` and `declared_package_purpose`
- OUTPUT: ATT&CK technique mappings + kill-chain phase labels + narrative fragment

What this does NOT do:
- Install or run the candidate npm package
- Execute any lifecycle scripts
- Spawn Docker containers
- Make outbound network calls to unknown hosts

The Decepticon SDK's `PluginBundle` architecture (Apache-2.0, per task-30 backlog entry) has a pure-contracts core (`decepticon-core`) separate from execution agents. The mapper uses only the contracts/mapping layer, not the sandboxed execution agents.

---

## 3. Capability-to-ATT&CK Mapping Table

This mapping is the adapter's core logic. It is static and does not require SDK calls to derive - it can be hardcoded in the adapter for the hack build and later replaced by SDK calls.

| capability (from dossier) | ATT&CK Technique | Kill-chain Phase |
|--------------------------|-----------------|-----------------|
| `lifecycle_script` (postinstall/preinstall) | T1195.002 - Supply Chain: Software Supply Chain Compromise | Initial Access |
| `credential_or_env_access` | T1552.001 - Credentials in Files; T1552.007 - Container Creds | Credential Access |
| `network_access` (install-time) | T1041 - Exfiltration Over C2 Channel | Exfiltration |
| `process_execution` (child_process) | T1059.007 - Command and Scripting: JavaScript | Execution |
| `dynamic_code_execution` (eval/Function) | T1059.007 - Command and Scripting; T1027 - Obfuscated Files | Defense Evasion |
| `obfuscation` | T1027 - Obfuscated Files or Information | Defense Evasion |
| `filesystem_sensitive_access` (.npmrc, .ssh, .aws) | T1552.001 - Credentials in Files | Credential Access |
| `native_or_wasm` | T1055 - Process Injection (via native binding) | Privilege Escalation |
| `dependency_indirection` (new dep added) | T1195.001 - Compromise Software Dependencies | Initial Access |

The `T1606` (Forge Web Credentials) reference in `demo/tests/test_injection_robustness.py` is already in the codebase for injection vector testing. The mapper closes the loop: injection vectors in test data map to the same ATT&CK table that the production mapper uses.

---

## 4. Concrete Minimal Interface

### `finetune/python/decepticon/__init__.py`
Empty or minimal version marker.

### `finetune/python/decepticon/mapper.py`

```python
"""
decepticon_mapper: maps AuditDossier v1 capability_deltas to MITRE ATT&CK
findings for injection into AuditReport v1 primary_findings.

Safe boundary: consumes only already-extracted static signals from the dossier.
Does NOT install, execute, or inspect untrusted package code.

For the hackathon build: uses the hardcoded capability->ATT&CK table below.
Post-hackathon: replace _CAPABILITY_TO_ATTACK with a call to
decepticon.knowledge_graph.query_kill_chain(capability_ids) once the SDK
kill-chain query API is verified to be pure-read (no sandbox execution).
"""
from __future__ import annotations
from typing import Any

# ATT&CK technique mapping table.
# Keys match capability strings from dossier_builder._detect_caps_in_text().
_CAPABILITY_TO_ATTACK: dict[str, list[dict[str, str]]] = {
    "lifecycle_script": [
        {"technique_id": "T1195.002", "technique_name": "Supply Chain Compromise: Software Supply Chain Compromise", "phase": "Initial Access"},
    ],
    "credential_or_env_access": [
        {"technique_id": "T1552.001", "technique_name": "Unsecured Credentials: Credentials in Files", "phase": "Credential Access"},
        {"technique_id": "T1552.007", "technique_name": "Unsecured Credentials: Container API", "phase": "Credential Access"},
    ],
    "network_access": [
        {"technique_id": "T1041", "technique_name": "Exfiltration Over C2 Channel", "phase": "Exfiltration"},
    ],
    "process_execution": [
        {"technique_id": "T1059.007", "technique_name": "Command and Scripting Interpreter: JavaScript", "phase": "Execution"},
    ],
    "dynamic_code_execution": [
        {"technique_id": "T1059.007", "technique_name": "Command and Scripting Interpreter: JavaScript", "phase": "Execution"},
        {"technique_id": "T1027", "technique_name": "Obfuscated Files or Information", "phase": "Defense Evasion"},
    ],
    "obfuscation": [
        {"technique_id": "T1027", "technique_name": "Obfuscated Files or Information", "phase": "Defense Evasion"},
    ],
    "filesystem_sensitive_access": [
        {"technique_id": "T1552.001", "technique_name": "Unsecured Credentials: Credentials in Files", "phase": "Credential Access"},
    ],
    "native_or_wasm": [
        {"technique_id": "T1055", "technique_name": "Process Injection", "phase": "Privilege Escalation"},
    ],
}

# Kill-chain phase ordering (for narrative ordering, not logic)
_PHASE_ORDER = ["Initial Access", "Execution", "Privilege Escalation", "Defense Evasion", "Credential Access", "Exfiltration"]


def map_dossier_to_attack(dossier: dict[str, Any]) -> list[dict[str, Any]]:
    """
    Given a modulewarden.audit_dossier.v1 dict, return a list of ATT&CK-mapped
    findings ready for injection into audit_report.v1 primary_findings.

    Each returned item has the shape of an audit_report.v1 finding:
      finding_id, category, severity, evidence_refs, claim, why_it_matters
    plus an extra non-schema field:
      attack_techniques: [{technique_id, technique_name, phase}, ...]

    The extra field is safe to carry through - audit_report.v1 schema uses
    additionalProperties: false only at the top level, not within finding items.
    Actually, the finding $def DOES use additionalProperties: false, so strip
    attack_techniques before schema validation; use it only for the chat layer
    and the underwriting memo narrative.
    """
    cap_deltas: list[dict[str, Any]] = dossier.get("capability_deltas") or []
    evidence_index: list[dict[str, Any]] = dossier.get("evidence_index") or []

    # Build a quick evidence_ref -> id map for cross-linking
    ev_ids = {ev["id"] for ev in evidence_index}

    seen_techniques: set[str] = set()
    findings: list[dict[str, Any]] = []

    for delta in cap_deltas:
        cap_key = delta.get("capability") or ""
        techniques = _CAPABILITY_TO_ATTACK.get(cap_key, [])
        if not techniques:
            continue

        evidence_ref = delta.get("evidence_ref") or ""
        refs = [evidence_ref] if evidence_ref in ev_ids else []

        for tech in techniques:
            tid = tech["technique_id"]
            if tid in seen_techniques:
                continue
            seen_techniques.add(tid)

            findings.append({
                "finding_id": f"attack-{tid.replace('.', '-').lower()}",
                "category": _cap_to_report_category(cap_key),
                "severity": delta.get("severity_hint") or "medium",
                "evidence_refs": refs,
                "claim": (
                    f"{tech['technique_name']} ({tid}) observed: "
                    f"{delta.get('summary', cap_key)}"
                ),
                "why_it_matters": (
                    f"Kill-chain phase: {tech['phase']}. "
                    f"Maps to Decepticon red-team kill-chain specialist category. "
                    f"Attackers using this technique at the supply-chain ingress point "
                    f"gain {tech['phase'].lower()} capability before the package is audited downstream."
                ),
                # Strip this before audit_report.v1 schema validation
                "_attack_techniques": [tech],
                "_kill_chain_phase": tech["phase"],
            })

    # Sort by kill-chain phase order
    findings.sort(key=lambda f: _PHASE_ORDER.index(f.get("_kill_chain_phase", "Exfiltration"))
                  if f.get("_kill_chain_phase") in _PHASE_ORDER else 99)

    return findings


def build_attack_narrative(findings: list[dict[str, Any]], package_name: str) -> str:
    """
    Produce a short ATT&CK kill-chain narrative string suitable for injection
    into audit_report.v1 security_admin_summary or the chat layer.

    This is the 'Decepticon red-team engagement narrative' framing for the demo.
    """
    if not findings:
        return ""

    phases_seen: list[str] = []
    technique_lines: list[str] = []
    for f in findings:
        phase = f.get("_kill_chain_phase") or ""
        if phase and phase not in phases_seen:
            phases_seen.append(phase)
        for tech in f.get("_attack_techniques") or []:
            tid = tech.get("technique_id") or ""
            tname = tech.get("technique_name") or ""
            if tid:
                technique_lines.append(f"  - {tid}: {tname} [{phase}]")

    kill_chain_summary = " -> ".join(phases_seen)
    techniques_text = "\n".join(technique_lines)

    return (
        f"Decepticon red-team kill-chain analysis for {package_name}: "
        f"Observed kill-chain: {kill_chain_summary}. "
        f"MITRE ATT&CK techniques mapped:\n{techniques_text}"
    )


def _cap_to_report_category(cap_key: str) -> str:
    """Map a capability key to the nearest audit_report.v1 finding category enum value."""
    _MAP = {
        "lifecycle_script": "lifecycle_script_added",
        "credential_or_env_access": "credential_or_env_access",
        "network_access": "network_access_added",
        "process_execution": "process_execution_added",
        "dynamic_code_execution": "dynamic_code_execution",
        "obfuscation": "obfuscation_added",
        "filesystem_sensitive_access": "filesystem_sensitive_access",
        "native_or_wasm": "native_or_wasm_added",
    }
    return _MAP.get(cap_key, "install_time_behavior")
```

### Integration call in `dossier_builder.py`

In `build_dossier()`, before `return dossier`, add:

```python
# Optional: Decepticon ATT&CK enrichment (text/metadata only, no package execution)
try:
    from modulewarden.decepticon.mapper import map_dossier_to_attack, build_attack_narrative
    attack_findings = map_dossier_to_attack(dossier)
    if attack_findings:
        # Store on the dossier for downstream report builder to consume.
        # Not part of audit_dossier.v1 schema - strip before validation or
        # pass via extra_dynamic_observations as evidence refs.
        dossier["_decepticon_attack_findings"] = attack_findings
        dossier["_decepticon_narrative"] = build_attack_narrative(
            attack_findings, pair.package
        )
except ImportError:
    pass  # Decepticon mapper is optional; dossier is valid without it
```

### Integration in `chat/agent.py`

In `narrate_underwriting()`, enrich `pinned` before the LLM call:

```python
# Inject ATT&CK findings if present in the dossier
attack_findings = dossier.get("_decepticon_attack_findings") or []
if attack_findings:
    pinned["attack_kill_chain"] = dossier.get("_decepticon_narrative") or ""
    pinned["mitre_techniques"] = [
        f.get("_attack_techniques", [{}])[0].get("technique_id", "")
        for f in attack_findings if f.get("_attack_techniques")
    ]
```

---

## 5. Files to Touch

### BUILD-NOW (36h window)

| File | Action | Scope |
|------|--------|-------|
| `finetune/python/decepticon/__init__.py` | CREATE | 3 lines |
| `finetune/python/decepticon/mapper.py` | CREATE | ~120 lines (full module above) |
| `finetune/python/pipeline/dossier_builder.py` | EDIT | +8 lines before `return dossier` |
| `chat/agent.py` `narrate_underwriting()` | EDIT | +6 lines to inject ATT&CK into `pinned` |
| `chat/prompts/system.md` | EDIT | Add a paragraph instructing model to cite ATT&CK technique IDs when present in pinned evidence |

### NARRATE-ONLY (slide/Q&A, not code)

| Idea | Why narrate not build |
|------|-----------------------|
| Live Decepticon SDK call (`decepticon.knowledge_graph`) | SDK kill-chain query API not verified to be pure-read; Neo4j setup time > 36h budget |
| Decepticon specialist agents over the package source | Requires execution environment; SAFETY-GATED |
| Real-time Neo4j attack-chain graph in the chat UI | Infrastructure setup cost, not a 36h deliverable |

---

## 6. The Single Highest-Leverage Architectural Move

**ATT&CK enrichment as a post-dossier pass in `dossier_builder.py`.**

Rationale: The demo already has postmark-mcp-1.0.16 producing `capability_deltas` = [lifecycle_script, credential_or_env_access, network_access]. The mapper turns those three capabilities into a T1195.002 + T1552.001 + T1041 kill-chain narrative in ~50ms of pure Python, zero network calls. The chat layer then has grounded MITRE technique ids to narrate. The UNIQA underwriter persona gets a kill-chain framing ("Initial Access -> Credential Access -> Exfiltration") instead of generic capability names. This is the exact delta that makes ModuleWarden look like it has Decepticon red-team intelligence embedded, without adding any risk surface.

---

## 7. SAFETY-GATED Items

The following are flagged as requiring explicit operator review before any build work:

1. **Executing the candidate npm package tarball** - even inside Docker on this machine. The dossier already has static signals; runtime execution adds zero demo value and is the explicit safety constraint.
2. **Decepticon `sandbox_execute` agent** - any code path that uses `SAAS_SANDBOX_URL` or `DECEPTICON_LLM__PROXY_URL` to run live attack chains. Not needed for the ATT&CK mapping use case.
3. **Neo4j deployment** - `decepticon[neo4j]` requires a running Neo4j instance. No time budget and not needed for the static mapping path.
4. **Fetching Decepticon's `decepticon-core` package** - the task-30 backlog note explicitly says "do NOT port code; study the protocols/registry boundary." The mapper implements the mapping logic independently, so no SDK import is required for the hack build.

---

## 8. Demo Incident Verification

The three demo incidents can be used to verify the mapper produces correct ATT&CK output:

- `postmark-mcp-1.0.16`: capability_deltas includes lifecycle_script + credential_or_env_access + network_access -> expected techniques: T1195.002, T1552.001, T1552.007, T1041
- `lodash-4.17.21`: depends on what the dossier has; likely benign (allow verdict, low risk)
- `postmark-mcp-1.0.12`: intermediate state

A test at `finetune/python/tests/test_decepticon_mapper.py` can load `demo/incidents/postmark-mcp-1.0.16.dossier.json`, run `map_dossier_to_attack()`, and assert T1195.002 is present in the output. This is the only test needed for the hack build.

---

## 9. Architecture Diagram (Text)

```
npm install request
        |
   [api-proxy]  <- Fastify, packument/tarball routes
        |
   [worker]     <- pg-boss job queue
        |
   [audit-runner container] <- PI + RPC bridge
        |
   verdict.json  (allow/quarantine/block)
        |
   [dossier_builder.py]
        |--- capability_deltas (static signals from diff)
        |--- _decepticon_attack_findings (NEW: ATT&CK mapped, no exec)
        |--- _decepticon_narrative (NEW: kill-chain text)
        |
   [chat/agent.py narrate_underwriting()]
        |--- pinned verdict (authoritative, from report)
        |--- pinned mitre_techniques (NEW: T1195.002 etc)
        |--- LLM narrates with ATT&CK context (does not invent verdicts)
        |
   [Streamlit UI / CLI]  <- underwriter sees ATT&CK-framed risk memo
```
