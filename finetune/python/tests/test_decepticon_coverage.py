"""Decepticon detection-coverage scorer: invariants and the in-sync-with-mapper contract."""

from __future__ import annotations

from finetune.python.decepticon import coverage, mapper


def test_every_mapper_capability_has_a_tier():
    # In-sync contract: if the mapper gains a capability, coverage must tier it.
    for cap in mapper._CAPABILITY_TO_ATTACK:
        assert cap in coverage._DETECTION_TIER, f"capability {cap!r} has no detection tier"


def test_all_tiers_valid():
    for cap, info in coverage._DETECTION_TIER.items():
        assert info["tier"] in coverage.VALID_TIERS, f"{cap}: bad tier {info['tier']!r}"
        assert info["detected_by"] and info["rationale"]


def test_matrix_one_row_per_capability():
    rows = coverage.coverage_matrix()
    assert len(rows) == len(mapper._CAPABILITY_TO_ATTACK)
    caps = {r["capability"] for r in rows}
    assert caps == set(mapper._CAPABILITY_TO_ATTACK)


def test_summary_counts_add_up():
    s = coverage.coverage_summary()
    assert sum(s["by_tier"].values()) == s["techniques_total"]
    assert 0.0 <= s["deterministic_coverage"] <= 1.0


def test_lifecycle_script_is_the_hard_detection():
    # The install-scripts gate rule is the one deterministic catch.
    rows = {r["capability"]: r for r in coverage.coverage_matrix()}
    assert rows["lifecycle_script"]["detection_tier"] == "gate_rule"


def test_blind_spots_are_capability_keyed_and_expected():
    s = coverage.coverage_summary()
    joined = " ".join(s["blind_spots"])
    for cap in ("native_or_wasm", "dynamic_code_execution", "behavioral_change_runtime"):
        assert cap in joined, f"{cap} should be a blind spot"


def test_render_markdown_has_a_table():
    md = coverage.render_markdown()
    assert "detection-coverage matrix" in md
    assert "| tier |" in md
