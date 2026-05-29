"""Tests for the pluggable static-scanner evidence enricher.

These tests never invoke a real scanner binary. They exercise two paths:

1. Graceful skip when a tool is absent (``shutil.which`` patched to None).
2. Normalization of canned JSON output from each tool into dossier
   evidence rows (fixture JSON, no real tool required).

The evidence rows are validated against the ``evidence`` ``$def`` in the
canonical dossier schema so the enricher output stays schema-conformant.
"""

from __future__ import annotations

import json
from pathlib import Path
from unittest import mock

import jsonschema
import pytest

from finetune.python.pipeline import scanner_evidence as se

# --------------------------------------------------------------------------- #
# Schema fixture: load the evidence $def so we can validate every row.
# --------------------------------------------------------------------------- #

# test file is finetune/python/tests/ -> parents[2] == finetune/
_SCHEMA_PATH = (
    Path(__file__).resolve().parents[2]
    / "contracts"
    / "audit-dossier.schema.json"
)


@pytest.fixture(scope="module")
def evidence_validator() -> jsonschema.Draft202012Validator:
    full = json.loads(_SCHEMA_PATH.read_text(encoding="utf-8"))
    evidence_def = full["$defs"]["evidence"]
    # Inline the $defs so $ref inside the evidence def (none here, but safe)
    # still resolves.
    evidence_def = dict(evidence_def)
    evidence_def["$defs"] = full["$defs"]
    return jsonschema.Draft202012Validator(evidence_def)


def _assert_schema_conformant(rows, validator):
    assert isinstance(rows, list)
    assert rows, "enricher must always return at least one evidence row"
    for row in rows:
        validator.validate(row)
        # Schema requires exactly these keys (additionalProperties: false).
        assert set(row) == {"id", "kind", "path", "summary", "raw_excerpt_available"}


# --------------------------------------------------------------------------- #
# Canned tool output fixtures (real-ish JSON shapes, trimmed).
# --------------------------------------------------------------------------- #

SEMGREP_JSON = json.dumps(
    {
        "results": [
            {
                "check_id": "javascript.lang.security.detect-child-process",
                "path": "index.js",
                "start": {"line": 12},
                "extra": {
                    "severity": "ERROR",
                    "message": "Detected child_process exec with dynamic input.",
                },
            }
        ],
        "errors": [],
    }
)

OSV_JSON = json.dumps(
    {
        "results": [
            {
                "source": {"path": "package-lock.json"},
                "packages": [
                    {
                        "package": {"name": "lodash", "version": "4.17.4"},
                        "vulnerabilities": [
                            {
                                "id": "GHSA-jf85-cpcp-j695",
                                "summary": "Prototype Pollution in lodash",
                            }
                        ],
                    }
                ],
            }
        ]
    }
)

# TruffleHog emits NDJSON; the enricher accepts a parsed list too.
TRUFFLEHOG_JSON = json.dumps(
    [
        {
            "DetectorName": "AWS",
            "Verified": True,
            "SourceMetadata": {
                "Data": {"Filesystem": {"file": "config/secret.js"}}
            },
        }
    ]
)

GRYPE_JSON = json.dumps(
    {
        "matches": [
            {
                "vulnerability": {"id": "CVE-2021-23337", "severity": "High"},
                "artifact": {
                    "name": "lodash",
                    "version": "4.17.4",
                    "locations": [{"path": "node_modules/lodash/package.json"}],
                },
            }
        ]
    }
)


# --------------------------------------------------------------------------- #
# (a) Graceful-skip when a tool is absent.
# --------------------------------------------------------------------------- #


def test_all_tools_absent_skips_cleanly(evidence_validator):
    """With which() -> None for everything, the enricher degrades, never crashes."""
    with mock.patch.object(se.shutil, "which", return_value=None):
        rows = se.enrich_with_scanners("/tmp/nonexistent-pkg")
    _assert_schema_conformant(rows, evidence_validator)
    kinds = {r["kind"] for r in rows}
    assert kinds == {"scanner_skipped"}
    # One skip row per scanner family (semgrep, osv, trufflehog, syft_grype).
    assert len(rows) == 4


@pytest.mark.parametrize(
    "runner",
    [se.run_semgrep, se.run_osv, se.run_trufflehog, se.run_syft_grype],
)
def test_each_runner_skips_when_absent(runner, evidence_validator):
    with mock.patch.object(se.shutil, "which", return_value=None):
        rows = runner("/tmp/pkg")
    _assert_schema_conformant(rows, evidence_validator)
    assert all(r["kind"] == "scanner_skipped" for r in rows)


def test_absent_tool_never_runs_subprocess():
    """A skipped tool must never reach subprocess.run."""
    with mock.patch.object(se.shutil, "which", return_value=None), mock.patch.object(
        se.subprocess, "run"
    ) as run_mock:
        se.enrich_with_scanners("/tmp/pkg")
    run_mock.assert_not_called()


# --------------------------------------------------------------------------- #
# (b) Parse canned JSON from each tool into evidence items (no real tool).
# --------------------------------------------------------------------------- #


def _patch_present_and_run(binary_present: str, stdout: str):
    """Pretend ``binary_present`` exists and subprocess returns ``stdout``."""
    completed = mock.Mock()
    completed.stdout = stdout
    completed.stderr = ""
    completed.returncode = 1  # tools exit non-zero on findings; must be tolerated
    which = lambda name: f"/usr/bin/{name}" if name == binary_present else None
    return (
        mock.patch.object(se.shutil, "which", side_effect=which),
        mock.patch.object(se.subprocess, "run", return_value=completed),
    )


def test_semgrep_parses_finding(evidence_validator):
    which_p, run_p = _patch_present_and_run("semgrep", SEMGREP_JSON)
    with which_p, run_p:
        rows = se.run_semgrep("/tmp/pkg")
    _assert_schema_conformant(rows, evidence_validator)
    finding = next(r for r in rows if r["kind"] == "scanner_sast")
    assert "child_process" in finding["summary"]
    assert finding["path"] == "index.js:12"


def test_osv_parses_vuln(evidence_validator):
    which_p, run_p = _patch_present_and_run("osv-scanner", OSV_JSON)
    with which_p, run_p:
        rows = se.run_osv("/tmp/pkg")
    _assert_schema_conformant(rows, evidence_validator)
    finding = next(r for r in rows if r["kind"] == "scanner_vuln")
    assert "GHSA-jf85-cpcp-j695" in finding["summary"]
    assert "lodash@4.17.4" in finding["summary"]


def test_trufflehog_parses_secret(evidence_validator):
    which_p, run_p = _patch_present_and_run("trufflehog", TRUFFLEHOG_JSON)
    with which_p, run_p:
        rows = se.run_trufflehog("/tmp/pkg")
    _assert_schema_conformant(rows, evidence_validator)
    finding = next(r for r in rows if r["kind"] == "scanner_secret")
    assert "AWS" in finding["summary"]
    assert "verified live" in finding["summary"]
    assert finding["path"] == "config/secret.js"


def test_grype_parses_match(evidence_validator):
    which_p, run_p = _patch_present_and_run("grype", GRYPE_JSON)
    with which_p, run_p:
        rows = se.run_syft_grype("/tmp/pkg")
    _assert_schema_conformant(rows, evidence_validator)
    finding = next(r for r in rows if r["kind"] == "scanner_vuln")
    assert "CVE-2021-23337" in finding["summary"]


# --------------------------------------------------------------------------- #
# Robustness: malformed output, timeout, capability mapping.
# --------------------------------------------------------------------------- #


def test_malformed_json_records_error_never_raises(evidence_validator):
    which_p, run_p = _patch_present_and_run("semgrep", "not json at all <<<")
    with which_p, run_p:
        rows = se.run_semgrep("/tmp/pkg")
    _assert_schema_conformant(rows, evidence_validator)
    assert any(r["kind"] == "scanner_error" for r in rows)


def test_timeout_records_error_never_raises(evidence_validator):
    import subprocess as real_subprocess

    which = lambda name: "/usr/bin/semgrep" if name == "semgrep" else None
    with mock.patch.object(se.shutil, "which", side_effect=which), mock.patch.object(
        se.subprocess,
        "run",
        side_effect=real_subprocess.TimeoutExpired(cmd="semgrep", timeout=1),
    ):
        rows = se.run_semgrep("/tmp/pkg", timeout=1)
    _assert_schema_conformant(rows, evidence_validator)
    err = next(r for r in rows if r["kind"] == "scanner_error")
    assert "timed out" in err["summary"]


def test_capability_deltas_from_scanner_rows():
    rows = [
        se._evidence("ev.scan.semgrep.001", "scanner_sast", "a.js", "x"),
        se._evidence("ev.scan.trufflehog.001", "scanner_secret", "b.js", "y"),
        se._evidence("ev.scan.osv.001", "scanner_vuln", "lock", "z"),
        se._evidence("ev.scan.semgrep.skipped", "scanner_skipped", None, "skip"),
        se._evidence("ev.scan.semgrep.clean", "scanner_note", None, "clean"),
    ]
    deltas = se.scanner_capability_deltas(rows)
    caps = {d["capability"] for d in deltas}
    assert caps == {
        "static_pattern_match",
        "embedded_secret",
        "known_vulnerable_dependency",
    }
    # skip/note rows must not become capability deltas.
    assert len(deltas) == 3
    for d in deltas:
        assert d["severity_hint"] in ("info", "low", "medium", "high", "critical")
        assert d["change"] == "added"
        assert set(d) == {
            "evidence_ref",
            "capability",
            "change",
            "severity_hint",
            "summary",
        }


def test_no_findings_emits_clean_note(evidence_validator):
    which_p, run_p = _patch_present_and_run("osv-scanner", json.dumps({"results": []}))
    with which_p, run_p:
        rows = se.run_osv("/tmp/pkg")
    _assert_schema_conformant(rows, evidence_validator)
    assert any(r["kind"] == "scanner_note" and "no findings" in r["summary"] for r in rows)
