"""Seed the auditor wiki from the demo incident dossier+report pairs.

Reads ``demo/incidents/*.dossier.json`` and the matching ``*.report.json``,
converts each into one auditor package node under
``finetune/wiki/auditor/packages/``. Also rebuilds ``auditor/_index.md``
(one line per node) for the BM25 retriever.

Read-only over JSON. No package execution, no network. Idempotent: re-running
overwrites the node files with the same content.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

try:
    from finetune.wiki.nodes import write_node, iter_node_files, read_node
except ImportError:  # pragma: no cover - direct-script fallback
    import sys

    sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
    from finetune.wiki.nodes import write_node, iter_node_files, read_node

REPO_ROOT = Path(__file__).resolve().parents[2]
DEMO_INCIDENTS = REPO_ROOT / "demo" / "incidents"
CURATED = REPO_ROOT / "demo" / "curated-threat-chains.json"
AUDITOR_DIR = Path(__file__).resolve().parent / "auditor"
PACKAGES_DIR = AUDITOR_DIR / "packages"


_TYPOGRAPHIC = {
    "—": " - ",
    "–": "-",
    "→": " to ",
    "←": " from ",
    "…": "...",
    "‘": "'",
    "’": "'",
    "“": '"',
    "”": '"',
}


def _sanitize(text: str) -> str:
    """Strip typographic AI markers from source prose copied into node text."""
    for bad, good in _TYPOGRAPHIC.items():
        text = text.replace(bad, good)
    return text


def _capability_keys(dossier: dict[str, Any]) -> list[str]:
    keys: list[str] = []
    for c in dossier.get("capability_deltas") or []:
        if isinstance(c, dict):
            k = c.get("capability") or c.get("name")
            if k:
                keys.append(k)
        elif isinstance(c, str):
            keys.append(c)
    return keys


def _kill_chain_depth(capability_keys: list[str]) -> int:
    """Compute kill-chain depth without importing the read-only mapper.

    Mirrors mapper.py's phase grouping deterministically. We only need the
    count of distinct tactics for the node field; the authoritative mapper
    remains the source of truth at audit time.
    """
    cap_to_tactic = {
        "lifecycle_script": "Initial Access",
        "dynamic_code_execution": "Execution",
        "process_execution": "Execution",
        "native_or_wasm": "Execution",
        "behavioral_change_runtime": "Execution",
        "obfuscation": "Defense Evasion",
        "credential_or_env_access": "Credential Access",
        "filesystem_sensitive_access": "Collection",
        "network_access": "Exfiltration",
    }
    tactics: list[str] = []
    for k in capability_keys:
        t = cap_to_tactic.get(k)
        if t and t not in tactics:
            tactics.append(t)
    return len(tactics)


def _curated_lookup() -> dict[str, dict[str, Any]]:
    if not CURATED.exists():
        return {}
    with CURATED.open(encoding="utf-8") as fh:
        return json.load(fh)


def _advisory_ids(dossier: dict[str, Any], report: dict[str, Any]) -> list[str]:
    """Pull any GHSA / CVE strings out of the report prose, deterministically."""
    ids: list[str] = []
    blob = json.dumps(report) + json.dumps(dossier)
    import re

    for m in re.findall(r"\b(?:GHSA-[\w-]+|CVE-\d{4}-\d+)\b", blob):
        if m not in ids:
            ids.append(m)
    return ids


def _build_node_fields(
    incident_id: str,
    dossier: dict[str, Any],
    report: dict[str, Any],
    curated: dict[str, dict[str, Any]],
) -> tuple[dict[str, Any], str]:
    pkg = dossier.get("package") or {}
    name = pkg.get("name") or incident_id.rsplit("-", 1)[0]
    version = pkg.get("candidate_version") or incident_id.rsplit("-", 1)[-1]
    caps = _capability_keys(dossier)
    depth = _kill_chain_depth(caps)
    curated_entry = curated.get(f"{name}@{version}") or {}
    threat_actor = curated_entry.get("threat_actor") or "none"

    linked_nodes = [f"[[pattern/{c.replace('_', '-')}]]" for c in caps]
    if threat_actor and threat_actor != "none":
        linked_nodes.append(f"[[../decepticon/chains/{threat_actor.replace('_', '-')}]]")

    fields: dict[str, Any] = {
        "node_type": "package",
        "name": name,
        "version": version,
        "verdict": report.get("verdict") or "unknown",
        "confidence": report.get("confidence") or "medium",
        "risk_level": report.get("risk_level") or "unknown",
        "advisory_ids": _advisory_ids(dossier, report),
        "capability_signals": caps,
        "attack_chain_depth": depth,
        "threat_actor_class": threat_actor,
        "last_seen": (pkg.get("published_at") or "")[:10],
        "verdict_source": "incident_replay",
        "sft_record_ids": [dossier.get("audit_id") or f"audit_{incident_id}"],
        "linked_nodes": linked_nodes,
    }

    findings = report.get("primary_findings") or []
    evidence_lines = []
    for f in findings:
        refs = ", ".join(f.get("evidence_refs") or []) or "(no refs)"
        evidence_lines.append(
            _sanitize(
                f"- {f.get('category', '?')} [{f.get('severity', '?')}]: "
                f"{f.get('claim', '')} (evidence: {refs})"
            )
        )
    if not evidence_lines:
        evidence_lines.append("- No primary findings recorded for this release.")

    summary = _sanitize(report.get("summary") or "No summary recorded.")
    body = (
        "## Summary\n\n"
        f"{summary}\n\n"
        "## Key Evidence\n\n"
        + "\n".join(evidence_lines)
        + "\n\n## Correction Notes\n\n"
        "Empty. Confirmed verdict via incident replay.\n\n"
        "## SFT Derivation\n\n"
        "Seeded from demo incident replay. Eligible to feed the SFT corpus "
        "under source `wiki_derived` once the post-audit writer is wired."
    )
    return fields, body


def seed() -> list[Path]:
    """Seed auditor package nodes from the demo incidents. Returns paths written."""
    curated = _curated_lookup()
    written: list[Path] = []
    if not DEMO_INCIDENTS.exists():
        return written
    for dossier_path in sorted(DEMO_INCIDENTS.glob("*.dossier.json")):
        incident_id = dossier_path.name.replace(".dossier.json", "")
        report_path = DEMO_INCIDENTS / f"{incident_id}.report.json"
        if not report_path.exists():
            continue
        with dossier_path.open(encoding="utf-8") as fh:
            dossier = json.load(fh)
        with report_path.open(encoding="utf-8") as fh:
            report = json.load(fh)
        fields, body = _build_node_fields(incident_id, dossier, report, curated)
        node_path = PACKAGES_DIR / f"{incident_id}.md"
        write_node(node_path, fields, body)
        written.append(node_path)
    _rebuild_index()
    return written


def _rebuild_index() -> None:
    """Rebuild auditor/_index.md: one line per node for the retriever."""
    rows = []
    for node_path in iter_node_files(AUDITOR_DIR):
        node = read_node(node_path)
        fm = node["frontmatter"]
        rel = node_path.relative_to(AUDITOR_DIR).as_posix()
        caps = ", ".join(fm.get("capability_signals") or [])
        rows.append(
            f"- [[{rel}]] {fm.get('name', '?')}@{fm.get('version', '')} "
            f"verdict={fm.get('verdict', '?')} signals=({caps})"
        )
    content = (
        "---\nnode_type: index\nname: auditor-wiki-index\n---\n\n"
        "# Auditor Wiki Index\n\n"
        "One line per node. Read by `query.py` (BM25 retrieval).\n\n"
        + "\n".join(rows)
        + "\n"
    )
    (AUDITOR_DIR / "_index.md").write_text(content, encoding="utf-8")


if __name__ == "__main__":
    paths = seed()
    print(f"Seeded {len(paths)} auditor wiki node(s):")
    for p in paths:
        print(f"  {p.relative_to(REPO_ROOT)}")
