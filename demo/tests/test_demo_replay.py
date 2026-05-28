"""Smoke + structural tests for the live demo CLI.

Verifies that every incident fixture loads, validates against the canonical
schemas, runs through the deterministic gate to the expected gate-action,
and the cited model verdict matches the expected outcome from
finetune/python/pitch/slide-deck.md slide 5.
"""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

import pytest

try:
    import jsonschema
    _JSONSCHEMA_AVAILABLE = True
except ImportError:  # pragma: no cover - jsonschema is a soft dep
    _JSONSCHEMA_AVAILABLE = False

DEMO_ROOT = Path(__file__).resolve().parents[1]
REPO_ROOT = DEMO_ROOT.parent
INCIDENTS_DIR = DEMO_ROOT / "incidents"
CONTRACTS_DIR = REPO_ROOT / "finetune" / "contracts"

if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

from demo.run_incident_replay import (
    _available_incidents,
    _gate_verdict,
    _load_paired_fixture,
    _run_deterministic_gate,
)


# Expected outcomes from the pitch deck.
EXPECTED = {
    "postmark-mcp-1.0.16": ("block", "quarantine"),
    "postmark-mcp-1.0.12": ("allow", "allow"),
    "lodash-4.17.21": ("allow", "allow"),
}


def test_three_incidents_available():
    """The demo ships at least the three incidents the slide deck references."""
    available = set(_available_incidents())
    for incident_id in EXPECTED:
        assert incident_id in available, (
            f"slide-deck references {incident_id!r} but fixture missing"
        )


def test_every_dossier_declares_required_top_level_keys():
    """audit_dossier.v1 requires these keys; we verify the demo fixtures carry them."""
    required = {
        "schema_version",
        "audit_id",
        "audit_mode",
        "ecosystem",
        "package",
        "release_context",
    }
    for incident_id in EXPECTED:
        dossier, _ = _load_paired_fixture(incident_id)
        missing = required - set(dossier.keys())
        assert not missing, (
            f"{incident_id} dossier missing keys: {missing}"
        )
        assert dossier["schema_version"] == "modulewarden.audit_dossier.v1"


def test_every_report_declares_required_top_level_keys():
    """audit_report.v1 requires these keys; check the demo fixtures carry them."""
    required = {
        "schema_version",
        "audit_id",
        "verdict",
        "confidence",
        "risk_level",
        "summary",
    }
    for incident_id in EXPECTED:
        _, report = _load_paired_fixture(incident_id)
        missing = required - set(report.keys())
        assert not missing, (
            f"{incident_id} report missing keys: {missing}"
        )
        assert report["schema_version"] == "modulewarden.audit_report.v1"


@pytest.mark.skipif(not _JSONSCHEMA_AVAILABLE, reason="jsonschema not installed")
@pytest.mark.parametrize("incident_id", list(EXPECTED.keys()))
def test_every_dossier_validates_against_canonical_schema(incident_id):
    """Each demo dossier must validate cleanly against audit-dossier.schema.json.

    The lighter required-keys test above catches missing top-level fields but
    misses additionalProperties false enum mismatches, and structural mismatches
    inside sub-objects. This is the strict check.
    """
    dossier, _ = _load_paired_fixture(incident_id)
    schema = json.loads(
        (CONTRACTS_DIR / "audit-dossier.schema.json").read_text(encoding="utf-8")
    )
    jsonschema.validate(dossier, schema)


@pytest.mark.skipif(not _JSONSCHEMA_AVAILABLE, reason="jsonschema not installed")
@pytest.mark.parametrize("incident_id", list(EXPECTED.keys()))
def test_every_report_validates_against_canonical_schema(incident_id):
    """Each demo report must validate cleanly against audit-report.schema.json.

    Catches finding.category enum drift, agent_check shape mismatch,
    output_integrity field drift, and other additionalProperties false rejects
    that the lighter required-keys test misses.
    """
    _, report = _load_paired_fixture(incident_id)
    schema = json.loads(
        (CONTRACTS_DIR / "audit-report.schema.json").read_text(encoding="utf-8")
    )
    jsonschema.validate(report, schema)


@pytest.mark.skipif(not _JSONSCHEMA_AVAILABLE, reason="jsonschema not installed")
@pytest.mark.parametrize("incident_id", list(EXPECTED.keys()))
def test_report_evidence_refs_resolve_into_dossier_evidence_index(incident_id):
    """Every evidence_ref a report's finding cites must exist in the paired dossier's evidence_index.

    Catches drift where a report names ev.cap.999 but the dossier never declared
    it. The pitch claims 'evidence_citation_accuracy' as a tracked metric; the
    demo fixtures themselves should not violate it.
    """
    dossier, report = _load_paired_fixture(incident_id)
    declared = {e.get("id") for e in (dossier.get("evidence_index") or [])}
    for finding in report.get("primary_findings") or []:
        for ref in finding.get("evidence_refs") or []:
            assert ref in declared, (
                f"{incident_id} report finding {finding.get('finding_id')!r} "
                f"cites evidence_ref {ref!r} which is not declared in the dossier"
            )


@pytest.mark.parametrize("incident_id, expected", list(EXPECTED.items()))
def test_model_verdict_matches_slide_deck(incident_id, expected):
    """Model verdict (verdict field) matches the outcome the slide claims."""
    expected_model_verdict, _ = expected
    _, report = _load_paired_fixture(incident_id)
    assert report["verdict"].lower() == expected_model_verdict


@pytest.mark.parametrize("incident_id, expected", list(EXPECTED.items()))
def test_deterministic_gate_matches_slide_deck(incident_id, expected):
    """Deterministic gate action matches the slide demo outcome."""
    _, expected_gate = expected
    dossier, _ = _load_paired_fixture(incident_id)
    gate_results = _run_deterministic_gate(dossier)
    action = _gate_verdict(gate_results)
    assert action == expected_gate, (
        f"{incident_id}: gate action {action!r}, expected {expected_gate!r}"
    )


def test_cli_list_smoke():
    """python -m demo.run_incident_replay --list returns 0 and names incidents."""
    proc = subprocess.run(
        [sys.executable, "-m", "demo.run_incident_replay", "--list"],
        cwd=REPO_ROOT,
        capture_output=True,
        text=True,
        timeout=15,
    )
    assert proc.returncode == 0, proc.stderr
    for incident_id in EXPECTED:
        assert incident_id in proc.stdout


def test_cli_replay_postmark_1016():
    """Replaying the centerpiece incident returns 0 and prints BLOCK."""
    proc = subprocess.run(
        [
            sys.executable,
            "-m",
            "demo.run_incident_replay",
            "--incident",
            "postmark-mcp-1.0.16",
            "--no-color",
            "--no-write",
        ],
        cwd=REPO_ROOT,
        capture_output=True,
        text=True,
        timeout=15,
    )
    assert proc.returncode == 0, proc.stderr
    assert "VERDICT: BLOCK" in proc.stdout
    assert "FAIL" in proc.stdout
    assert "postmark-mcp" in proc.stdout
