"""Live forecast feeder: a real npm adoption series into Sybilion POST /forecasts.

This closes the gap the red-team flagged: nothing in the suite actually submits a
real monthly series to Sybilion. It builds a package's monthly adoption series
from npm's OWN public downloads API (api.npmjs.org, free, no key), validates it
against the documented history floor, builds the EXACT documented forecast
payload, and (only when explicitly told to spend) submits it, polls, and pulls
the quantile band plus the backtest MAPE.

Demo-safety and discipline:
- Default is a DRY RUN: fetch npm (free), aggregate, validate, and print the
  payload summary. No Sybilion call, no spend.
- The billed submit is gated behind --submit AND --yes-i-will-spend, and is
  hard-capped at one submission (~3 EUR cents).
- Liveness proof is the documented job_id and created_at from the response, not
  an invented cache-buster.
- The API key is read from SYBILION_API_TOKEN, never embedded. Rotate the key if
  it was ever pasted into a chat.
- Honest framing: this forecasts adoption TRAJECTORY, not maliciousness. The
  deterministic gate still decides. Downloads are CI-noisy, so we forecast a
  mid-tier climber to show real slope, not only a flat high-volume package.

The exact documented payload (docs/sybillion-api/forecasts-submit.md): monthly
frequency, keys YYYY-MM-01, timeseries is an OBJECT map, history floor 40/60/120
monthly points by horizon, latest observation within the past 12 months.

Pure standard library (urllib, json, datetime). No third-party deps.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import urllib.error
import urllib.request
from datetime import date, datetime, timezone

NPM_BASE = "https://api.npmjs.org/downloads/range"
SYBILION_BASE = "https://api.sybilion.dev"

# History floor: minimum monthly points by horizonMax (forecasts-submit.md).
FLOOR = {3: 40, 6: 60, 12: 120}


# --------------------------------------------------------------------------
# npm public download series (free, no key)
# --------------------------------------------------------------------------


def _http_get_json(url: str, timeout: float = 30.0) -> object:
    req = urllib.request.Request(url, method="GET", headers={"User-Agent": "modulewarden-forecast-feeder"})
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read().decode("utf-8", "replace"))


def _month_windows(start: date, end: date, max_days: int = 540) -> list[tuple[str, str]]:
    """npm's range endpoint caps at ~18 months; chunk the span into windows."""
    windows: list[tuple[str, str]] = []
    cur = start
    while cur <= end:
        stop = min(end, date.fromordinal(cur.toordinal() + max_days - 1))
        windows.append((cur.isoformat(), stop.isoformat()))
        cur = date.fromordinal(stop.toordinal() + 1)
    return windows


def fetch_npm_daily(package: str, start: date, end: date) -> list[dict]:
    """Fetch daily download counts for package across the span (chunked)."""
    days: list[dict] = []
    for w_start, w_end in _month_windows(start, end):
        url = f"{NPM_BASE}/{w_start}:{w_end}/{package}"
        data = _http_get_json(url)
        if isinstance(data, dict) and isinstance(data.get("downloads"), list):
            days.extend(data["downloads"])
    return days


def aggregate_monthly(daily: list[dict], drop_partial_current: bool = True) -> dict:
    """Aggregate npm daily rows into a {YYYY-MM-01: total} monthly map.

    Pure function: testable without network. Sums downloads per calendar month
    and keys each month at its first day. Optionally drops the current
    (incomplete) month so the latest point is a full month.
    """
    monthly: dict[str, float] = {}
    for row in daily:
        day = row.get("day")
        cnt = row.get("downloads")
        if not isinstance(day, str) or len(day) < 7:
            continue
        try:
            val = float(cnt)
        except (TypeError, ValueError):
            continue
        key = day[:7] + "-01"  # YYYY-MM-01
        monthly[key] = monthly.get(key, 0.0) + val

    if drop_partial_current and monthly:
        this_month = datetime.now(timezone.utc).strftime("%Y-%m-01")
        monthly.pop(this_month, None)
    return dict(sorted(monthly.items()))


def validate_series(monthly: dict, horizon_max: int) -> tuple[bool, list[str]]:
    """Check the monthly series against the documented submit rules."""
    problems: list[str] = []
    keys = list(monthly.keys())
    floor = FLOOR.get(horizon_max, 60)

    if len(keys) < floor:
        problems.append(f"only {len(keys)} monthly points; floor for horizon {horizon_max} is {floor}")

    # no gaps in the monthly grid
    for i in range(1, len(keys)):
        prev = datetime.strptime(keys[i - 1], "%Y-%m-%d")
        cur = datetime.strptime(keys[i], "%Y-%m-%d")
        months = (cur.year - prev.year) * 12 + (cur.month - prev.month)
        if months != 1:
            problems.append(f"gap in monthly grid between {keys[i-1]} and {keys[i]}")
            break

    # recency: latest within the past 12 months
    if keys:
        latest = datetime.strptime(keys[-1], "%Y-%m-%d").replace(tzinfo=timezone.utc)
        now = datetime.now(timezone.utc)
        age_months = (now.year - latest.year) * 12 + (now.month - latest.month)
        if age_months > 12:
            problems.append(f"latest point {keys[-1]} is older than 12 months")

    return (not problems), problems


def build_payload(package: str, monthly: dict, soft_horizon: int = 6, hard_horizon: int = 3) -> dict:
    """Build the EXACT documented POST /forecasts payload."""
    title = f"npm monthly downloads for {package}, supply-chain adoption trajectory"
    # title must be >= 20 bytes; the prefix guarantees it.
    return {
        "pipeline_version": "v1",
        "frequency": "monthly",
        "soft_horizon": soft_horizon,
        "hard_horizon": hard_horizon,
        "backtest": True,
        "recency_factor": 0.6,
        "strictly_positive": True,
        "timeseries_metadata": {
            "title": title,
            "description": f"Monthly npm download totals for {package}, aggregated from the public npm downloads API.",
            "keywords": ["npm", "package", "dependency", "adoption", "downloads", "supply-chain", package],
        },
        "timeseries": {k: float(v) for k, v in monthly.items()},
    }


# --------------------------------------------------------------------------
# Sybilion submit + poll + artifacts (billed; gated)
# --------------------------------------------------------------------------


def _sybilion_post(path: str, token: str, body: dict, timeout: float = 60.0) -> tuple[int, object]:
    data = json.dumps(body).encode("utf-8")
    req = urllib.request.Request(SYBILION_BASE + path, data=data, method="POST")
    req.add_header("Authorization", f"Bearer {token}")
    req.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return resp.getcode(), json.loads(resp.read().decode("utf-8", "replace"))
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode("utf-8", "replace")


def _sybilion_get(path: str, token: str, timeout: float = 30.0) -> tuple[int, object]:
    req = urllib.request.Request(SYBILION_BASE + path, method="GET")
    req.add_header("Authorization", f"Bearer {token}")
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return resp.getcode(), json.loads(resp.read().decode("utf-8", "replace"))
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode("utf-8", "replace")


def submit_and_poll(token: str, payload: dict, poll_seconds: float = 3.0, max_polls: int = 120) -> dict:
    """Submit one forecast and poll to completion. Billed (~3 EUR cents).

    Default poll window is 6 minutes (120 x 3s); a large series (e.g. lodash at
    100 monthly points) can take over two minutes to settle, so a short window
    reports a false timeout while the job is still running.
    """
    import time

    code, body = _sybilion_post("/api/v1/forecasts", token, payload)
    if code not in (200, 201, 202) or not isinstance(body, dict):
        return {"ok": False, "stage": "submit", "status": code, "body": body}

    job_id = body.get("job_id") or body.get("id")
    created_at = body.get("created_at")
    if not job_id:
        return {"ok": False, "stage": "submit", "status": code, "body": body}

    final = None
    for _ in range(max_polls):
        time.sleep(poll_seconds)
        code, st = _sybilion_get(f"/api/v1/forecasts/{job_id}", token)
        if isinstance(st, dict) and st.get("status") == "completed":
            final = st
            break
        if isinstance(st, dict) and st.get("status") in ("failed", "canceled"):
            return {"ok": False, "stage": "poll", "status": st.get("status"), "job_id": job_id}
    if final is None:
        return {"ok": False, "stage": "poll", "reason": "timed out", "job_id": job_id}

    # Pull the two artifacts that carry the band and the honesty number.
    _, fc = _sybilion_get(f"/api/v1/forecasts/{job_id}/artifacts/forecast.json", token)
    _, bt = _sybilion_get(f"/api/v1/forecasts/{job_id}/artifacts/backtest_metrics.json", token)

    # Surface the two presentable numbers. The live API returns 19 quantiles
    # (0.05..0.95), not the docs' 0.1/0.5/0.9 example, and the backtest metric
    # keys are uppercase (MAE/MAPE/MASE/RMSE/RMSSE).
    quantile_count = None
    if isinstance(fc, dict):
        series = fc.get("data", {}).get("forecast_series", {})
        if series:
            first = next(iter(series.values()))
            qf = first.get("quantile_forecast") or {}
            quantile_count = len(qf) or None
    mape_6m = None
    if isinstance(bt, dict):
        mape_6m = bt.get("data", {}).get("6m", {}).get("metrics", {}).get("MAPE")

    return {
        "ok": True,
        "job_id": job_id,
        "created_at": created_at,  # liveness proof
        "quantile_count": quantile_count,
        "mape_6m": mape_6m,
        "forecast": fc,
        "backtest_metrics": bt,
    }


# --------------------------------------------------------------------------
# CLI
# --------------------------------------------------------------------------


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(description="Feed a real npm adoption series into Sybilion (dry-run by default).")
    p.add_argument("--package", default="date-fns", help="npm package (default date-fns: a mid-tier climber, not a flat giant)")
    p.add_argument("--years", type=int, default=8, help="years of history to pull")
    p.add_argument("--soft-horizon", type=int, default=6)
    p.add_argument("--hard-horizon", type=int, default=3)
    p.add_argument("--submit", action="store_true", help="actually submit to Sybilion (billed)")
    p.add_argument("--yes-i-will-spend", action="store_true", help="required confirmation for --submit")
    p.add_argument("--json", action="store_true")
    args = p.parse_args(argv)

    end = date.today()
    start = date(end.year - args.years, 1, 1)
    try:
        daily = fetch_npm_daily(args.package, start, end)
    except (urllib.error.URLError, TimeoutError, OSError) as e:
        print(f"npm fetch failed: {e}", file=sys.stderr)
        return 2

    monthly = aggregate_monthly(daily)
    horizon_max = max(args.soft_horizon, args.hard_horizon)
    ok, problems = validate_series(monthly, horizon_max)
    payload = build_payload(args.package, monthly, args.soft_horizon, args.hard_horizon)

    keys = list(monthly.keys())
    summary = {
        "package": args.package,
        "monthly_points": len(keys),
        "floor_for_horizon": FLOOR.get(horizon_max, 60),
        "range": [keys[0], keys[-1]] if keys else [],
        "passes_validation": ok,
        "problems": problems,
        "payload_title": payload["timeseries_metadata"]["title"],
    }

    if not args.submit:
        summary["mode"] = "dry-run (no Sybilion call, no spend)"
        print(json.dumps(summary, indent=2) if args.json else _fmt(summary))
        return 0 if ok else 1

    if not args.yes_i_will_spend:
        print("Refusing to submit without --yes-i-will-spend (this is a billed call).", file=sys.stderr)
        return 2
    if not ok:
        print(f"Series fails validation, not submitting: {problems}", file=sys.stderr)
        return 1
    token = os.environ.get("SYBILION_API_TOKEN")
    if not token:
        print("SYBILION_API_TOKEN is not set (use the rotated key).", file=sys.stderr)
        return 2

    result = submit_and_poll(token, payload)
    print(json.dumps({**summary, "result": result}, indent=2, default=str))
    return 0 if result.get("ok") else 1


def _fmt(s: dict) -> str:
    lines = [
        f"  package           {s['package']}",
        f"  monthly points    {s['monthly_points']} (floor {s['floor_for_horizon']})",
        f"  range             {s['range']}",
        f"  passes validation {s['passes_validation']}",
    ]
    if s["problems"]:
        lines.append(f"  problems          {s['problems']}")
    lines.append(f"  mode              {s.get('mode', '')}")
    return "\n".join(lines)


if __name__ == "__main__":
    sys.exit(main())
