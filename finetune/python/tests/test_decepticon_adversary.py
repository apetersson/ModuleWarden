"""Decepticon adversarial generator: safety invariant, scoring, offline operation."""

from __future__ import annotations

import json

from finetune.python.decepticon import adversary, mapper


def test_synthesize_count_and_in_catalog():
    scen = adversary.synthesize(15, seed=7)
    assert len(scen) == 15
    for s in scen:
        caps = [c["capability"] for c in s["capability_deltas"]]
        assert caps, "scenario must have at least one capability"
        for c in caps:
            assert c in adversary.CATALOG, f"invented capability {c!r} outside the mapper catalog"


def test_score_gate_rule_vs_evasive():
    # lifecycle_script is the one gate_rule capability: caught, not evasive.
    caught = adversary.score_scenario([{"capability": "lifecycle_script"}, {"capability": "network_access"}])
    assert caught["detected_tier"] == "gate_rule"
    assert caught["evades_hard_gate"] is False
    # blind/weak only: evades the hard gate.
    evasive = adversary.score_scenario([{"capability": "dynamic_code_execution"}, {"capability": "network_access"}])
    assert evasive["evades_hard_gate"] is True
    assert evasive["detected_tier"] in ("static_signal", "blind_spot")


def test_generate_hard_negatives_offline():
    res = adversary.generate_hard_negatives(20, seed=7, use_model=False)
    assert res["n_total"] == 20
    assert 0 <= res["n_hard_negatives"] <= res["n_total"]
    assert 0.0 <= res["evasion_rate"] <= 1.0
    # every hard negative actually evades the hard gate
    for s in res["hard_negatives"]:
        assert s["detection"]["evades_hard_gate"] is True


def test_use_model_does_not_break_offline():
    # No endpoint configured: model enrichment returns nothing, deterministic core still works.
    res = adversary.generate_hard_negatives(10, seed=7, use_model=True)
    assert res["n_total"] >= 10


def test_to_sft_hard_negative_shape():
    res = adversary.generate_hard_negatives(20, seed=7)
    assert res["hard_negatives"], "expected at least one evasive scenario"
    rec = adversary.to_sft_hard_negative(res["hard_negatives"][0])
    assert rec["split"] == "train"
    assert rec["meta"]["source"] == "decepticon_hard_negative"
    roles = [m["role"] for m in rec["messages"]]
    assert roles == ["system", "user", "assistant"]
    report = json.loads(rec["messages"][-1]["content"])
    assert report["verdict"] == "block"  # the label the defense SHOULD reach


def test_detection_gaps_summary():
    res = adversary.generate_hard_negatives(20, seed=7)
    gaps = adversary.detection_gaps_summary(res)
    assert 0.0 <= gaps["evasion_rate"] <= 1.0
    assert isinstance(gaps["technique_frequency_in_evasions"], dict)
