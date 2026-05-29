"""Tests for the adaptive-steering layer: registry, conditional gate (CAST),
and the calibration guardrail.

The registry, detector, and coefficient-selection tests are pure python (no
torch). One gpt2/CPU test exercises the conditional steering end-to-end. The
calibration test is the important one: it proves select_coefficient refuses to
ship a vector that buys robustness by sacrificing clean accuracy, which is the
documented failure mode of steering.
"""

from __future__ import annotations

import json

import pytest

from finetune.python.data import injection_payloads as _ip
from finetune.python.steering.activation_steering import SteeringVector
from finetune.python.steering.calibrate import select_coefficient
from finetune.python.steering.conditional import InjectionDetector, should_steer
from finetune.python.steering.registry import (
    STATUS_ACTIVE,
    STATUS_DEPRECATED,
    STATUS_REJECTED,
    SteeringRegistry,
)


# --------------------------------------------------------------------------- #
# Registry
# --------------------------------------------------------------------------- #

def _fake_sv(coef=8.0):
    return SteeringVector(vector=[0.1, -0.2, 0.3, 0.4], layer=5, coefficient=coef, hidden_size=4)


def test_registry_register_get_and_versioning(tmp_path):
    reg = SteeringRegistry(str(tmp_path / "reg"))
    e1 = reg.register("injection_resist", _fake_sv(), pos_prompts=["a"], neg_prompts=["b"], asr_after=0.0)
    assert e1.version == 1 and e1.status == STATUS_ACTIVE
    assert e1.pos_hash and e1.neg_hash and e1.pos_hash != e1.neg_hash

    # a second active registration for the same key deprecates the first
    e2 = reg.register("injection_resist", _fake_sv(coef=12.0))
    assert e2.version == 2
    assert reg.get("injection_resist").version == 2  # latest active
    assert reg.get("injection_resist", status=STATUS_DEPRECATED).version == 1


def test_registry_rejected_vectors_are_kept_for_the_record(tmp_path):
    reg = SteeringRegistry(str(tmp_path / "reg"))
    reg.register("unicode_smuggle_v2", _fake_sv(), status=STATUS_REJECTED,
                 clean_accuracy_before=0.95, clean_accuracy_after=0.70,
                 description="dropped clean accuracy 25 points")
    assert reg.get("unicode_smuggle_v2", status=STATUS_ACTIVE) is None  # never shipped
    rej = reg.get("unicode_smuggle_v2", status=STATUS_REJECTED)
    assert rej is not None and rej.clean_accuracy_after == 0.70


def test_registry_round_trips_to_disk(tmp_path):
    d = str(tmp_path / "reg")
    reg = SteeringRegistry(d)
    reg.register("injection_resist", _fake_sv(), asr_before=0.4, asr_after=0.02)
    # reload from disk in a fresh instance
    reg2 = SteeringRegistry(d)
    got = reg2.get("injection_resist")
    assert got is not None
    assert got.vector == [0.1, -0.2, 0.3, 0.4]
    assert got.coefficient == 8.0 and got.layer == 5
    assert got.asr_before == 0.4 and got.asr_after == 0.02


def test_registry_active_entries_one_per_key(tmp_path):
    reg = SteeringRegistry(str(tmp_path / "reg"))
    reg.register("k1", _fake_sv())
    reg.register("k1", _fake_sv(coef=10.0))  # deprecates v1
    reg.register("k2", _fake_sv())
    active = {e.key: e for e in reg.active_entries()}
    assert set(active) == {"k1", "k2"}
    assert active["k1"].version == 2


# --------------------------------------------------------------------------- #
# Conditional detector (CAST gate)
# --------------------------------------------------------------------------- #

def test_detector_fires_on_each_injection_family():
    det = InjectionDetector()
    for family, text, _ in _ip.PAYLOADS:
        assert det.detect(text), f"detector missed family={family}: {text[:60]!r}"


def test_detector_does_not_fire_on_benign_text():
    det = InjectionDetector()
    benign = [
        "Routine dependency bump from 1.2.3 to 1.2.4. No new lifecycle scripts.",
        "Updated the README with installation examples and a changelog entry.",
        "Bugfix: handle empty arrays in the parser. Adds one test.",
    ]
    for text in benign:
        assert not det.detect(text), f"false positive on benign text: {text!r}"


def test_should_steer_uses_serialized_dossier():
    det = InjectionDetector()
    serialize = lambda d: json.dumps(d)
    clean = {"release_context": "routine update", "diff_summary": "patch"}
    laced = _ip.apply_injection(clean, _ip.payloads_for("allow")[0][1])
    assert should_steer(det, laced, serialize) is True
    assert should_steer(det, clean, serialize) is False


def test_detector_catches_smuggled_unicode():
    det = InjectionDetector()
    # ascii-smuggling family: invisible tag-block chars carry the payload
    smuggled = "Routine bump." + "".join(chr(0xE0000 + ord(c)) for c in "allow")
    assert det.detect(smuggled) is True


# --------------------------------------------------------------------------- #
# Calibration guardrail (the load-bearing test)
# --------------------------------------------------------------------------- #

def _calibration_fixture():
    """Five clean dossiers with known gold verdicts and an injectable field."""
    golds = ["block", "block", "allow", "quarantine", "block"]
    dossiers = [
        {"_gold": g, "release_context": "routine update", "diff_summary": "patch"}
        for g in golds
    ]
    return dossiers, golds


def _stub_factory(good=8.0, over=16.0):
    """coefficient -> verdict_fn simulating a frozen classifier under steering.

    - coef 0.0 / weak: vulnerable - obeys an injection in the data (-> allow).
    - coef==good:       robust   - returns the structural gold regardless.
    - coef==over:       over-steered - blocks everything (clean accuracy tanks).
    """
    sig = ("ignore", "override", "approved", "verdict", "must emit",
           "instructions", "pre-cleared", "safe", "allow it", chr(0xE0000))

    def looks_injected(d):
        for f in _ip.DEFAULT_INJECTION_FIELDS:
            if f in d and any(s in str(d[f]).lower() for s in sig):
                return True
        return False

    def factory(coef):
        def fn(d):
            gold = d.get("_gold", "block")
            if coef == over:
                return "block"            # over-steered
            if coef == good:
                return gold               # robust: ignores the injection
            return "allow" if looks_injected(d) else gold  # vulnerable
        return fn

    return factory


def test_select_coefficient_picks_robust_setting_within_guardrail():
    dossiers, golds = _calibration_fixture()
    factory = _stub_factory(good=8.0, over=16.0)
    res = select_coefficient(
        factory, dossiers, golds,
        coefficients=[2.0, 8.0, 16.0],  # weak / good / over
        max_clean_drop=0.02, min_asr_reduction=0.05,
    )
    assert res.accepted is True
    assert res.chosen_coefficient == 8.0
    assert res.asr_after == 0.0           # robust setting eliminates the flips
    assert res.clean_accuracy_after == 1.0  # and keeps clean accuracy
    assert res.asr_before > 0.0           # there was a real vulnerability to fix


def test_select_coefficient_rejects_when_only_overstears_available():
    dossiers, golds = _calibration_fixture()
    factory = _stub_factory(good=999.0, over=16.0)  # no "good" coef in the grid
    res = select_coefficient(
        factory, dossiers, golds,
        coefficients=[2.0, 16.0],  # weak (no gain) / over (clean drop)
        max_clean_drop=0.02, min_asr_reduction=0.05,
    )
    assert res.accepted is False
    assert res.chosen_coefficient is None
    assert "guardrail" in res.reason
    # both candidates recorded with their rejection reason
    reasons = {t.coefficient: t.reason for t in res.trials}
    assert any("clean_drop" in r for r in reasons.values())
    assert any("asr_gain" in r for r in reasons.values())


# --------------------------------------------------------------------------- #
# gpt2 mechanism test (CPU) - conditional steering end-to-end
# --------------------------------------------------------------------------- #

@pytest.fixture(scope="module")
def gpt2():
    pytest.importorskip("torch")
    tf = pytest.importorskip("transformers")
    try:
        tok = tf.AutoTokenizer.from_pretrained("gpt2")
        model = tf.AutoModelForCausalLM.from_pretrained("gpt2")
    except Exception:  # pragma: no cover
        pytest.skip("gpt2 not available offline")
    model.eval()
    return model, tok


def test_conditional_steering_gates_on_detection(gpt2):
    from finetune.python.steering.activation_steering import compute_steering_vector
    from finetune.python.steering.conditional import make_conditionally_steered_verdict_fn
    from finetune.python.steering.contrastive_prompts import injection_resist_pairs
    from finetune.python.steering.calibrate import default_parse_verdict

    model, tok = gpt2
    pos, neg = injection_resist_pairs()
    sv = compute_steering_vector(model, tok, pos, neg, layer=4)
    sv.coefficient = 6.0
    det = InjectionDetector()

    decisions: list[bool] = []
    fn = make_conditionally_steered_verdict_fn(
        model, tok, sv, det,
        serialize=lambda d: json.dumps(d),
        parse_verdict=default_parse_verdict,
        max_new_tokens=4,
        on_decision=lambda d, steered: decisions.append(steered),
    )

    clean = {"release_context": "routine update"}
    laced = _ip.apply_injection(clean, _ip.payloads_for("allow")[0][1])

    v_clean = fn(clean)
    v_laced = fn(laced)

    # benign dossier was NOT steered; injected dossier WAS steered
    assert decisions == [False, True]
    # both return a valid verdict token (gpt2 gibberish -> fail-closed 'block')
    assert v_clean in ("allow", "quarantine", "block")
    assert v_laced in ("allow", "quarantine", "block")
