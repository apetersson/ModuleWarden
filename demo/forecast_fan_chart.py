"""Render a real Sybilion forecast as a quantile fan chart.

Reads a cached fixture written by the live discovery run (history + the live
forecast.json with 19 quantiles + the real 6-month backtest MAPE) and draws the
fan: historical npm downloads, then the probabilistic forecast band fanning out
over six months, annotated with the real MAPE and the live job_id. No key, no
network, no spend; it renders from the cached real response, which is the
demo-safe pattern (cache the real data, render from it, prove liveness with the
job_id).

    python demo/forecast_fan_chart.py --package date-fns
    python demo/forecast_fan_chart.py --package lodash

Output PNGs land in demo/outputs/ and, when present, the website media dir.
"""

from __future__ import annotations

import argparse
import json
from datetime import datetime
from pathlib import Path

import matplotlib

matplotlib.use("Agg")
import matplotlib.dates as mdates
import matplotlib.pyplot as plt

_THIS = Path(__file__).resolve()
DEMO_ROOT = _THIS.parent
CACHE_DIR = DEMO_ROOT / "forecast-cache"
OUT_DIR = DEMO_ROOT / "outputs"
WEBSITE_MEDIA = DEMO_ROOT.parent.parent / "modulewarden-website" / "media"

# Dark palette matched to the pitch website.
BG = "#0f172a"
PANEL = "#0b1220"
HIST = "#94a3b8"
MEDIAN = "#34d399"
FAN_OUTER = "#34d399"
TEXT = "#e2e8f0"
MUTED = "#64748b"


def _dt(key: str) -> datetime:
    return datetime.strptime(key, "%Y-%m-%d")


def render(package: str) -> Path:
    fixture = CACHE_DIR / f"{package}.json"
    data = json.loads(fixture.read_text(encoding="utf-8"))
    history = data["history"]
    fseries = data["forecast"]["forecast_series"]
    mape6 = data.get("mape_6m")
    job_id = data.get("job_id", "")

    # History: last 30 months for context.
    hkeys = sorted(history.keys())[-30:]
    hx = [_dt(k) for k in hkeys]
    hy = [history[k] / 1e6 for k in hkeys]

    # Forecast: build the 19-quantile arrays across the forecast months, with the
    # last history point prepended so the fan emerges from the actual series.
    fkeys = sorted(fseries.keys())
    fx = [hx[-1]] + [_dt(k) for k in fkeys]

    def band(q: str) -> list:
        return [hy[-1]] + [fseries[k]["quantile_forecast"][q] / 1e6 for k in fkeys]

    q05, q25, q50, q75, q95 = band("0.05"), band("0.25"), band("0.50"), band("0.75"), band("0.95")

    fig, ax = plt.subplots(figsize=(11, 6.2), dpi=140)
    fig.patch.set_facecolor(BG)
    ax.set_facecolor(PANEL)

    ax.plot(hx, hy, color=HIST, lw=2.0, label="npm monthly downloads (actual)")
    ax.fill_between(fx, q05, q95, color=FAN_OUTER, alpha=0.12, label="forecast 0.05-0.95")
    ax.fill_between(fx, q25, q75, color=FAN_OUTER, alpha=0.22, label="forecast 0.25-0.75")
    ax.plot(fx, q50, color=MEDIAN, lw=2.4, label="forecast median (0.50)")
    ax.axvline(hx[-1], color=MUTED, lw=1.0, ls=":", alpha=0.7)

    ax.set_title(
        f"{package}: real Sybilion 6-month probabilistic forecast",
        color=TEXT, fontsize=15, fontweight="bold", loc="left", pad=30,
    )
    sub = f"19 quantiles (0.05-0.95) from a live run. Backtest 6-month MAPE {mape6:.1f} percent. job {job_id[:8]}"
    ax.text(0.0, 1.045, sub, transform=ax.transAxes, color=MUTED, fontsize=9.5)

    ax.set_ylabel("downloads per month (millions)", color=TEXT, fontsize=10)
    ax.tick_params(colors=MUTED, labelsize=9)
    for spine in ax.spines.values():
        spine.set_color("#1e293b")
    ax.xaxis.set_major_formatter(mdates.DateFormatter("%Y-%m"))
    ax.grid(True, color="#1e293b", lw=0.6, alpha=0.6)

    leg = ax.legend(loc="upper left", facecolor=PANEL, edgecolor="#1e293b", fontsize=8.5, labelcolor=TEXT)
    leg.get_frame().set_alpha(0.9)

    cap = (
        "The forecast prioritizes by trajectory; it does not detect. The gate owns the verdict. "
        "Rendered from the cached live response."
    )
    fig.text(0.012, 0.012, cap, color=MUTED, fontsize=8)
    fig.tight_layout(rect=(0, 0.03, 1, 1))

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    out = OUT_DIR / f"forecast-fan-{package}.png"
    fig.savefig(out, facecolor=BG)
    if WEBSITE_MEDIA.is_dir():
        fig.savefig(WEBSITE_MEDIA / f"forecast-fan-{package}.png", facecolor=BG)
    plt.close(fig)
    return out


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(description="Render a real Sybilion forecast fan chart from cache.")
    p.add_argument("--package", default="date-fns")
    args = p.parse_args(argv)
    out = render(args.package)
    print(f"wrote {out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
