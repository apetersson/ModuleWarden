"""Tests for the figshare NPM-malware dataset adapter.

These run on a tiny SYNTHETIC sample (no 6.55 GB figshare download). They
confirm the adapter imports, maps labels honestly, dedups, skips malformed
records, and emits records that validate against the canonical
scraped-case.v1 schema in finetune/contracts/.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from finetune.python.data import figshare_adapter as fa

REPO_ROOT = Path(__file__).resolve().parents[3]
CONTRACTS = REPO_ROOT / "finetune" / "contracts"

_FIXED_TS = "2026-05-29T00:00:00Z"


def _validator():
    try:
        import jsonschema
    except ImportError:
        pytest.skip("jsonschema not installed")
    schema = json.loads(
        (CONTRACTS / "scraped-case.schema.json").read_text(encoding="utf-8")
    )
    return jsonschema.Draft202012Validator(schema)


def test_synthetic_sample_maps_two_valid_records():
    cases = list(fa.convert(fa.synthetic_records(), scraped_at=_FIXED_TS))
    # 5 inputs: 2 valid, 1 missing-name (skip), 1 duplicate (skip), 1 unknown-label (skip).
    assert len(cases) == 2
    by_pkg = {c["package"]: c for c in cases}
    assert set(by_pkg) == {"left-pad-stealer", "is-even"}


def test_label_maps_to_case_type_honestly():
    cases = {c["package"]: c for c in fa.convert(fa.synthetic_records(), scraped_at=_FIXED_TS)}
    assert cases["left-pad-stealer"]["case_type"] == "incident_replay"  # malicious
    assert cases["is-even"]["case_type"] == "benign_neighbor"  # benign


def test_malicious_versions_vs_benign_versions_routed_correctly():
    cases = {c["package"]: c for c in fa.convert(fa.synthetic_records(), scraped_at=_FIXED_TS)}
    mal = cases["left-pad-stealer"]
    ben = cases["is-even"]
    assert mal["candidate_versions"] and mal["candidate_versions"][0]["role"] == "likely_affected"
    assert mal["benign_neighbor_versions"] == []
    assert ben["benign_neighbor_versions"] and ben["benign_neighbor_versions"][0]["role"] == "benign_before"
    assert ben["candidate_versions"] == []


def test_dedup_on_repeated_record():
    # The synthetic sample contains a duplicate left-pad-stealer row.
    cases = list(fa.convert(fa.synthetic_records(), scraped_at=_FIXED_TS))
    ids = [c["case_id"] for c in cases]
    assert len(ids) == len(set(ids))


def test_malformed_and_unknown_label_skipped():
    # Missing-name and unknown-label rows must not appear.
    pkgs = {c["package"] for c in fa.convert(fa.synthetic_records(), scraped_at=_FIXED_TS)}
    assert "mystery-pkg" not in pkgs
    assert len(pkgs) == 2


def test_normalize_label_aliases():
    assert fa._normalize_label("malware") == "malicious"
    assert fa._normalize_label(1) == "malicious"
    assert fa._normalize_label(True) == "malicious"
    assert fa._normalize_label("clean") == "benign"
    assert fa._normalize_label(0) == "benign"
    assert fa._normalize_label("???") is None
    assert fa._normalize_label(None) is None


def test_figshare_provenance_is_recorded():
    cases = {c["package"]: c for c in fa.convert(fa.synthetic_records(), scraped_at=_FIXED_TS)}
    mal = cases["left-pad-stealer"]
    assert mal["case_id"].startswith("figshare_")
    assert any("figshare" in ref for ref in mal["references"])
    assert "figshare" in mal["summary"].lower()
    # Closed enum: figshare maps to the "manual" source value.
    assert mal["source"] == "manual"


def test_emitted_records_validate_against_scraped_case_schema():
    validator = _validator()
    cases = list(fa.convert(fa.synthetic_records(), scraped_at=_FIXED_TS))
    assert cases, "no records emitted"
    for case in cases:
        errors = list(validator.iter_errors(case))
        assert not errors, f"{case['case_id']} failed schema: {[e.message for e in errors[:5]]}"


def test_convert_path_reads_jsonl_file(tmp_path):
    sample = tmp_path / "figshare_meta.jsonl"
    lines = [json.dumps(r) for r in fa.synthetic_records()]
    sample.write_text("\n".join(lines) + "\n", encoding="utf-8")
    cases = list(fa.convert_path(sample, scraped_at=_FIXED_TS))
    assert len(cases) == 2


def test_convert_path_reads_csv_file(tmp_path):
    sample = tmp_path / "figshare_meta.csv"
    sample.write_text(
        "package_name,version,label\n"
        "evil-pkg,2.0.0,malicious\n"
        "nice-pkg,2.0.0,benign\n"
        ",3.0.0,malicious\n",  # malformed: no name
        encoding="utf-8",
    )
    cases = list(fa.convert_path(sample, scraped_at=_FIXED_TS))
    assert len(cases) == 2
    assert {c["case_type"] for c in cases} == {"incident_replay", "benign_neighbor"}


def test_write_jsonl_round_trips(tmp_path):
    src = tmp_path / "in.jsonl"
    src.write_text(
        "\n".join(json.dumps(r) for r in fa.synthetic_records()) + "\n",
        encoding="utf-8",
    )
    out = tmp_path / "out" / "cases.jsonl"
    count = fa.write_jsonl(src, out, scraped_at=_FIXED_TS)
    assert count == 2
    written = [json.loads(line) for line in out.read_text(encoding="utf-8").splitlines() if line.strip()]
    assert len(written) == 2
    assert all(w["schema_version"] == "modulewarden.scraped_case.v1" for w in written)


def test_missing_input_path_raises():
    with pytest.raises(FileNotFoundError):
        list(fa.convert_path("does-not-exist-figshare-path.jsonl"))
