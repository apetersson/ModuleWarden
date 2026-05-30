"""Build a REAL trajectory-ranked review queue from a real dependency set.

The headline claim is "the Sybilion forecast ranks your dependencies by growth
and blast-radius trajectory so you review the climbing ones first." This turns
that from a mockup into a real artifact: it forecasts each package's monthly npm
adoption series through Sybilion, then ranks by REAL forecasted growth weighted
by REAL current volume (the blast-radius proxy), and flags packages whose
forecast band is too wide to call as route-to-human.

Every number comes from a real forecast response. Cached packages
(demo/forecast-cache/*.json) are reused for free; the rest are submitted only
under --submit --yes-i-will-spend, with a hard balance floor and a max-new cap so
it cannot drain the trial.

    # dry plan (reuse cache, no spend), shows which packages need a forecast:
    python demo/forecast_review_queue.py
    # forecast the missing ones (billed, guarded):
    python demo/forecast_review_queue.py --submit --yes-i-will-spend

Documented endpoints only. No fabrication; if a package is not forecast it is
listed as pending, never given a made-up number.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import urllib.request
from datetime import date
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from finetune.python.serving.sybilion_forecast import (  # noqa: E402
    aggregate_monthly,
    build_payload,
    fetch_npm_daily,
    submit_and_poll,
    validate_series,
)

DEMO_ROOT = Path(__file__).resolve().parent
CACHE_DIR = DEMO_ROOT / "forecast-cache"
OUT_DIR = DEMO_ROOT / "outputs"

# A real set spanning trajectories: flat giants, climbers, and slowing veterans.
DEFAULT_SET = [
    "lodash", "react", "express", "chalk",          # flat high-volume giants
    "date-fns", "zod", "vite", "tailwindcss",        # climbers
    "moment", "request",                             # slowing / deprecated veterans
]

BALANCE_FLOOR_CENTS = 400   # stop submitting if available falls below 4 EUR
MAX_NEW_SUBMITS = 10


def _me_available(token: str) -> int | None:
    try:
        r = urllib.request.Request("https://api.sybilion.dev/api/v1/me")
        r.add_header("Authorization", f"Bearer {token}")
        me = json.loads(urllib.request.urlopen(r, timeout=20).read())
        return me.get("available_eur_cents")
    except Exception:
        return None


def _load_cached(pkg: str) -> dict | None:
    f = CACHE_DIR / f"{pkg}.json"
    if f.exists():
        return json.loads(f.read_text(encoding="utf-8"))
    return None


def _forecast_one(pkg: str, token: str, years: int = 8) -> dict | None:
    end = date.today()
    start = date(end.year - years, 1, 1)
    monthly = aggregate_monthly(fetch_npm_daily(pkg, start, end))
    ok, problems = validate_series(monthly, horizon_max=6)
    if not ok:
        return {"package": pkg, "skipped": True, "problems": problems}
    payload = build_payload(pkg, monthly, soft_horizon=6, hard_horizon=3)
    res = submit_and_poll(token, payload)
    if not res.get("ok"):
        # The job was submitted and billed even if the poll window expired, so
        # persist its job_id and the (free) history to a recovery stub. A later
        # run can fetch the completed artifact instead of re-submitting (and
        # re-paying). Never lose a paid job to a poll timeout again.
        jid = res.get("job_id")
        if jid:
            (CACHE_DIR / f"{pkg}.pending.json").write_text(
                json.dumps({"package": pkg, "job_id": jid, "history": monthly}), encoding="utf-8"
            )
        return {"package": pkg, "skipped": True, "problems": [f"submit ok, poll {res.get('reason') or res.get('stage')}; job_id saved for recovery"]}
    out = {
        "package": pkg,
        "job_id": res.get("job_id"),
        "mape_6m": res.get("mape_6m"),
        "history": monthly,
        "forecast": res["forecast"]["data"] if isinstance(res.get("forecast"), dict) and "data" in res["forecast"] else res.get("forecast"),
    }
    (CACHE_DIR / f"{pkg}.json").write_text(json.dumps(out), encoding="utf-8")
    return out


def _metrics(rec: dict) -> dict | None:
    """Compute the ranking metrics from a real forecast record."""
    hist = rec.get("history") or {}
    fc = rec.get("forecast") or {}
    series = fc.get("forecast_series") or {}
    if not hist or not series:
        return None
    hkeys = sorted(hist.keys())
    current = float(hist[hkeys[-1]])
    fkeys = sorted(series.keys())
    q50 = [series[k]["quantile_forecast"]["0.50"] for k in fkeys]
    end_med = float(q50[-1])
    # Forecasted 6-month growth relative to the current level.
    growth = (end_med - current) / current if current else 0.0
    # Relative band width at the horizon end (uncertainty).
    last = series[fkeys[-1]]["quantile_forecast"]
    band = (float(last["0.95"]) - float(last["0.05"])) / end_med if end_med else 0.0
    return {
        "current_per_month": current,
        "forecast_growth_6m": growth,
        "band_width_rel": band,
        "mape_6m": rec.get("mape_6m"),
        "job_id": rec.get("job_id"),
    }


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(description="Build a real trajectory-ranked review queue.")
    p.add_argument("--packages", nargs="*", default=DEFAULT_SET)
    p.add_argument("--submit", action="store_true")
    p.add_argument("--yes-i-will-spend", action="store_true")
    args = p.parse_args(argv)

    token = os.environ.get("SYBILION_API_TOKEN")
    records: dict[str, dict] = {}
    pending: list[str] = []
    new_submits = 0

    for pkg in args.packages:
        cached = _load_cached(pkg)
        if cached and cached.get("history") and cached.get("forecast"):
            records[pkg] = cached
            continue
        if not (args.submit and args.yes_i_will_spend):
            pending.append(pkg)
            continue
        if not token:
            print("SYBILION_API_TOKEN not set; cannot submit.", file=sys.stderr)
            pending.append(pkg)
            continue
        avail = _me_available(token)
        if avail is not None and avail < BALANCE_FLOOR_CENTS:
            print(f"balance floor reached ({avail} cents); stopping submits.", file=sys.stderr)
            pending.append(pkg)
            continue
        if new_submits >= MAX_NEW_SUBMITS:
            pending.append(pkg)
            continue
        print(f"forecasting {pkg} ...", file=sys.stderr)
        rec = _forecast_one(pkg, token)
        new_submits += 1
        if rec and not rec.get("skipped"):
            records[pkg] = rec
        else:
            pending.append(pkg + (f" ({rec.get('problems')})" if rec else ""))

    # Rank by forecasted growth scaled by blast-radius (current volume), the
    # exact thesis: climbing-toward-critical and high blast radius first.
    rows = []
    for pkg, rec in records.items():
        m = _metrics(rec)
        if not m:
            continue
        # log-volume so a giant does not dwarf everything; growth is the driver.
        import math
        vol_weight = math.log10(max(m["current_per_month"], 1.0))
        score = m["forecast_growth_6m"] * vol_weight
        m["package"] = pkg
        m["priority_score"] = score
        m["route_to_human"] = m["band_width_rel"] >= 1.0  # band wider than the median
        rows.append(m)

    rows.sort(key=lambda r: r["priority_score"], reverse=True)

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    (OUT_DIR / "review-queue.json").write_text(
        json.dumps({"ranked": rows, "pending": pending}, indent=2, default=str), encoding="utf-8"
    )

    lines = [
        "# Real trajectory-ranked review queue",
        "",
        "Built from live Sybilion forecasts of real npm adoption series. Ranked by",
        "forecasted 6-month growth scaled by log current volume (blast radius).",
        "Every number is from a real forecast response.",
        "",
        "| # | package | current M/mo | fc 6m growth | band width | 6m MAPE | action |",
        "|---|---------|-------------:|-------------:|-----------:|--------:|--------|",
    ]
    for i, r in enumerate(rows, 1):
        action = "route to human (wide band)" if r["route_to_human"] else "queue by rank"
        mape = f"{r['mape_6m']:.1f}%" if r.get("mape_6m") is not None else "n/a"
        lines.append(
            f"| {i} | {r['package']} | {r['current_per_month']/1e6:.1f} | "
            f"{r['forecast_growth_6m']*100:+.0f}% | {r['band_width_rel']:.2f} | {mape} | {action} |"
        )
    if pending:
        lines += ["", "Pending (not yet forecast): " + ", ".join(pending)]
    (OUT_DIR / "review-queue.md").write_text("\n".join(lines) + "\n", encoding="utf-8")

    print("\n".join(lines))
    print(f"\nforecast records: {len(rows)}  pending: {len(pending)}  new submits this run: {new_submits}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
