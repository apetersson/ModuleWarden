"""Tests for finetune.python.serving.forecast_drift.

No model, no network. Forecast blocks are hand-built dicts in the documented
Sybilion forecast.json `data` shape.
"""

from __future__ import annotations

import pytest

from finetune.python.serving.forecast_drift import (
    act_on_drift,
    detect_forecast_drift,
    extract_series,
)


def _series(points, bands=None):
    """Build a forecast_data block from a list of point values.

    bands, when given, is a parallel list of (low, high) quantile bounds.
    """

    series = {}
    for i, point in enumerate(points):
        date = f"2026-{i + 1:02d}-01"
        entry = {"forecast": point}
        if bands is not None:
            low, high = bands[i]
            entry["quantile_forecast"] = {"0.1": low, "0.5": point, "0.9": high}
        series[date] = entry
    return {"forecast_series": series, "forecast_horizon": len(points)}


def test_extract_series_orders_by_date():
    data = _series([100, 110, 120])
    rows = extract_series(data)
    assert [r["date"] for r in rows] == ["2026-01-01", "2026-02-01", "2026-03-01"]
    assert [r["point"] for r in rows] == [100, 110, 120]


def test_extract_series_reads_quantiles():
    data = _series([100], bands=[(80, 130)])
    rows = extract_series(data)
    assert rows[0]["q_low"] == 80
    assert rows[0]["q_high"] == 130
    assert rows[0]["median"] == 100


def test_no_drift_on_steady_climb():
    # Constant slope: each step +10, last step is not steeper than the rest.
    data = _series([100, 110, 120, 130])
    result = detect_forecast_drift(data)
    assert result["drift"] is False
    assert result["fired_on"] == []


def test_slope_acceleration_fires():
    # Gentle then a sharp jump at the end.
    data = _series([100, 102, 104, 140])
    result = detect_forecast_drift(data)
    assert result["drift"] is True
    assert "slope" in result["fired_on"]


def test_level_crossing_fires():
    data = _series([100, 105, 110])
    result = detect_forecast_drift(data, historical_upper=108)
    assert result["drift"] is True
    assert "level" in result["fired_on"]


def test_band_widening_fires():
    # Point flat, but the quantile band fans out from 20 wide to 80 wide.
    data = _series(
        [100, 100, 100, 100],
        bands=[(90, 110), (85, 115), (70, 130), (60, 140)],
    )
    result = detect_forecast_drift(data)
    assert result["drift"] is True
    assert "band" in result["fired_on"]


def test_single_point_cannot_judge():
    data = _series([100])
    result = detect_forecast_drift(data)
    assert result["drift"] is False
    assert "fewer than two" in result["reason"]


def test_act_on_drift_recommends_prefetch_with_package():
    data = _series([100, 102, 104, 160])
    dossier = {"name": "left-pad", "version": "1.3.0"}
    action = act_on_drift(data, dossier)
    assert action["prefetch"] is True
    assert action["package"] == "left-pad@1.3.0"
    assert "pre-fetch" in action["reason"]


def test_act_on_drift_quiet_when_steady():
    data = _series([100, 110, 120, 130])
    action = act_on_drift(data)
    assert action["prefetch"] is False
    assert "no forecast drift" in action["reason"]


def test_empty_forecast_is_safe():
    assert extract_series({}) == []
    result = detect_forecast_drift({})
    assert result["drift"] is False
