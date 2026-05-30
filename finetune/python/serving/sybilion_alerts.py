"""Consume the documented Sybilion alerts signal as a forecast-native trigger.

`POST /api/v1/alerts` (see `docs/sybillion-api/alerts.md`) returns, per dataset,
a `pct_change`, a `trending` flag, and the `news[]` that moved the series. That
is the same trajectory signal `forecast_drift.py` computes from the forecast
series, except the API hands it over directly with the cause attached. This
module adapts that documented payload into the inputs the rest of the forecast
suite already takes:

  - a drift decision (does the agent pre-fetch and route up the queue?),
  - a per-dependency probability band (wider when the move is larger),
  - a volatility proxy that feeds the existing scan-depth function,
  - and a short news context the trained auditor can cite when it narrates.

It uses ONLY the documented fields. There are no per-category weighting
constants, because the docs do not enumerate the category set or publish any
multiplier, and inventing one would be a number we cannot defend. The signal is
`pct_change` and `trending`; `news` is narration context, not a score.

Pure standard library. No model, no network. Tests feed a sample alerts payload.
"""

from __future__ import annotations

from finetune.python.serving.dependency_forecast import scan_depth_for_volatility

__all__ = [
    "parse_alerts",
    "alert_drift",
    "alert_band",
    "make_alert_band_fn",
    "alert_scan_depth",
    "narration_context",
    "ALERT_PCT_THRESHOLD",
    "MAX_BAND_HALF_WIDTH",
]

# A move at least this large (percent, absolute) counts as drift on its own. A
# trending alert fires regardless of size.
ALERT_PCT_THRESHOLD = 10.0

# The per-dep band never widens by more than this on each side, so one loud
# alert cannot blow the band out to the whole [0, 1] interval.
MAX_BAND_HALF_WIDTH = 0.40


def _to_float(value: object) -> float | None:
    try:
        f = float(value)  # type: ignore[arg-type]
    except (TypeError, ValueError):
        return None
    if f != f:  # NaN
        return None
    return f


def parse_alerts(payload: object) -> list[dict]:
    """Normalize an alerts response into a list of alert dicts.

    Accepts the full `{"alerts": [...]}` response or a bare list of alert
    objects. Each returned dict has name, pct_change (float or None), trending
    (bool), and news (list of the documented news fields). Rows without a name
    are dropped; unparseable pct_change becomes None.
    """

    if isinstance(payload, dict):
        raw = payload.get("alerts", [])
    elif isinstance(payload, (list, tuple)):
        raw = payload
    else:
        return []

    out: list[dict] = []
    for item in raw:
        if not isinstance(item, dict):
            continue
        name = str(item.get("name", "")).strip()
        if not name:
            continue
        news_in = item.get("news") or []
        news: list[dict] = []
        if isinstance(news_in, (list, tuple)):
            for n in news_in:
                if not isinstance(n, dict):
                    continue
                news.append(
                    {
                        "title": str(n.get("title", "")).strip(),
                        "source_name": str(n.get("source_name", "")).strip(),
                        "category": str(n.get("category", "")).strip(),
                        "url": str(n.get("url", "")).strip(),
                        "published_at": str(n.get("published_at", "")).strip(),
                        "trending": bool(n.get("trending", False)),
                    }
                )
        out.append(
            {
                "name": name,
                "pct_change": _to_float(item.get("pct_change")),
                "trending": bool(item.get("trending", False)),
                "news": news,
            }
        )
    return out


def alert_drift(alert: dict, pct_threshold: float = ALERT_PCT_THRESHOLD) -> dict:
    """Turn one alert into a drift decision the acting agent can use.

    Drift fires when the alert is trending OR the absolute pct_change is at
    least pct_threshold. Mirrors the forecast_drift output shape so the two
    sources are interchangeable. news titles ride along as the cited cause.

    Returns {"drift", "fired_on", "pct_change", "trending", "reason",
    "news_context"}.
    """

    pct = alert.get("pct_change")
    trending = bool(alert.get("trending", False))
    fired: list[str] = []
    if trending:
        fired.append("trending")
    if pct is not None and abs(pct) >= pct_threshold:
        fired.append("pct_change")

    drift = bool(fired)
    context = narration_context(alert)
    if drift:
        move = f"{pct:+.1f} percent" if pct is not None else "an untyped move"
        cause = f" cause: {context[0]}" if context else ""
        reason = (
            f"alert on {alert.get('name')}: {move}, trending={trending} "
            f"({', '.join(fired)});{cause} pre-fetch and route up the queue"
        )
    else:
        reason = f"alert on {alert.get('name')}: steady, no drift"

    return {
        "drift": drift,
        "fired_on": fired,
        "pct_change": pct,
        "trending": trending,
        "reason": reason,
        "news_context": context,
    }


def alert_band(
    point: float,
    alert: dict,
    max_half_width: float = MAX_BAND_HALF_WIDTH,
) -> "tuple[float, float]":
    """Widen a per-dep probability band in proportion to the alert's move.

    half_width scales with the documented |pct_change| (a 100 percent move maps
    to the full max_half_width), plus a small fixed bump when the alert is
    trending. The point estimate is the verdict's mapped probability; the band
    is the forecast's uncertainty around it. Returns (p_low, p_high) clamped to
    [0, 1] and always containing point.
    """

    p = max(0.0, min(1.0, float(point)))
    pct = alert.get("pct_change")
    move = abs(pct) / 100.0 if pct is not None else 0.0
    half = min(move, 1.0) * max_half_width
    if alert.get("trending"):
        half = min(max_half_width, half + 0.05)
    low = max(0.0, p - half)
    high = min(1.0, p + half)
    return low, high


def make_alert_band_fn(
    alerts: object,
    default_point: float = 0.0,
    max_half_width: float = MAX_BAND_HALF_WIDTH,
):
    """Build a band_fn(dep) for forecast_dependency_tree from an alerts payload.

    Indexes the alerts by name. For a dep whose name has a matching alert the
    band widens per `alert_band`; for a dep with no alert the band collapses to
    (point, point). band_fn only receives the dep dict, so the point it centers
    on is read from the dep's own "probability" field when present (the roll-up
    sets it), else `default_point`.
    """

    index = {a["name"]: a for a in parse_alerts(alerts)}

    def _band_fn(dep: dict) -> "tuple[float, float]":
        name = dep.get("name", "")
        point = dep.get("probability")
        if point is None:
            point = default_point
        alert = index.get(name)
        if alert is None:
            p = max(0.0, min(1.0, float(point)))
            return p, p
        return alert_band(float(point), alert, max_half_width)

    return _band_fn


def alert_scan_depth(
    alert: dict,
    short_horizon_mape: float | None = None,
) -> dict:
    """Pick a gate scan depth from the alert, folded with any MAPE signal.

    The alert's |pct_change| is treated as a volatility proxy (a fractional
    move acts like short-horizon error magnitude) and run through the existing
    `scan_depth_for_volatility`. When a real short-horizon MAPE is also
    available, the DEEPER of the two wins, so a live alert can escalate scan
    depth above what the backtest alone would pick. A trending alert floors the
    depth at standard. Scan depth never decides the verdict.

    Returns the same dict shape as `scan_depth_for_volatility`, plus "source".
    """

    pct = alert.get("pct_change")
    move = abs(pct) / 100.0 if pct is not None else 0.0
    alert_depth = scan_depth_for_volatility(move)

    rank = {"shallow": 0, "standard": 1, "deep": 2}
    chosen = alert_depth
    source = "alert"

    if short_horizon_mape is not None:
        mape_depth = scan_depth_for_volatility(short_horizon_mape)
        if rank[mape_depth["depth"]] > rank[chosen["depth"]]:
            chosen = mape_depth
            source = "mape"

    if alert.get("trending") and rank[chosen["depth"]] < rank["standard"]:
        chosen = scan_depth_for_volatility(0.10)  # floor at standard
        source = "alert-trending-floor"

    result = dict(chosen)
    result["source"] = source
    return result


def narration_context(alert: dict, max_items: int = 3) -> list[str]:
    """Short, citable news lines for the auditor to explain the move.

    Returns up to max_items "title (source_name)" strings from the alert's
    news[]. Documented fields only; this is context the model cites, never a
    score.
    """

    lines: list[str] = []
    for n in alert.get("news") or []:
        title = (n.get("title") or "").strip()
        if not title:
            continue
        source = (n.get("source_name") or "").strip()
        lines.append(f"{title} ({source})" if source else title)
        if len(lines) >= max_items:
            break
    return lines
