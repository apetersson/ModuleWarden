"""Forecast-drift trigger for the acting agent.

The acting agent in `acting_agent.py` reacts to a point verdict. This module
adds the other half of "an agent that acts on the forecast": it watches the
Sybilion forecast trajectory and fires when the trajectory itself changes,
before a developer runs `npm install`. When drift fires, the agent
pre-fetches and pins the version delta so the deterministic gate has the
artifact ready the moment the install lands, instead of cold-starting an
audit under time pressure.

It consumes the documented Sybilion `forecast.json` `data` shape (see
`docs/sybillion-api/forecasts-artifacts.md`):

    {
      "forecast_series": {
        "2026-05-01": {"forecast": 1234.5,
                       "quantile_forecast": {"0.1": 1100.0, "0.5": 1234.5, "0.9": 1380.7}},
        ...
      },
      "forecast_horizon": 12,
      ...
    }

`quantile_forecast` is present only on probabilistic runs; the module degrades
to the point series when it is absent. Pure standard library, no model, no
network. The forecast NEVER decides the verdict here, it only decides whether
the agent warms the gate early.
"""

from __future__ import annotations

__all__ = [
    "extract_series",
    "detect_forecast_drift",
    "act_on_drift",
]

# A trajectory step counts as "steepening" when it is at least this multiple of
# the average of the earlier steps. 1.5 means the latest move is 50 percent
# faster than the run-up to it.
ACCEL_FACTOR = 1.5


def _to_float(value: object) -> float | None:
    try:
        f = float(value)  # type: ignore[arg-type]
    except (TypeError, ValueError):
        return None
    if f != f:  # NaN
        return None
    return f


def extract_series(forecast_data: dict) -> list[dict]:
    """Pull an ordered trajectory out of a forecast.json `data` block.

    Returns a list of {"date", "point", "q_low", "q_high", "median"} sorted by
    date ascending. q_low / q_high / median are None when the run was not
    probabilistic. Unparseable rows are skipped rather than raising.
    """

    series = (forecast_data or {}).get("forecast_series") or {}
    if not isinstance(series, dict):
        return []

    rows: list[dict] = []
    for date in sorted(series.keys()):
        entry = series[date]
        if not isinstance(entry, dict):
            continue
        point = _to_float(entry.get("forecast"))
        q = entry.get("quantile_forecast")
        q_low = q_high = median = None
        if isinstance(q, dict) and q:
            parsed = {}
            for k, v in q.items():
                fk = _to_float(k)
                fv = _to_float(v)
                if fk is not None and fv is not None:
                    parsed[fk] = fv
            if parsed:
                lo_key = min(parsed)
                hi_key = max(parsed)
                q_low = parsed[lo_key]
                q_high = parsed[hi_key]
                # median: the quantile nearest 0.5.
                med_key = min(parsed, key=lambda x: abs(x - 0.5))
                median = parsed[med_key]
        if point is None and median is not None:
            point = median
        if point is None:
            continue
        rows.append(
            {
                "date": date,
                "point": point,
                "q_low": q_low,
                "q_high": q_high,
                "median": median if median is not None else point,
            }
        )
    return rows


def _slopes(values: list[float]) -> list[float]:
    return [values[i + 1] - values[i] for i in range(len(values) - 1)]


def detect_forecast_drift(
    forecast_data: dict,
    historical_upper: float | None = None,
    accel_factor: float = ACCEL_FACTOR,
) -> dict:
    """Decide whether the forecast trajectory has drifted enough to act.

    Fires on any of three signals, named in `fired_on`:
      - "level": the latest point crosses `historical_upper` (when supplied).
      - "slope": the latest trajectory step is at least `accel_factor` times the
        average of the earlier steps and is positive (the climb is steepening).
      - "band": the latest quantile band (q_high - q_low) is at least
        `accel_factor` times the first step's band (uncertainty is fanning out).

    Returns {"drift", "fired_on", "reason", "metrics"}. With fewer than two
    points it cannot judge a slope and returns drift False.
    """

    rows = extract_series(forecast_data)
    metrics: dict = {"n_points": len(rows)}
    fired: list[str] = []
    reasons: list[str] = []

    if len(rows) < 2:
        return {
            "drift": False,
            "fired_on": [],
            "reason": "fewer than two forecast points; cannot judge a trajectory",
            "metrics": metrics,
        }

    points = [r["point"] for r in rows]
    latest = points[-1]
    metrics["latest_point"] = latest

    # 1. level crossing
    if historical_upper is not None:
        hu = _to_float(historical_upper)
        if hu is not None:
            metrics["historical_upper"] = hu
            if latest > hu:
                fired.append("level")
                reasons.append(
                    f"latest point {latest:.3g} crosses historical upper {hu:.3g}"
                )

    # 2. slope acceleration
    slopes = _slopes(points)
    last_slope = slopes[-1]
    prior = slopes[:-1]
    if prior:
        avg_prior = sum(prior) / len(prior)
        metrics["last_slope"] = last_slope
        metrics["avg_prior_slope"] = avg_prior
        if last_slope > 0 and abs(avg_prior) > 1e-12 and last_slope >= accel_factor * avg_prior:
            fired.append("slope")
            reasons.append(
                f"latest step {last_slope:.3g} is {last_slope / avg_prior:.2f}x the "
                f"prior average {avg_prior:.3g}"
            )

    # 3. band widening
    bands = [
        r["q_high"] - r["q_low"]
        for r in rows
        if r["q_high"] is not None and r["q_low"] is not None
    ]
    if len(bands) >= 2 and bands[0] > 1e-12:
        metrics["first_band"] = bands[0]
        metrics["last_band"] = bands[-1]
        if bands[-1] >= accel_factor * bands[0]:
            fired.append("band")
            reasons.append(
                f"quantile band widened from {bands[0]:.3g} to {bands[-1]:.3g}"
            )

    drift = bool(fired)
    return {
        "drift": drift,
        "fired_on": fired,
        "reason": "; ".join(reasons) if reasons else "trajectory steady, no drift",
        "metrics": metrics,
    }


def act_on_drift(
    forecast_data: dict,
    dossier: dict | None = None,
    historical_upper: float | None = None,
    accel_factor: float = ACCEL_FACTOR,
) -> dict:
    """The agent's pre-install action when the forecast drifts.

    Runs `detect_forecast_drift`; on drift it recommends pre-fetching and
    pinning the version delta so the gate audits a warm artifact. The package
    identity, when available, is read from the dossier's `name` / `version`.
    This warms the gate, it does not pass a verdict.

    Returns {"prefetch", "drift", "fired_on", "package", "reason"}.
    """

    drift = detect_forecast_drift(forecast_data, historical_upper, accel_factor)

    name = version = None
    if dossier:
        name = dossier.get("name")
        version = dossier.get("version")
    package = f"{name}@{version}" if name and version else (name or None)

    if drift["drift"]:
        target = f" for {package}" if package else ""
        reason = (
            f"forecast drift{target} ({', '.join(drift['fired_on'])}): "
            f"{drift['reason']}; pre-fetch and pin the version delta so the "
            f"gate audits a warm artifact before install"
        )
    else:
        reason = "no forecast drift; nothing to pre-fetch"

    return {
        "prefetch": drift["drift"],
        "drift": drift,
        "fired_on": drift["fired_on"],
        "package": package,
        "reason": reason,
    }
