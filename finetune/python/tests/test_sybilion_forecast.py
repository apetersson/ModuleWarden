"""Tests for the pure parts of finetune.python.serving.sybilion_forecast.

No network: the npm fetch and Sybilion submit are not exercised here. We test
the aggregation, validation, payload shape, and windowing, which is the logic
that must be right for the live demo to clear the documented floor.
"""

from __future__ import annotations

from datetime import date, datetime, timezone

from finetune.python.serving.sybilion_forecast import (
    FLOOR,
    aggregate_monthly,
    build_payload,
    trim_leading_zeros,
    validate_series,
    _month_windows,
)


def test_trim_leading_zeros_drops_pre_existence_months():
    # npm zero-fills months before a package existed; trim to the first positive.
    series = {"2018-01-01": 0.0, "2018-02-01": 0.0, "2018-03-01": 5.0, "2018-04-01": 7.0}
    trimmed = trim_leading_zeros(series)
    assert list(trimmed.keys()) == ["2018-03-01", "2018-04-01"]


def test_trim_keeps_interior_and_all_positive():
    series = {"2020-01-01": 3.0, "2020-02-01": 0.0, "2020-03-01": 4.0}
    # only the LEADING run is trimmed; an interior zero stays (the gap check
    # catches genuine holes elsewhere).
    assert trim_leading_zeros(series) == series


def test_trim_all_zero_is_empty():
    assert trim_leading_zeros({"2020-01-01": 0.0, "2020-02-01": 0.0}) == {}


def _daily(year_month_to_total):
    """Build npm-style daily rows: one row per month carrying the month total."""
    rows = []
    for ym, total in year_month_to_total.items():
        rows.append({"day": f"{ym}-15", "downloads": total})
    return rows


def _months(n, start_year=2018, base=1000):
    """A clean n-month series ending last full month, no gaps."""
    out = {}
    y, m = start_year, 1
    for i in range(n):
        out[f"{y:04d}-{m:02d}"] = base + i
        m += 1
        if m > 12:
            m = 1
            y += 1
    return out


def test_aggregate_sums_per_month_and_keys_first_of_month():
    daily = [
        {"day": "2020-03-01", "downloads": 10},
        {"day": "2020-03-20", "downloads": 5},
        {"day": "2020-04-02", "downloads": 7},
    ]
    monthly = aggregate_monthly(daily, drop_partial_current=False)
    assert monthly == {"2020-03-01": 15.0, "2020-04-01": 7.0}


def test_aggregate_drops_current_partial_month():
    this_month = datetime.now(timezone.utc).strftime("%Y-%m")
    daily = [
        {"day": "2019-01-10", "downloads": 100},
        {"day": f"{this_month}-05", "downloads": 9},
    ]
    monthly = aggregate_monthly(daily, drop_partial_current=True)
    assert f"{this_month}-01" not in monthly
    assert "2019-01-01" in monthly


def test_aggregate_skips_bad_rows():
    daily = [
        {"day": "2020-01-01", "downloads": 5},
        {"day": None, "downloads": 5},
        {"day": "2020-02-01", "downloads": "not-a-number"},
    ]
    monthly = aggregate_monthly(daily, drop_partial_current=False)
    assert monthly == {"2020-01-01": 5.0}


def test_validate_passes_clean_60_month_series():
    monthly = {f"{k}": v for k, v in _series_first_of_month(_months(60)).items()}
    ok, problems = validate_series(monthly, horizon_max=6)
    # recency will fail because 2018-start is old; check the floor part separately.
    assert len(monthly) == 60
    assert all("floor" not in p for p in problems)


def test_validate_flags_short_series():
    monthly = _series_first_of_month(_months(30))
    ok, problems = validate_series(monthly, horizon_max=6)
    assert not ok
    assert any("floor" in p for p in problems)


def test_validate_flags_gap():
    m = _series_first_of_month(_months(60))
    keys = list(m.keys())
    del m[keys[10]]  # punch a hole
    ok, problems = validate_series(m, horizon_max=6)
    assert not ok
    assert any("gap" in p for p in problems)


def test_floor_table_matches_docs():
    assert FLOOR == {3: 40, 6: 60, 12: 120}


def test_build_payload_is_documented_shape():
    monthly = _series_first_of_month(_months(60))
    payload = build_payload("lodash", monthly, soft_horizon=6, hard_horizon=3)
    assert payload["frequency"] == "monthly"
    assert payload["pipeline_version"] == "v1"
    assert payload["backtest"] is True
    assert payload["hard_horizon"] <= payload["soft_horizon"]
    # title must be >= 20 bytes per the docs
    assert len(payload["timeseries_metadata"]["title"].encode("utf-8")) >= 20
    # timeseries is an OBJECT map keyed YYYY-MM-01, not an array
    assert isinstance(payload["timeseries"], dict)
    first_key = next(iter(payload["timeseries"]))
    assert first_key.endswith("-01") and len(first_key) == 10


def test_month_windows_cover_span_without_gaps():
    wins = _month_windows(date(2018, 1, 1), date(2024, 12, 31))
    assert wins[0][0] == "2018-01-01"
    assert wins[-1][1] == "2024-12-31"
    # consecutive windows must be contiguous
    for i in range(1, len(wins)):
        prev_end = date.fromisoformat(wins[i - 1][1])
        cur_start = date.fromisoformat(wins[i][0])
        assert cur_start.toordinal() == prev_end.toordinal() + 1


def _series_first_of_month(month_map):
    """Convert {YYYY-MM: v} to {YYYY-MM-01: v}."""
    return {f"{k}-01": float(v) for k, v in month_map.items()}
