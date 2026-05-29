"""B3 grounding-refs validation (BitGN-PAC reference, MIT; fit note 07 sec 2.2).

The audit system prompt instructs the model to "cite only evidence ids from the
dossier's evidence_index", but nothing enforces it at runtime. A model can
hallucinate an evidence id that is not in the dossier, producing a finding that
looks grounded but is not.

This module closes that gap with a single post-generation check:
`unresolved_evidence_refs` collects every evidence id cited in the report's
findings and returns the ones that are NOT present in the dossier's
evidence_index. A non-empty result means the report cited evidence that does
not exist; the caller can flag the report or re-request generation.

Pure functions over dicts. No model, no I/O, never raises on malformed input.
"""

from __future__ import annotations

from typing import Any, Iterable, Mapping


def _evidence_index_ids(evidence_index: Any) -> set[str]:
    """Collect the set of valid evidence ids from a dossier evidence_index.

    The contract evidence_index is a list of objects each carrying an `id`
    (see finetune/contracts/audit-dossier.schema.json). For robustness this
    also accepts a mapping keyed by id, and tolerates list entries that are
    bare id strings. Anything else contributes no ids.
    """
    ids: set[str] = set()
    if isinstance(evidence_index, Mapping):
        for key in evidence_index.keys():
            if isinstance(key, str):
                ids.add(key)
        return ids
    if isinstance(evidence_index, (list, tuple)):
        for entry in evidence_index:
            if isinstance(entry, Mapping):
                eid = entry.get("id")
                if isinstance(eid, str):
                    ids.add(eid)
            elif isinstance(entry, str):
                ids.add(entry)
    return ids


def _cited_refs(report: Any) -> list[str]:
    """Collect, in order, every evidence id cited in the report's findings.

    Citations live in `primary_findings[].evidence_refs` per the audit-report
    contract (finetune/contracts/audit-report.schema.json). Order is preserved
    so the caller can report the first offending citation deterministically;
    duplicates are kept (a ref cited twice but missing is still one problem,
    but we let the caller dedupe if desired).
    """
    cited: list[str] = []
    if not isinstance(report, Mapping):
        return cited
    findings = report.get("primary_findings")
    if not isinstance(findings, (list, tuple)):
        return cited
    for finding in findings:
        if not isinstance(finding, Mapping):
            continue
        refs = finding.get("evidence_refs")
        if not isinstance(refs, (list, tuple)):
            continue
        for ref in refs:
            if isinstance(ref, str):
                cited.append(ref)
    return cited


def unresolved_evidence_refs(
    report: Mapping[str, Any],
    evidence_index: Any,
) -> list[str]:
    """Return cited evidence ids in `report` that are absent from the dossier.

    Args:
        report: an AuditReport dict (or report-shaped mapping). Citations are
            read from `primary_findings[].evidence_refs`.
        evidence_index: the dossier's `evidence_index` (a list of evidence
            objects with `id`, a mapping keyed by id, or a list of id strings).
            You may also pass the whole dossier mapping; if `report` carries no
            evidence_index of its own, pass `dossier["evidence_index"]`.

    Returns:
        The deduplicated, order-preserving list of cited ids NOT present in the
        evidence index. Empty list means every citation resolves (the report is
        grounded). Never raises.
    """
    # Accept either the raw evidence_index or a full dossier mapping that
    # contains one, so callers do not have to dig the field out themselves.
    if isinstance(evidence_index, Mapping) and "evidence_index" in evidence_index:
        index_source: Any = evidence_index["evidence_index"]
    else:
        index_source = evidence_index

    valid_ids = _evidence_index_ids(index_source)

    unresolved: list[str] = []
    seen: set[str] = set()
    for ref in _cited_refs(report):
        if ref not in valid_ids and ref not in seen:
            unresolved.append(ref)
            seen.add(ref)
    return unresolved


def is_grounded(report: Mapping[str, Any], evidence_index: Any) -> bool:
    """True if every cited evidence id resolves against the index."""
    return not unresolved_evidence_refs(report, evidence_index)


__all__ = [
    "unresolved_evidence_refs",
    "is_grounded",
]
