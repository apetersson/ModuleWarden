"""Cost-aware forecast budgeting from the documented Sybilion billing endpoints.

`GET /api/v1/jobs` carries `eur_cents_final` per job and `GET /api/v1/usage`
carries `eur_cents_charged` per billed event (see `docs/sybillion-api/`). This
module reads those payloads into a spend summary and produces a throttle plan:
which dependencies to forecast now, given a remaining budget and the tier's
per-minute cap, and which to defer.

It NEVER spends money on its own. It does not top up balance and it does not
request a tier upgrade. The remaining budget and the per-minute cap are passed
in by the operator (the usage endpoint does not return a balance, and the tier
caps live on the portal, not in the docs). This module only decides ordering
under those limits and surfaces the cost; a human authorizes any top-up.

Pure standard library. Tests feed sample jobs / usage payloads.
"""

from __future__ import annotations

__all__ = [
    "parse_jobs",
    "parse_usage",
    "spend_summary",
    "throttle_plan",
    "DEFAULT_FORECAST_CENTS",
    "DEFAULT_CAP_SAFETY",
]

# Measured cost of a forecast settle (date-fns, 2026-05-30): 35 EUR cents. The
# docs example's "3 cents" was an example, not our number; real forecasts ran
# 35-182 cents. Used only as a fallback when the caller does not pass the real
# per-call cost; prefer reading eur_cents_final from GET /jobs.
DEFAULT_FORECAST_CENTS = 35

# Stay under this fraction of the per-minute cap, leaving headroom so a burst
# does not trip the 429.
DEFAULT_CAP_SAFETY = 0.8


def _to_int(value: object) -> int | None:
    try:
        if value is None:
            return None
        return int(value)  # type: ignore[arg-type]
    except (TypeError, ValueError):
        return None


def parse_jobs(payload: object) -> list[dict]:
    """Normalize a GET /api/v1/jobs response into a list of job dicts."""

    if isinstance(payload, dict):
        raw = payload.get("jobs", [])
    elif isinstance(payload, (list, tuple)):
        raw = payload
    else:
        return []
    out: list[dict] = []
    for item in raw:
        if not isinstance(item, dict):
            continue
        out.append(
            {
                "job_id": item.get("job_id"),
                "status": item.get("status"),
                "settled": bool(item.get("settled", False)),
                "eur_cents_final": _to_int(item.get("eur_cents_final")),
            }
        )
    return out


def parse_usage(payload: object) -> list[dict]:
    """Normalize a GET /api/v1/usage response into a list of usage events."""

    if isinstance(payload, dict):
        raw = payload.get("usage_events", [])
    elif isinstance(payload, (list, tuple)):
        raw = payload
    else:
        return []
    out: list[dict] = []
    for item in raw:
        if not isinstance(item, dict):
            continue
        out.append(
            {
                "endpoint": item.get("endpoint"),
                "eur_cents_charged": _to_int(item.get("eur_cents_charged")),
            }
        )
    return out


def spend_summary(
    jobs_payload: object = None,
    usage_payload: object = None,
) -> dict:
    """Summarize spend from jobs and/or usage payloads.

    Returns:
      total_eur_cents: sum of usage eur_cents_charged (preferred) else settled
        job eur_cents_final.
      by_endpoint: usage spend grouped by endpoint key (forecast/drivers/alerts).
      n_settled_jobs: count of settled jobs seen.
      mean_forecast_cents: mean eur_cents_final over settled jobs, or the
        documented DEFAULT_FORECAST_CENTS when no settled job is available.
    """

    jobs = parse_jobs(jobs_payload)
    usage = parse_usage(usage_payload)

    by_endpoint: dict[str, int] = {}
    usage_total = 0
    for ev in usage:
        cents = ev["eur_cents_charged"] or 0
        usage_total += cents
        key = ev["endpoint"] or "unknown"
        by_endpoint[key] = by_endpoint.get(key, 0) + cents

    settled = [j for j in jobs if j["settled"] and j["eur_cents_final"] is not None]
    jobs_total = sum(j["eur_cents_final"] for j in settled)
    mean_forecast = (
        jobs_total / len(settled) if settled else float(DEFAULT_FORECAST_CENTS)
    )

    total = usage_total if usage else jobs_total

    return {
        "total_eur_cents": total,
        "by_endpoint": by_endpoint,
        "n_settled_jobs": len(settled),
        "mean_forecast_cents": mean_forecast,
    }


def throttle_plan(
    ranked_deps: list,
    remaining_budget_cents: int,
    per_minute_cap: int,
    per_call_cents: float = DEFAULT_FORECAST_CENTS,
    requests_this_minute: int = 0,
    cap_safety: float = DEFAULT_CAP_SAFETY,
) -> dict:
    """Decide which ranked dependencies to forecast now under budget and cap.

    Walks ranked_deps in order (they arrive already ranked by trajectory) and
    admits each while both limits hold: cumulative cost stays within
    remaining_budget_cents, and the running call count stays under
    per_minute_cap * cap_safety. The rest are deferred. This is ordering only;
    it never spends and never raises the cap.

    Returns {"forecast_now", "defer", "n_now", "n_defer", "est_cost_cents",
    "reason"}.
    """

    deps = list(ranked_deps or [])
    per_call = max(0.0, float(per_call_cents))
    budget = max(0, int(remaining_budget_cents))
    cap = max(0, int(per_minute_cap))
    used_calls = max(0, int(requests_this_minute))
    cap_room = int(cap * cap_safety) - used_calls

    now: list = []
    spent = 0.0
    for dep in deps:
        next_cost = spent + per_call
        if len(now) >= cap_room:
            break
        if per_call > 0 and next_cost > budget:
            break
        now.append(dep)
        spent = next_cost

    defer = deps[len(now):]

    if not deps:
        reason = "no dependencies to forecast"
    elif not now:
        reason = (
            f"nothing forecast now: budget {budget} cents or cap room "
            f"{max(0, cap_room)} calls is exhausted; defer all {len(defer)} "
            f"and have a human authorize a top-up if needed"
        )
    else:
        reason = (
            f"forecast top {len(now)} of {len(deps)} ranked deps "
            f"(~{spent:.0f} cents); defer {len(defer)} under budget {budget} "
            f"cents and cap room {max(0, cap_room)} calls"
        )

    return {
        "forecast_now": now,
        "defer": defer,
        "n_now": len(now),
        "n_defer": len(defer),
        "est_cost_cents": spent,
        "reason": reason,
    }
