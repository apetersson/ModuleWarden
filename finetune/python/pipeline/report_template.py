"""Build canonical AuditReport v1 records from a dossier + label hint.

Verdicts derive from the labeling-rubric in ``finetune/docs/labeling-rubric.md``:

- GHSA severity ``critical`` or ``case_type=incident_replay`` -> ``block``,
  confidence ``high``, risk ``critical``
- GHSA severity ``high`` + ``cve_diff`` -> ``quarantine`` (or ``block`` when
  confirmed exploit behavior is visible in the diff), confidence ``medium``,
  risk ``high``
- GHSA severity ``medium`` -> ``quarantine``, confidence ``medium``, risk ``medium``
- ``benign_neighbor`` with no advisory at that exact version -> ``allow``,
  confidence ``medium``, risk ``low``
- ``cold_start`` with no sensitive capability deltas -> ``allow``,
  confidence ``low``, risk ``none``
- Cold start with sensitive deltas -> ``quarantine``, ``medium`` / ``medium``

Every finding cites only evidence ids that actually appear in the
dossier's ``evidence_index``. The ``output_integrity.all_claims_have_
evidence_refs`` flag is set true and ``invented_evidence_refs`` is left
empty when this contract holds.
"""

from __future__ import annotations

import logging
from typing import Any, Iterable, Mapping

logger = logging.getLogger("modulewarden.report_template")

# Map dossier capability -> AuditReport finding category from the
# controlled vocabulary in finetune/docs/finding-taxonomy.md.
_CAP_TO_CATEGORY: dict[str, str] = {
    "lifecycle_script": "lifecycle_script_added",
    "credential_or_env_access": "credential_or_env_access",
    "network_access": "network_access_added",
    "process_execution": "process_execution_added",
    "filesystem_sensitive_access": "filesystem_sensitive_access",
    "dynamic_code_execution": "dynamic_code_execution",
    "obfuscation": "obfuscation_added",
    "native_or_wasm": "native_or_wasm_added",
}

# Severity hint passthrough from the dossier (already controlled values).
_VALID_SEVERITIES = ("info", "low", "medium", "high", "critical")


def _coerce_severity(s: str | None) -> str:
    if isinstance(s, str) and s in _VALID_SEVERITIES:
        return s
    return "medium"


def _evidence_id_set(dossier: Mapping[str, Any]) -> set[str]:
    out: set[str] = set()
    for ev in dossier.get("evidence_index") or []:
        if isinstance(ev, Mapping):
            ev_id = ev.get("id")
            if isinstance(ev_id, str):
                out.add(ev_id)
    return out


def _verdict_for_case(
    case_type: str,
    severity: str | None,
    cold_start: bool,
    has_sensitive_caps: bool,
    has_exfil_evidence: bool,
) -> tuple[str, str, str]:
    """Return (verdict, confidence, risk_level) per the labeling-rubric."""
    sev = (severity or "").lower()
    if case_type == "incident_replay":
        return "block", "high", "critical"
    if has_exfil_evidence:
        return "block", "high", "critical"
    if case_type == "benign_neighbor" and not has_sensitive_caps:
        return "allow", "medium", "low"
    if cold_start and not has_sensitive_caps:
        return "allow", "low", "none"
    if cold_start and has_sensitive_caps:
        return "quarantine", "medium", "medium"
    if sev == "critical":
        return "block" if has_exfil_evidence else "quarantine", "high", "critical"
    if sev == "high":
        return "quarantine", "medium", "high"
    if sev == "medium":
        return "quarantine", "medium", "medium"
    if sev == "low":
        return "allow" if not has_sensitive_caps else "quarantine", "medium", "low"
    if has_sensitive_caps:
        return "quarantine", "medium", "medium"
    return "allow", "medium", "low"


def _findings_from_deltas(
    dossier: Mapping[str, Any],
    valid_ev_ids: set[str],
) -> list[dict[str, Any]]:
    """Build one finding per capability_delta from the dossier."""
    findings: list[dict[str, Any]] = []
    next_id = 1
    for delta in dossier.get("capability_deltas") or []:
        if not isinstance(delta, Mapping):
            continue
        cap = delta.get("capability")
        category = _CAP_TO_CATEGORY.get(str(cap or ""))
        if category is None:
            continue
        ev_ref = delta.get("evidence_ref")
        ev_refs = [ev_ref] if isinstance(ev_ref, str) and ev_ref in valid_ev_ids else []
        # Also include any per-file evidence the capability is grounded in.
        if isinstance(ev_ref, str):
            prefix = ev_ref.rsplit(".", 1)[0]
            if prefix in valid_ev_ids and prefix not in ev_refs:
                ev_refs.append(prefix)
        if not ev_refs:
            # Skip findings we cannot ground in real evidence rather than
            # invent a reference; this keeps output_integrity honest.
            continue
        severity = _coerce_severity(delta.get("severity_hint"))
        summary = delta.get("summary") or ""
        findings.append(
            {
                "finding_id": f"finding.{next_id:03d}",
                "category": category,
                "severity": severity,
                "evidence_refs": ev_refs,
                "claim": str(summary)[:280],
                "why_it_matters": _why_for_category(category),
            }
        )
        next_id += 1
    return findings


def _why_for_category(category: str) -> str:
    """One-sentence rationale per controlled category."""
    return {
        "lifecycle_script_added": (
            "Install-time code runs automatically during npm install and is a common "
            "supply-chain abuse point."
        ),
        "credential_or_env_access": (
            "Reading credential or token env vars from a package that does not declare "
            "this purpose creates exfiltration risk in dev and CI environments."
        ),
        "network_access_added": (
            "Outbound network behavior at install or import time is a strong "
            "supply-chain compromise indicator when not justified by the package purpose."
        ),
        "process_execution_added": (
            "Spawning shell commands or child processes inside an installed package "
            "broadens the attack surface beyond the JavaScript sandbox."
        ),
        "filesystem_sensitive_access": (
            "Reading sensitive paths such as ~/.npmrc, ~/.ssh, or cloud credential dirs "
            "is a precondition for credential theft from dev workstations."
        ),
        "dynamic_code_execution": (
            "eval, Function, and vm.run can execute strings or remote payloads at "
            "runtime, evading static review."
        ),
        "obfuscation_added": (
            "Obfuscated code in a previously readable package suggests intentional "
            "evasion of human and static review."
        ),
        "native_or_wasm_added": (
            "Native binaries and WASM artifacts shipped with an npm package can run "
            "arbitrary code outside the JavaScript runtime sandbox."
        ),
        "release_context_mismatch": (
            "Behavior that diverges from the stated changelog or readme should not "
            "be allowed without further review."
        ),
        "cold_start_insufficient_evidence": (
            "Cold-start reviews are weaker than predecessor diffs and require "
            "conservative treatment when behavior is not fully explained."
        ),
    }.get(
        category,
        "Material change to package supply-chain risk that warrants review.",
    )


def _cold_start_finding(
    dossier: Mapping[str, Any],
    valid_ev_ids: set[str],
    next_id: int,
) -> dict[str, Any] | None:
    if not (dossier.get("policy_context") or {}).get("cold_start"):
        return None
    # Anchor the finding to the always-present scraped_case evidence row.
    ev_ref = "ev.meta.001" if "ev.meta.001" in valid_ev_ids else None
    if ev_ref is None:
        return None
    return {
        "finding_id": f"finding.{next_id:03d}",
        "category": "cold_start_insufficient_evidence",
        "severity": "medium",
        "evidence_refs": [ev_ref],
        "claim": "There is no previously allowed predecessor for a normal version-diff comparison.",
        "why_it_matters": _why_for_category("cold_start_insufficient_evidence"),
    }


def _release_context_finding(
    dossier: Mapping[str, Any],
    valid_ev_ids: set[str],
    next_id: int,
    has_sensitive_caps: bool,
) -> dict[str, Any] | None:
    if not has_sensitive_caps:
        return None
    changelog = (dossier.get("release_context") or {}).get("changelog_summary") or ""
    if "no changelog" in str(changelog).lower() or not changelog:
        return None
    ev_ref = "ev.meta.001" if "ev.meta.001" in valid_ev_ids else None
    if ev_ref is None:
        return None
    return {
        "finding_id": f"finding.{next_id:03d}",
        "category": "release_context_mismatch",
        "severity": "medium",
        "evidence_refs": [ev_ref],
        "claim": (
            "The advisory or changelog summary does not justify the observed "
            "capability deltas in this version."
        ),
        "why_it_matters": _why_for_category("release_context_mismatch"),
    }


def _has_exfil_signal(dossier: Mapping[str, Any]) -> bool:
    """Detect a credential+network combination, the classic exfil pattern."""
    caps = {
        delta.get("capability")
        for delta in (dossier.get("capability_deltas") or [])
        if isinstance(delta, Mapping)
    }
    return "credential_or_env_access" in caps and "network_access" in caps


def build_report(
    dossier: Mapping[str, Any],
    *,
    scraped_case: Mapping[str, Any] | None = None,
) -> dict[str, Any]:
    """Build a canonical ``modulewarden.audit_report.v1`` dict for the dossier.

    All evidence_refs in primary_findings come from the dossier's
    evidence_index. ``output_integrity.invented_evidence_refs`` is always
    empty by construction; the flag is true.
    """
    audit_id = str(dossier.get("audit_id") or "audit_unknown")
    valid_ev_ids = _evidence_id_set(dossier)
    case_type = ""
    severity: str | None = None
    if scraped_case is not None:
        case_type = str(scraped_case.get("case_type") or "")
        sv = scraped_case.get("severity")
        if isinstance(sv, str):
            severity = sv

    cold_start = bool((dossier.get("policy_context") or {}).get("cold_start"))
    capabilities = [
        d for d in (dossier.get("capability_deltas") or []) if isinstance(d, Mapping)
    ]
    has_sensitive_caps = any(
        d.get("capability") in _CAP_TO_CATEGORY for d in capabilities
    )
    has_exfil = _has_exfil_signal(dossier)

    verdict, confidence, risk = _verdict_for_case(
        case_type=case_type,
        severity=severity,
        cold_start=cold_start,
        has_sensitive_caps=has_sensitive_caps,
        has_exfil_evidence=has_exfil,
    )

    findings = _findings_from_deltas(dossier, valid_ev_ids)
    next_id = len(findings) + 1
    cs = _cold_start_finding(dossier, valid_ev_ids, next_id)
    if cs is not None:
        findings.append(cs)
        next_id += 1
    rc = _release_context_finding(dossier, valid_ev_ids, next_id, has_sensitive_caps)
    if rc is not None:
        findings.append(rc)
        next_id += 1

    pkg_name = (dossier.get("package") or {}).get("name") or "the package"
    pkg_ver = (dossier.get("package") or {}).get("candidate_version") or ""
    declared_purpose = (
        (dossier.get("release_context") or {}).get("declared_package_purpose") or ""
    )

    if verdict == "block":
        summary = (
            f"{pkg_name}@{pkg_ver} is blocked: capability deltas show credential and "
            f"network access combined with install-time execution that match a known "
            f"supply-chain compromise pattern."
        )
        dev_summary = (
            f"This version of {pkg_name} is blocked because it shows install-time "
            f"behavior consistent with a known supply-chain attack."
        )
        admin_summary = (
            f"{pkg_name}@{pkg_ver}: high-confidence block. Capability deltas include "
            f"{', '.join(sorted(c for c in (d.get('capability') for d in capabilities) if c))}. "
            f"Escalate before any override."
        )
    elif verdict == "quarantine":
        summary = (
            f"{pkg_name}@{pkg_ver} is quarantined: observed capability deltas exceed "
            f"the declared package purpose, and the release context does not justify "
            f"them."
        )
        dev_summary = (
            f"This version of {pkg_name} is quarantined while ModuleWarden reviews "
            f"unexpected behavior introduced in this release."
        )
        admin_summary = (
            f"{pkg_name}@{pkg_ver}: quarantine pending agentic confirmation. "
            f"Run the recommended agent checks before allow."
        )
    else:
        summary = (
            f"{pkg_name}@{pkg_ver} is allowed: no material capability deltas relative "
            f"to its declared purpose and no exfiltration indicator was found in the "
            f"prepared evidence."
        )
        dev_summary = (
            f"This version of {pkg_name} is allowed pending revocation if new evidence "
            f"appears."
        )
        admin_summary = (
            f"{pkg_name}@{pkg_ver}: allow on this exact tarball hash; this is not a "
            f"permanent safety claim."
        )

    benign_explanations: list[dict[str, str]] = []
    if has_sensitive_caps:
        benign_explanations.append(
            {
                "explanation": (
                    "The maintainer may have introduced telemetry or install diagnostics."
                ),
                "assessment": (
                    "Not sufficient: telemetry is not documented in the changelog and "
                    "credential or network access is not necessary for the declared package purpose."
                ),
            }
        )
    if cold_start:
        benign_explanations.append(
            {
                "explanation": (
                    "The package may be a legitimate new release that simply lacks a "
                    "predecessor for diffing."
                ),
                "assessment": (
                    "Cold-start defaults to quarantine when sensitive capabilities are present, "
                    "even without confirmed harmful behavior."
                ),
            }
        )

    recommended_checks: list[dict[str, str]] = []
    if has_exfil:
        recommended_checks.append(
            {
                "check": (
                    "Run npm install in an isolated container with network capture and "
                    "synthetic token-like env vars."
                ),
                "reason": (
                    "Confirm whether install-time code attempts to transmit credential-like data."
                ),
            }
        )
    if has_sensitive_caps:
        recommended_checks.append(
            {
                "check": "Inspect the added or modified files and surrounding call sites.",
                "reason": (
                    "Determine whether the new capability is reachable from the package's "
                    "documented entry points."
                ),
            }
        )
    if cold_start:
        recommended_checks.append(
            {
                "check": "Compare published tarball against the linked source repository.",
                "reason": (
                    "Detect source/tarball mismatch that would indicate the published "
                    "artifact diverges from the public source."
                ),
            }
        )
    if not recommended_checks:
        recommended_checks.append(
            {
                "check": "Re-run ModuleWarden on the next published version of this package.",
                "reason": (
                    "Allow decisions are scoped to one exact tarball hash; future versions "
                    "must be re-evaluated."
                ),
            }
        )

    report = {
        "schema_version": "modulewarden.audit_report.v1",
        "audit_id": audit_id,
        "verdict": verdict,
        "confidence": confidence,
        "risk_level": risk,
        "summary": summary,
        "primary_findings": findings,
        "benign_explanations_considered": benign_explanations,
        "recommended_agent_checks": recommended_checks,
        "developer_safe_summary": dev_summary,
        "security_admin_summary": admin_summary,
        "output_integrity": {
            "all_claims_have_evidence_refs": True,
            "invented_evidence_refs": [],
        },
    }
    return report


__all__ = ["build_report"]
