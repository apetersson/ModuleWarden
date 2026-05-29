"""Tests for B3 grounding-refs validation (unresolved_evidence_refs).

Synthetic reports and dossiers. Verifies a report citing a missing evidence id
is flagged, a fully-grounded report is clean, and malformed input is tolerated.
"""

from __future__ import annotations

from finetune.python.serving.grounding import is_grounded, unresolved_evidence_refs


def _evidence_index():
    return [
        {"id": "ev.file.001", "kind": "file_diff", "summary": "x"},
        {"id": "ev.cap.002", "kind": "static_capability", "summary": "y"},
    ]


def _report(*ref_lists):
    return {
        "schema_version": "modulewarden.audit_report.v1",
        "primary_findings": [
            {"finding_id": f"f{i}", "evidence_refs": list(refs)}
            for i, refs in enumerate(ref_lists)
        ],
    }


def test_fully_grounded_report_has_no_unresolved():
    report = _report(["ev.file.001"], ["ev.cap.002", "ev.file.001"])
    assert unresolved_evidence_refs(report, _evidence_index()) == []
    assert is_grounded(report, _evidence_index()) is True


def test_missing_evidence_id_is_flagged():
    report = _report(["ev.file.001"], ["ev.GHOST.999"])
    unresolved = unresolved_evidence_refs(report, _evidence_index())
    assert unresolved == ["ev.GHOST.999"]
    assert is_grounded(report, _evidence_index()) is False


def test_multiple_missing_ids_order_preserved_and_deduped():
    report = _report(["ev.miss.a", "ev.file.001"], ["ev.miss.b", "ev.miss.a"])
    assert unresolved_evidence_refs(report, _evidence_index()) == [
        "ev.miss.a",
        "ev.miss.b",
    ]


def test_accepts_full_dossier_mapping():
    # Passing the whole dossier (which contains evidence_index) must work.
    dossier = {"evidence_index": _evidence_index()}
    report = _report(["ev.zzz"])
    assert unresolved_evidence_refs(report, dossier) == ["ev.zzz"]


def test_evidence_index_as_mapping_keyed_by_id():
    index = {"ev.file.001": {"kind": "file_diff"}, "ev.cap.002": {}}
    report = _report(["ev.cap.002"], ["ev.nope"])
    assert unresolved_evidence_refs(report, index) == ["ev.nope"]


def test_evidence_index_as_bare_id_list():
    report = _report(["ev.x"], ["ev.y"])
    assert unresolved_evidence_refs(report, ["ev.x"]) == ["ev.y"]


def test_report_with_no_findings_is_clean():
    report = {"primary_findings": []}
    assert unresolved_evidence_refs(report, _evidence_index()) == []


def test_tolerates_malformed_report():
    assert unresolved_evidence_refs(None, _evidence_index()) == []
    assert unresolved_evidence_refs({}, _evidence_index()) == []
    assert unresolved_evidence_refs({"primary_findings": "bad"}, _evidence_index()) == []


def test_tolerates_malformed_finding_and_refs():
    report = {
        "primary_findings": [
            "not-a-dict",
            {"finding_id": "f1"},  # no evidence_refs
            {"finding_id": "f2", "evidence_refs": "not-a-list"},
            {"finding_id": "f3", "evidence_refs": [None, 7, "ev.miss"]},
        ]
    }
    assert unresolved_evidence_refs(report, _evidence_index()) == ["ev.miss"]


def test_tolerates_malformed_evidence_index():
    report = _report(["ev.anything"])
    # None/garbage index means no valid ids, so the cited ref is unresolved.
    assert unresolved_evidence_refs(report, None) == ["ev.anything"]
    assert unresolved_evidence_refs(report, 12345) == ["ev.anything"]
