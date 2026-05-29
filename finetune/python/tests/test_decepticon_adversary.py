"""Decepticon adversarial generator: safety invariant, scoring, offline operation."""

from __future__ import annotations

import json

import pytest

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


def test_to_sft_record_is_canonical_train_split():
    res = adversary.generate_hard_negatives(20, seed=7)
    rec = adversary.to_sft_record(res["hard_negatives"][0])
    assert rec["schema_version"] == "modulewarden.sft_record.v1"
    assert rec["split"] == "train", "hard negatives must be train-split only"
    assert rec["source"] == "synthetic_teacher"
    assert rec["record_id"].startswith("sft_decepticon_hardneg_")
    roles = [m["role"] for m in rec["messages"]]
    assert roles == ["system", "user", "assistant"]
    report = json.loads(rec["messages"][-1]["content"])
    assert report["verdict"] == "block"


def test_hard_negative_records_count_and_train_only():
    recs = adversary.hard_negative_records(8, seed=7)
    assert len(recs) == 8
    assert all(r["split"] == "train" for r in recs)
    assert all(r["source"] == "synthetic_teacher" for r in recs)
    # separable from real corpus rows by record_id prefix
    assert all(r["record_id"].startswith("sft_decepticon_hardneg_") for r in recs)


def test_walker_injects_hard_negatives_offline(tmp_path):
    import asyncio

    pytest.importorskip("httpx")
    from finetune.python.pipeline import corpus_walker

    scraped = tmp_path / "empty-cases.jsonl"
    scraped.write_text("", encoding="utf-8")  # zero cases -> no network
    out = tmp_path / "sft.jsonl"
    manifest = asyncio.run(
        corpus_walker.run_walker(
            scraped,
            out,
            max_cases=None,
            concurrency=2,
            registry=corpus_walker.DEFAULT_REGISTRY,
            max_tarball_bytes=corpus_walker.MAX_TARBALL_BYTES,
            request_timeout=corpus_walker.DEFAULT_REQUEST_TIMEOUT,
            manifest_path=None,
            hard_negatives=5,
        )
    )
    lines = [ln for ln in out.read_text(encoding="utf-8").splitlines() if ln.strip()]
    assert len(lines) == 5
    for ln in lines:
        rec = json.loads(ln)
        assert rec["split"] == "train"
        assert rec["source"] == "synthetic_teacher"
        assert rec["record_id"].startswith("sft_decepticon_hardneg_")
    assert manifest["counters"]["hard_negatives_injected"] == 5
    assert manifest["by_split"]["train"] == 5
