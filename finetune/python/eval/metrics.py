"""Metric calculations for the 4-arm eval matrix.

The metrics list comes from ``finetune/README.md``:

1. malicious_catch_rate - fraction of malicious cases the model verdicts as block (or quarantine).
2. false_quarantine_block_rate - fraction of benign cases the model verdicts as quarantine or block.
3. json_validity - fraction of model outputs that parse as a valid AuditReport JSON object.
4. evidence_citation_accuracy - fraction of cited evidence_refs that exist in the dossier's evidence_index.
5. missed_suspicious - count of capability deltas in the dossier that have no corresponding finding category.
6. runtime - per-arm wall-clock and per-case latency stats.
7. tool_call_count - number of agentic tool calls executed by the PI harness arms.
"""

from __future__ import annotations

import json
import re
import statistics
from typing import Any, Mapping

_JSON_BLOCK_RE = re.compile(r"\{[\s\S]*\}", re.MULTILINE)
_VALID_VERDICTS = {"allow", "quarantine", "block"}


def parse_audit_report(raw_output: str) -> dict[str, Any] | None:
    """Best-effort extraction of an AuditReport JSON object from raw model output.

    First tries strict JSON parse; if that fails, extracts the first
    ``{...}`` block and tries again. Returns ``None`` when no valid object
    can be recovered.
    """
    if not raw_output:
        return None
    try:
        candidate = json.loads(raw_output)
        if isinstance(candidate, dict):
            return candidate
    except json.JSONDecodeError:
        pass
    match = _JSON_BLOCK_RE.search(raw_output)
    if not match:
        return None
    try:
        candidate = json.loads(match.group(0))
        if isinstance(candidate, dict):
            return candidate
    except json.JSONDecodeError:
        return None
    return None


def _expected_malicious(case_type: str, expected_verdict: str | None) -> bool:
    """Decide whether a case is treated as malicious for catch-rate purposes."""
    if expected_verdict in ("block", "quarantine"):
        return True
    return case_type in ("incident_replay",)


def _expected_benign(case_type: str, expected_verdict: str | None) -> bool:
    if expected_verdict == "allow":
        return True
    return case_type == "benign_neighbor"


def per_case_metrics(
    *,
    dossier: Mapping[str, Any],
    expected_report: Mapping[str, Any] | None,
    raw_output: str,
    elapsed_s: float | None,
    tool_calls: int | None,
    case_type: str,
) -> dict[str, Any]:
    """Compute one row of per-case metrics for the matrix output."""
    parsed = parse_audit_report(raw_output)
    json_ok = isinstance(parsed, dict) and parsed.get("schema_version") == "modulewarden.audit_report.v1"
    verdict = parsed.get("verdict") if isinstance(parsed, dict) else None
    verdict_ok = isinstance(verdict, str) and verdict in _VALID_VERDICTS

    cited_refs: list[str] = []
    if isinstance(parsed, dict):
        for f in parsed.get("primary_findings") or []:
            if isinstance(f, Mapping):
                refs = f.get("evidence_refs")
                if isinstance(refs, list):
                    cited_refs.extend(str(r) for r in refs)
    dossier_ev_ids = {
        str(ev.get("id"))
        for ev in (dossier.get("evidence_index") or [])
        if isinstance(ev, Mapping) and isinstance(ev.get("id"), str)
    }
    cited_in_dossier = [r for r in cited_refs if r in dossier_ev_ids]
    citation_accuracy = (
        len(cited_in_dossier) / len(cited_refs) if cited_refs else 1.0
    )

    # Did the model name a finding category for every capability_delta the dossier flagged?
    delta_caps = {
        str(d.get("capability"))
        for d in (dossier.get("capability_deltas") or [])
        if isinstance(d, Mapping)
    }
    finding_cats = set()
    if isinstance(parsed, dict):
        for f in parsed.get("primary_findings") or []:
            if isinstance(f, Mapping):
                c = f.get("category")
                if isinstance(c, str):
                    finding_cats.add(c)
    # Use a coarse mapping for missed-detection accounting; missed = any
    # high-severity delta with no related category in the report.
    missed = 0
    if "credential_or_env_access" in delta_caps and "credential_or_env_access" not in finding_cats:
        missed += 1
    if "network_access" in delta_caps and "network_access_added" not in finding_cats:
        missed += 1
    if "lifecycle_script" in delta_caps and "lifecycle_script_added" not in finding_cats:
        missed += 1

    expected_verdict = expected_report.get("verdict") if isinstance(expected_report, Mapping) else None
    is_mal = _expected_malicious(case_type, expected_verdict)
    is_ben = _expected_benign(case_type, expected_verdict)
    caught_mal = is_mal and verdict in ("block", "quarantine")
    false_qb = is_ben and verdict in ("quarantine", "block")

    return {
        "audit_id": dossier.get("audit_id"),
        "case_type": case_type,
        "expected_verdict": expected_verdict,
        "model_verdict": verdict,
        "json_ok": bool(json_ok),
        "verdict_ok": bool(verdict_ok),
        "citation_accuracy": round(citation_accuracy, 4),
        "missed_suspicious": missed,
        "caught_malicious": bool(caught_mal),
        "false_quarantine_or_block": bool(false_qb),
        "elapsed_s": elapsed_s,
        "tool_calls": tool_calls,
    }


def aggregate_arm_metrics(rows: list[Mapping[str, Any]]) -> dict[str, Any]:
    """Aggregate per-case rows into the 7 metrics from finetune/README.md."""
    n = len(rows)
    if n == 0:
        return {
            "n_cases": 0,
            "malicious_catch_rate": 0.0,
            "false_quarantine_block_rate": 0.0,
            "json_validity": 0.0,
            "evidence_citation_accuracy": 0.0,
            "missed_suspicious_total": 0,
            "runtime_p50_s": 0.0,
            "runtime_p95_s": 0.0,
            "runtime_total_s": 0.0,
            "tool_call_total": 0,
            "tool_call_avg": 0.0,
        }
    n_mal = sum(1 for r in rows if _expected_malicious(str(r.get("case_type", "")), r.get("expected_verdict")))
    n_ben = sum(1 for r in rows if _expected_benign(str(r.get("case_type", "")), r.get("expected_verdict")))
    n_caught = sum(1 for r in rows if r.get("caught_malicious"))
    n_falseqb = sum(1 for r in rows if r.get("false_quarantine_or_block"))
    n_json_ok = sum(1 for r in rows if r.get("json_ok"))
    citation_sum = sum(float(r.get("citation_accuracy") or 0.0) for r in rows)
    missed_total = sum(int(r.get("missed_suspicious") or 0) for r in rows)
    runtimes = [float(r.get("elapsed_s") or 0.0) for r in rows]
    tool_calls = [int(r.get("tool_calls") or 0) for r in rows]
    sorted_rt = sorted(runtimes)
    p50 = statistics.median(runtimes) if runtimes else 0.0
    p95_idx = max(0, int(round(0.95 * (len(sorted_rt) - 1))))
    p95 = sorted_rt[p95_idx] if sorted_rt else 0.0
    return {
        "n_cases": n,
        "n_malicious": n_mal,
        "n_benign": n_ben,
        "malicious_catch_rate": round(n_caught / n_mal, 4) if n_mal else 0.0,
        "false_quarantine_block_rate": round(n_falseqb / n_ben, 4) if n_ben else 0.0,
        "json_validity": round(n_json_ok / n, 4),
        "evidence_citation_accuracy": round(citation_sum / n, 4),
        "missed_suspicious_total": missed_total,
        "runtime_p50_s": round(p50, 3),
        "runtime_p95_s": round(p95, 3),
        "runtime_total_s": round(sum(runtimes), 3),
        "tool_call_total": sum(tool_calls),
        "tool_call_avg": round(sum(tool_calls) / n, 3) if n else 0.0,
    }


__all__ = ["parse_audit_report", "per_case_metrics", "aggregate_arm_metrics"]
