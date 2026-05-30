"""Tests for finetune.python.serving.sybilion_alerts.

No model, no network. Alerts payloads are hand-built in the documented
POST /api/v1/alerts response shape.
"""

from __future__ import annotations

import pytest

from finetune.python.serving.dependency_forecast import forecast_dependency_tree
from finetune.python.serving.sybilion_alerts import (
    alert_band,
    alert_drift,
    alert_scan_depth,
    make_alert_band_fn,
    narration_context,
    parse_alerts,
)


def _alert(name, pct, trending=False, news=None):
    return {
        "name": name,
        "pct_change": pct,
        "trending": trending,
        "news": news or [],
    }


def _payload(*alerts):
    return {"alerts": list(alerts)}


# --- parse_alerts ---------------------------------------------------------


def test_parse_full_response():
    payload = _payload(
        _alert(
            "left-pad",
            34.0,
            trending=True,
            news=[{"title": "maintainer handed off repo", "source_name": "TheRegister"}],
        )
    )
    parsed = parse_alerts(payload)
    assert len(parsed) == 1
    assert parsed[0]["name"] == "left-pad"
    assert parsed[0]["pct_change"] == 34.0
    assert parsed[0]["trending"] is True
    assert parsed[0]["news"][0]["source_name"] == "TheRegister"


def test_parse_bare_list_and_drops_nameless():
    parsed = parse_alerts([_alert("ok", 5.0), {"pct_change": 9.0}])
    assert [a["name"] for a in parsed] == ["ok"]


def test_parse_garbage_returns_empty():
    assert parse_alerts(None) == []
    assert parse_alerts(42) == []
    assert parse_alerts({"alerts": "nope"}) == []


# --- alert_drift ----------------------------------------------------------


def test_trending_fires_drift():
    d = alert_drift(_alert("p", 2.0, trending=True))
    assert d["drift"] is True
    assert "trending" in d["fired_on"]


def test_big_move_fires_drift():
    d = alert_drift(_alert("p", 25.0, trending=False))
    assert d["drift"] is True
    assert "pct_change" in d["fired_on"]


def test_small_steady_no_drift():
    d = alert_drift(_alert("p", 3.0, trending=False))
    assert d["drift"] is False
    assert d["fired_on"] == []


def test_drift_carries_news_context():
    d = alert_drift(
        _alert("p", 40.0, news=[{"title": "CVE filed", "source_name": "NVD"}])
    )
    assert d["news_context"] == ["CVE filed (NVD)"]
    assert "cause" in d["reason"]


# --- alert_band -----------------------------------------------------------


def test_band_widens_with_move_and_contains_point():
    low, high = alert_band(0.5, _alert("p", 50.0))
    assert low < 0.5 < high
    # 50 percent move -> half = 0.5 * 0.40 = 0.20.
    assert low == pytest.approx(0.30)
    assert high == pytest.approx(0.70)


def test_band_clamped_to_unit_interval():
    low, high = alert_band(0.95, _alert("p", 100.0, trending=True))
    assert low >= 0.0
    assert high <= 1.0
    assert low <= 0.95 <= high


def test_band_no_move_is_tight():
    low, high = alert_band(0.4, _alert("p", 0.0))
    assert (high - low) == pytest.approx(0.0)


# --- make_alert_band_fn integrated with the roll-up -----------------------


def test_band_fn_widens_only_alerted_dep():
    deps = [{"name": "calm", "version": "1"}, {"name": "noisy", "version": "1"}]
    band_fn = make_alert_band_fn(_payload(_alert("noisy", 60.0, trending=True)))
    result = forecast_dependency_tree(deps, lambda d: 0.2, band_fn=band_fn)
    by_name = {e["name"]: e for e in result["per_dep"]}
    assert by_name["calm"]["band_width"] == pytest.approx(0.0)
    assert by_name["noisy"]["band_width"] > 0.0
    # noisy band should be wide enough to route to a human.
    assert by_name["noisy"]["route_to_human"] is True
    assert {e["name"] for e in result["high_volatility"]} == {"noisy"}


# --- alert_scan_depth -----------------------------------------------------


def test_alert_scan_depth_from_move():
    # 30 percent move -> proxy 0.30 -> deep.
    assert alert_scan_depth(_alert("p", 30.0))["depth"] == "deep"
    assert alert_scan_depth(_alert("p", 1.0))["depth"] == "shallow"


def test_mape_deeper_than_alert_wins():
    # tiny alert move, but a high MAPE should pull scan depth to deep.
    out = alert_scan_depth(_alert("p", 1.0), short_horizon_mape=0.5)
    assert out["depth"] == "deep"
    assert out["source"] == "mape"


def test_trending_floors_scan_depth_at_standard():
    out = alert_scan_depth(_alert("p", 1.0, trending=True))
    assert out["depth"] in ("standard", "deep")
    assert out["depth"] != "shallow"


# --- narration_context ----------------------------------------------------


def test_narration_context_limits_items():
    news = [{"title": f"t{i}", "source_name": "s"} for i in range(5)]
    ctx = narration_context(_alert("p", 10.0, news=news), max_items=2)
    assert ctx == ["t0 (s)", "t1 (s)"]


def test_narration_context_skips_titleless():
    ctx = narration_context(_alert("p", 10.0, news=[{"source_name": "s"}]))
    assert ctx == []
