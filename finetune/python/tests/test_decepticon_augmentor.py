"""Tests for the SFT kill-chain augmentor."""

from __future__ import annotations

import json

from finetune.python.pipeline.decepticon_augmentor import augment_record


def _rec(caps, verdict="block"):
    dossier = {"package": {"name": "x"}, "capability_deltas": [{"capability": c} for c in caps]}
    report = {"schema_version": "v1", "verdict": verdict}
    return {
        "split": "train",
        "messages": [
            {"role": "system", "content": "auditor"},
            {"role": "user", "content": json.dumps(dossier)},
            {"role": "assistant", "content": json.dumps(report)},
        ],
    }


def test_augments_record_with_capabilities():
    rec = _rec(["lifecycle_script", "credential_or_env_access", "network_access"])
    new_rec, changed = augment_record(rec)
    assert changed is True
    report = json.loads(new_rec["messages"][-1]["content"])
    kc = report["kill_chain_narrative"]
    assert kc["technique_ids"][0] == "T1195.002"
    assert kc["technique_ids"][-1] == "T1041"
    # the verdict target is untouched - augmentation never rewrites the verdict
    assert report["verdict"] == "block"


def test_record_without_capabilities_left_honest():
    rec = _rec([])
    new_rec, changed = augment_record(rec)
    assert changed is False
    report = json.loads(new_rec["messages"][-1]["content"])
    assert "kill_chain_narrative" not in report


def test_malformed_record_is_passed_through():
    rec = {"split": "train", "messages": [{"role": "system", "content": "x"}]}
    new_rec, changed = augment_record(rec)
    assert changed is False
    assert new_rec is rec
