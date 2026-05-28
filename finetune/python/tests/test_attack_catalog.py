"""Smoke + structural tests for the attack-pattern catalog.

These tests do NOT execute any injected payloads or run the synthetic
generator end-to-end. They only verify that the YAML catalog loads, has
the expected shape, and the PatternInjector can be instantiated from it.

Heavy generation tests live alongside the slurm scripts and are run
out-of-band before each H100 SFT submission.
"""

from __future__ import annotations

import sys
from pathlib import Path

import pytest
import yaml

PY_ROOT = Path(__file__).resolve().parents[1]
CATALOG_PATH = PY_ROOT / "data" / "patterns" / "attack-catalog.yaml"

# Make `from data.patterns.injector import PatternInjector` resolve.
if str(PY_ROOT) not in sys.path:
    sys.path.insert(0, str(PY_ROOT))

from data.patterns.injector import PatternInjector  # noqa: E402


def test_catalog_loads_as_yaml():
    """The catalog parses cleanly as a YAML document."""
    assert CATALOG_PATH.exists(), f"missing catalog at {CATALOG_PATH}"
    with CATALOG_PATH.open(encoding="utf-8") as fh:
        doc = yaml.safe_load(fh)
    assert isinstance(doc, dict), "catalog root should be a mapping"
    assert "patterns" in doc, "catalog should expose a 'patterns' list"
    assert isinstance(doc["patterns"], list), "'patterns' should be a list"


def test_catalog_has_at_least_twenty_patterns():
    """The catalog should ship at least twenty distinct patterns.

    The 26-pattern figure is the documented size; we assert the lower
    bound so future curation can add or retire patterns without forcing
    a test edit.
    """
    with CATALOG_PATH.open(encoding="utf-8") as fh:
        doc = yaml.safe_load(fh)
    assert len(doc["patterns"]) >= 20, (
        f"expected at least 20 patterns, got {len(doc['patterns'])}"
    )


def test_every_pattern_has_required_fields():
    """Every entry must carry id, severity, description, and inject block.

    Severity may be either an int 1-10 or a string label that the injector
    coerces (``low``, ``medium``, ``high``, ``critical``).
    """
    from data.patterns.injector import _coerce_severity  # noqa: WPS433

    with CATALOG_PATH.open(encoding="utf-8") as fh:
        doc = yaml.safe_load(fh)
    ids_seen: set[str] = set()
    for entry in doc["patterns"]:
        assert "id" in entry, f"pattern missing id: {entry}"
        assert "severity" in entry, f"{entry['id']} missing severity"
        assert "description" in entry, f"{entry['id']} missing description"
        has_classic = isinstance(entry.get("inject"), dict)
        compact_template = (
            entry.get("injection_template_js")
            or entry.get("injection_template_py")
            or entry.get("injection_template_php")
            or entry.get("injection_template")
        )
        has_compact = (
            isinstance(compact_template, str)
            and bool(entry.get("injection_target_files"))
        )
        assert has_classic or has_compact, (
            f"{entry['id']} has neither classic inject block nor a compact "
            "injection_template_(js|py|php) + injection_target_files pair"
        )
        assert entry["id"] not in ids_seen, (
            f"duplicate pattern id: {entry['id']}"
        )
        ids_seen.add(entry["id"])
        coerced = _coerce_severity(entry["severity"])
        assert 1 <= coerced <= 10, (
            f"{entry['id']} severity {entry['severity']!r} did not coerce into 1-10"
        )


def test_injector_loads_catalog():
    """PatternInjector can read the shipped catalog without crashing."""
    inj = PatternInjector(catalog_path=CATALOG_PATH)
    assert inj is not None
    assert len(inj.patterns) >= 20, (
        f"injector loaded only {len(inj.patterns)} patterns"
    )


def test_severity_distribution_is_reasonable():
    """Catalog should mix severities, not all 10s or all 1s.

    Coerce through the injector to handle either int or string severities.
    """
    from data.patterns.injector import _coerce_severity  # noqa: WPS433

    with CATALOG_PATH.open(encoding="utf-8") as fh:
        doc = yaml.safe_load(fh)
    sevs = [_coerce_severity(p["severity"]) for p in doc["patterns"]]
    assert max(sevs) >= 7, "expected at least one high-severity pattern"
    assert min(sevs) <= 6, "expected some medium / lower severity patterns"


def test_synthesize_data_script_imports_cleanly():
    """The driver script can be imported without side effects."""
    script_path = PY_ROOT / "scripts" / "synthesize_data.py"
    assert script_path.exists()
    # Static parse check via compile() avoids running argparse / main().
    compile(script_path.read_text(encoding="utf-8"), str(script_path), "exec")


if __name__ == "__main__":
    pytest.main([__file__, "-v"])
