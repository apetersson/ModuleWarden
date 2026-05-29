"""Tests for finetune.python.eval.forecast_calibration.

All tests run with no model, no GPU, and no network. Predictions come from
hand-built inputs and stub callables.
"""

from __future__ import annotations

import pytest

from finetune.python.eval.forecast_calibration import (
    brier_score,
    evaluate_calibration,
    expected_calibration_error,
    forecast_probability,
    reliability_curve,
)


def test_forecast_monotonicity_same_confidence():
    # For a fixed confidence, block > quarantine > allow.
    for conf in (None, "low", "medium", "high"):
        allow = forecast_probability("allow", conf)
        quarantine = forecast_probability("quarantine", conf)
        block = forecast_probability("block", conf)
        assert allow < quarantine < block


def test_forecast_bounds():
    # Every probability stays in [0, 1].
    for verdict in ("allow", "quarantine", "block", "bogus"):
        for conf in (None, "low", "medium", "high", "weird"):
            p = forecast_probability(verdict, conf)
            assert 0.0 <= p <= 1.0


def test_forecast_unknown_verdict_is_half():
    assert forecast_probability("nonsense") == 0.5
    # Confidence does not rescue an unknown verdict.
    assert forecast_probability("nonsense", "high") == 0.5


def test_forecast_quarantine_is_half():
    # Quarantine sits at maximum uncertainty regardless of confidence.
    assert forecast_probability("quarantine", "high") == 0.5
    assert forecast_probability("quarantine", "low") == 0.5
    assert forecast_probability("quarantine") == 0.5


def test_forecast_confidence_sharpens():
    # High confidence pushes away from 0.5, low confidence pulls toward it.
    allow_high = forecast_probability("allow", "high")
    allow_med = forecast_probability("allow", "medium")
    allow_low = forecast_probability("allow", "low")
    # allow base is below 0.5, so high should be lowest, low should be nearest 0.5.
    assert allow_high < allow_med < allow_low < 0.5

    block_high = forecast_probability("block", "high")
    block_med = forecast_probability("block", "medium")
    block_low = forecast_probability("block", "low")
    assert 0.5 < block_low < block_med < block_high


def test_forecast_case_insensitive():
    assert forecast_probability("BLOCK", "HIGH") == forecast_probability("block", "high")


def test_brier_hand_computed():
    # Two predictions: 0.0 vs label 0, 1.0 vs label 1 -> perfect, Brier 0.
    assert brier_score([0.0, 1.0], [0, 1]) == 0.0
    # Worst case: 0.0 vs 1, 1.0 vs 0 -> each diff^2 = 1 -> mean 1.0.
    assert brier_score([0.0, 1.0], [1, 0]) == 1.0
    # Mixed: 0.5 vs 1 -> 0.25, 0.5 vs 0 -> 0.25, mean 0.25.
    assert brier_score([0.5, 0.5], [1, 0]) == pytest.approx(0.25)


def test_brier_single_value():
    # 0.2 vs label 1 -> (0.2 - 1)^2 = 0.64.
    assert brier_score([0.2], [1]) == pytest.approx(0.64)


def test_brier_length_mismatch_raises():
    with pytest.raises(ValueError):
        brier_score([0.1, 0.2], [1])


def test_brier_empty_raises():
    with pytest.raises(ValueError):
        brier_score([], [])


def test_ece_zero_for_perfectly_calibrated():
    # Construct synthetic data where each bin's mean prediction equals its
    # fraction of positives. With prob 0.0 -> all label 0, prob 1.0 -> all
    # label 1, every populated bin has zero gap, so ECE is 0.
    probs = [0.0, 0.0, 1.0, 1.0]
    labels = [0, 0, 1, 1]
    assert expected_calibration_error(probs, labels, n_bins=10) == pytest.approx(0.0)


def test_ece_zero_mid_bin():
    # A bin at 0.5 with exactly half positives is perfectly calibrated.
    probs = [0.5, 0.5, 0.5, 0.5]
    labels = [1, 0, 1, 0]
    assert expected_calibration_error(probs, labels, n_bins=10) == pytest.approx(0.0)


def test_ece_nonzero_when_miscalibrated():
    # Predict 0.9 but everything is negative -> the gap is 0.9.
    probs = [0.9, 0.9, 0.9]
    labels = [0, 0, 0]
    assert expected_calibration_error(probs, labels, n_bins=10) == pytest.approx(0.9)


def test_ece_validation():
    with pytest.raises(ValueError):
        expected_calibration_error([0.1], [0, 1])
    with pytest.raises(ValueError):
        expected_calibration_error([], [])
    with pytest.raises(ValueError):
        expected_calibration_error([0.1], [1], n_bins=0)


def test_reliability_curve_shape():
    probs = [0.05, 0.15, 0.95]
    labels = [0, 0, 1]
    curve = reliability_curve(probs, labels, n_bins=10)
    assert len(curve) == 10
    for b in curve:
        assert set(b.keys()) == {
            "bin_lo",
            "bin_hi",
            "count",
            "mean_pred",
            "frac_positive",
        }
    # First bin [0.0, 0.1) holds the 0.05 prediction.
    first = curve[0]
    assert first["count"] == 1
    assert first["mean_pred"] == pytest.approx(0.05)
    assert first["frac_positive"] == pytest.approx(0.0)
    # Last bin [0.9, 1.0] holds the 0.95 prediction (1.0 maps into the last bin).
    last = curve[9]
    assert last["count"] == 1
    assert last["mean_pred"] == pytest.approx(0.95)
    assert last["frac_positive"] == pytest.approx(1.0)


def test_reliability_curve_empty_bins_are_none():
    probs = [0.05]
    labels = [0]
    curve = reliability_curve(probs, labels, n_bins=10)
    # Bin 0 populated, the rest empty with None stats.
    assert curve[0]["count"] == 1
    for b in curve[1:]:
        assert b["count"] == 0
        assert b["mean_pred"] is None
        assert b["frac_positive"] is None


def test_reliability_curve_edges():
    curve = reliability_curve([0.5], [1], n_bins=4)
    assert curve[0]["bin_lo"] == pytest.approx(0.0)
    assert curve[0]["bin_hi"] == pytest.approx(0.25)
    assert curve[3]["bin_hi"] == pytest.approx(1.0)


def test_evaluate_calibration_with_stubs():
    # Records carry a verdict and a known truth label.
    records = [
        {"verdict": "block", "truth": 1},
        {"verdict": "allow", "truth": 0},
        {"verdict": "block", "truth": 1},
        {"verdict": "allow", "truth": 0},
    ]

    def predict_fn(rec):
        return forecast_probability(rec["verdict"], "high")

    def label_fn(rec):
        return rec["truth"]

    result = evaluate_calibration(records, predict_fn, label_fn, n_bins=10)
    assert result["n"] == 4
    assert 0.0 <= result["brier"] <= 1.0
    assert 0.0 <= result["ece"] <= 1.0
    assert result["base_rate"] == pytest.approx(0.5)
    assert 0.0 <= result["mean_pred"] <= 1.0
    assert len(result["reliability"]) == 10


def test_evaluate_calibration_skips_none_labels():
    records = [
        {"verdict": "block", "truth": 1},
        {"verdict": "allow", "truth": None},  # skipped
        {"verdict": "allow", "truth": 0},
        {"verdict": "quarantine", "truth": None},  # skipped
    ]

    def predict_fn(rec):
        return forecast_probability(rec["verdict"])

    def label_fn(rec):
        return rec["truth"]

    result = evaluate_calibration(records, predict_fn, label_fn)
    # Only 2 records had non-None labels.
    assert result["n"] == 2
    assert result["base_rate"] == pytest.approx(0.5)


def test_evaluate_calibration_all_skipped():
    records = [{"verdict": "block"}, {"verdict": "allow"}]

    def predict_fn(rec):
        return forecast_probability(rec["verdict"])

    def label_fn(rec):
        return None

    result = evaluate_calibration(records, predict_fn, label_fn)
    assert result["n"] == 0
    assert result["brier"] is None
    assert result["ece"] is None
    assert result["reliability"] == []
    assert result["mean_pred"] is None
    assert result["base_rate"] is None


def test_evaluate_calibration_clamps_predictions():
    # predict_fn that returns out-of-range values gets clamped.
    records = [{"p": 5.0, "truth": 1}, {"p": -2.0, "truth": 0}]

    def predict_fn(rec):
        return rec["p"]

    def label_fn(rec):
        return rec["truth"]

    result = evaluate_calibration(records, predict_fn, label_fn)
    assert result["n"] == 2
    # 5.0 clamps to 1.0 (vs label 1), -2.0 clamps to 0.0 (vs label 0) -> Brier 0.
    assert result["brier"] == pytest.approx(0.0)
    assert result["mean_pred"] == pytest.approx(0.5)
