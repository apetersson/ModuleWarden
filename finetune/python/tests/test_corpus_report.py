"""Tests for the honest corpus report.

Guards two things: the report stays honest (never emits a fabricated
classifier accuracy/AUROC on this label-free set), and the headline numbers
the pitch quotes are actually derived from the shipped corpus, not stale
constants.
"""

from __future__ import annotations

from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[3]
CORPUS = REPO_ROOT / "finetune" / "corpus" / "scraped-cases.npm-enriched.jsonl"

from finetune.python.eval.corpus_report import build_report


@pytest.fixture(scope="module")
def report() -> dict:
    if not CORPUS.exists():
        pytest.skip(f"corpus not present: {CORPUS}")
    return build_report(CORPUS)


def _walk_keys(obj):
    if isinstance(obj, dict):
        for k, v in obj.items():
            yield k
            yield from _walk_keys(v)
    elif isinstance(obj, list):
        for v in obj:
            yield from _walk_keys(v)


def test_report_is_honest_no_fabricated_classifier_metric(report):
    """A label-free corpus must never carry an accuracy/auroc/precision FIELD.

    Prose disclaimers may mention these words (to say they are not reported);
    what would be dishonest is a structured metric field claiming a value.
    """
    forbidden = {"auroc", "accuracy", "precision", "f1_score", "f1"}
    for key in _walk_keys(report):
        norm = key.lower().replace("-", "_")
        assert norm not in forbidden, (
            f"report has a metric field {key!r} on a label-free corpus"
        )


def test_scale_is_real(report):
    """Scale counts come from the real file and are non-trivial."""
    s = report["scale"]
    assert s["total_cases"] > 1000
    assert s["unique_packages"] > 0
    assert s["unique_advisories"] > 0


def test_supply_chain_signal_present(report):
    """The embedded-malicious-code class (CWE-506) is the headline signal."""
    sc = report["supply_chain_signal"]
    assert sc["embedded_malicious_code_cwe_506"] > 0
    assert ("CWE-506", sc["embedded_malicious_code_cwe_506"]) in [
        tuple(x) for x in sc["top_cwes"]
    ]


def test_trainable_pairs_counted(report):
    """Vulnerable/first-patched pairs are the honest offline negative signal."""
    tp = report["trainable_pairs"]
    assert tp["with_first_patched_version"] > 0
    assert 0 <= tp["with_first_patched_pct"] <= 100


def test_gate_rule_coverage_is_two_of_five(report):
    """Only release-age + source-match are computable offline at corpus scale."""
    gr = report["gate_rule_coverage"]
    assert gr["total_rules"] == 5
    assert set(gr["computable_offline"]) == {"release-age", "source-match"}
