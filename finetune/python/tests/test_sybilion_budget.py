"""Tests for finetune.python.serving.sybilion_budget.

No model, no network. Payloads are hand-built in the documented GET /jobs and
GET /usage response shapes.
"""

from __future__ import annotations

import pytest

from finetune.python.serving.sybilion_budget import (
    parse_jobs,
    parse_usage,
    spend_summary,
    throttle_plan,
)


def _jobs(*cents, settled=True):
    return {
        "jobs": [
            {
                "job_id": f"job-{i}",
                "status": "completed",
                "settled": settled,
                "eur_cents_final": c,
            }
            for i, c in enumerate(cents)
        ]
    }


def _usage(*pairs):
    return {
        "usage_events": [
            {"endpoint": ep, "eur_cents_charged": c} for ep, c in pairs
        ]
    }


# --- parsing --------------------------------------------------------------


def test_parse_jobs_and_usage():
    jobs = parse_jobs(_jobs(3, 3, 4))
    assert len(jobs) == 3
    assert jobs[0]["eur_cents_final"] == 3
    usage = parse_usage(_usage(("forecast", 3), ("drivers", 5)))
    assert usage[1]["endpoint"] == "drivers"


def test_parse_garbage():
    assert parse_jobs(None) == []
    assert parse_usage("nope") == []


# --- spend_summary --------------------------------------------------------


def test_spend_summary_from_usage():
    s = spend_summary(usage_payload=_usage(("forecast", 3), ("forecast", 3), ("alerts", 1)))
    assert s["total_eur_cents"] == 7
    assert s["by_endpoint"]["forecast"] == 6
    assert s["by_endpoint"]["alerts"] == 1


def test_spend_summary_mean_forecast_from_settled_jobs():
    s = spend_summary(jobs_payload=_jobs(2, 4))
    assert s["n_settled_jobs"] == 2
    assert s["mean_forecast_cents"] == pytest.approx(3.0)


def test_spend_summary_falls_back_to_measured_cost():
    # No settled jobs and no usage -> measured 35-cent fallback (date-fns run).
    s = spend_summary(jobs_payload=_jobs(3, settled=False))
    assert s["n_settled_jobs"] == 0
    assert s["mean_forecast_cents"] == pytest.approx(35.0)


# --- throttle_plan --------------------------------------------------------


def test_budget_limits_count():
    deps = [f"d{i}" for i in range(10)]
    plan = throttle_plan(deps, remaining_budget_cents=9, per_minute_cap=100, per_call_cents=3)
    # 9 cents / 3 per call -> exactly 3 forecasts now.
    assert plan["n_now"] == 3
    assert plan["n_defer"] == 7
    assert plan["forecast_now"] == ["d0", "d1", "d2"]


def test_cap_limits_count():
    deps = [f"d{i}" for i in range(10)]
    # cap 10, safety 0.8 -> room 8; 2 already used -> room 6.
    plan = throttle_plan(
        deps,
        remaining_budget_cents=10_000,
        per_minute_cap=10,
        per_call_cents=1,
        requests_this_minute=2,
    )
    assert plan["n_now"] == 6


def test_all_deferred_when_exhausted():
    deps = ["a", "b"]
    plan = throttle_plan(deps, remaining_budget_cents=0, per_minute_cap=100, per_call_cents=3)
    assert plan["n_now"] == 0
    assert plan["defer"] == ["a", "b"]
    assert "human" in plan["reason"]


def test_order_preserved():
    deps = ["high", "mid", "low"]
    plan = throttle_plan(deps, remaining_budget_cents=6, per_minute_cap=100, per_call_cents=3)
    assert plan["forecast_now"] == ["high", "mid"]


def test_empty_deps():
    plan = throttle_plan([], remaining_budget_cents=100, per_minute_cap=100)
    assert plan["n_now"] == 0
    assert "no dependencies" in plan["reason"]
