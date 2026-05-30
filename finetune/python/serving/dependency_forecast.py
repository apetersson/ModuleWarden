"""Submission-level supply-chain compromise forecasting for dependency trees.

This module powers the "lazy employee" Sybilion demo. A developer pulls a set
of dependencies into the company codebase (a package.json, a list of pinned
versions, or a hand-typed set of "name@version" strings). Each dependency is
scored by a pluggable per-dependency probability function, then the per-dep
probabilities are rolled up into one calibrated submission-level forecast.

The forecasting framing, instead of a binary allow / quarantine / block
verdict, we emit:

  - submission_risk: the probability that AT LEAST ONE dependency in the set
    is compromised, computed as 1 - product(1 - p_i). This is the number an
    acting agent gates on.
  - expected_compromised: the expected COUNT of compromised dependencies,
    sum(p_i). A real forecasting quantity that scales with tree size even when
    submission_risk saturates near 1.0.
  - riskiest: the dependencies sorted by probability descending, so the memo
    can name names.

The scoring callable is injected, not imported. That keeps this module pure
standard library and testable with stub callables, no model and no GPU.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Callable, Iterable

__all__ = [
    "Dependency",
    "ScoreFn",
    "BandFn",
    "parse_dependencies",
    "forecast_dependency_tree",
    "scan_depth_for_volatility",
    "summarize",
]

# A per-dependency scorer takes a normalized {"name", "version"} dict and
# returns the compromise probability for that single dependency in [0, 1].
ScoreFn = Callable[[dict], float]

# A per-dependency band function returns the (low, high) quantile bounds on
# that dependency's compromise probability, both in [0, 1]. It is the
# probabilistic counterpart of ScoreFn: where ScoreFn gives the point estimate
# the gate's verdict maps to, BandFn gives the forecast's uncertainty around
# it. Optional, when omitted the roll-up degenerates to the point estimate.
BandFn = Callable[[dict], "tuple[float, float]"]

_UNKNOWN_VERSION = "unknown"


@dataclass(frozen=True)
class Dependency:
    """A single normalized dependency entry.

    Kept as a small frozen record for callers that prefer attribute access.
    The public functions work in plain dicts so the module stays trivially
    serializable, this is a convenience, not a requirement.
    """

    name: str
    version: str

    def as_dict(self) -> dict:
        return {"name": self.name, "version": self.version}


def _clamp_probability(value: Any) -> float:
    """Coerce a score to a float and clamp it to [0, 1].

    Non-numeric or NaN scores collapse to 0.0 rather than raising, so a flaky
    stub or a model that returns junk for one dependency cannot poison the
    whole forecast.
    """

    try:
        p = float(value)
    except (TypeError, ValueError):
        return 0.0
    # NaN compares false against everything, catch it explicitly.
    if p != p:
        return 0.0
    if p < 0.0:
        return 0.0
    if p > 1.0:
        return 1.0
    return p


def _normalize_string(spec: str) -> dict:
    """Turn a "name@version" (or bare "name") string into a dep dict."""

    text = spec.strip()
    if "@" in text:
        # rsplit handles scoped npm names like "@scope/pkg@1.2.3" correctly,
        # the leading "@" stays with the name, only the version splits off.
        name, _, version = text.rpartition("@")
        if not name:
            # The "@" was a leading scope marker only, e.g. "@scope/pkg".
            name, version = text, _UNKNOWN_VERSION
    else:
        name, version = text, _UNKNOWN_VERSION
    return {"name": name.strip(), "version": (version or _UNKNOWN_VERSION).strip()}


def _normalize_mapping_entry(name: str, version: Any) -> dict:
    ver = str(version).strip() if version is not None else ""
    return {"name": str(name).strip(), "version": ver or _UNKNOWN_VERSION}


def parse_dependencies(deps: Any) -> list[dict]:
    """Normalize one of three accepted dependency input shapes.

    Accepts:
      1. A list of "name@version" strings (or bare "name").
      2. A list of {"name", "version"} dicts.
      3. A package.json-style {"dependencies": {name: version}} mapping. A bare
         {name: version} mapping (no "dependencies" key) is accepted too.

    Returns a list of normalized {"name", "version"} dicts. Entries with an
    empty name after stripping are dropped.
    """

    if deps is None:
        return []

    raw_pairs: list[dict] = []

    if isinstance(deps, dict):
        # package.json style, or a plain {name: version} table.
        inner = deps.get("dependencies", deps) if "dependencies" in deps else deps
        if not isinstance(inner, dict):
            inner = {}
        for name, version in inner.items():
            raw_pairs.append(_normalize_mapping_entry(name, version))
    elif isinstance(deps, (list, tuple)):
        for item in deps:
            if isinstance(item, dict):
                name = item.get("name", "")
                version = item.get("version", _UNKNOWN_VERSION)
                raw_pairs.append(_normalize_mapping_entry(name, version))
            elif isinstance(item, str):
                raw_pairs.append(_normalize_string(item))
            else:
                # Skip anything we do not understand rather than guessing.
                continue
    else:
        raise TypeError(
            "deps must be a list of strings/dicts or a dependencies mapping, "
            f"got {type(deps).__name__}"
        )

    return [pair for pair in raw_pairs if pair["name"]]


def _product_of_survivals(probabilities: Iterable[float]) -> float:
    """Return product(1 - p_i). The chance NOTHING is compromised."""

    survival = 1.0
    for p in probabilities:
        survival *= 1.0 - p
    return survival


def _band_bounds(band_fn: BandFn | None, dep: dict, point: float) -> "tuple[float, float]":
    """Resolve a dependency's (low, high) probability band.

    With no band_fn the band collapses to the point estimate (width 0). With a
    band_fn the returned bounds are clamped and reordered so low <= high, and
    the point estimate is pulled inside the band if a flaky callable returns a
    band that does not contain it. A band_fn that raises degrades to the point
    estimate rather than killing the whole roll-up.
    """

    if band_fn is None:
        return point, point
    try:
        low, high = band_fn(dep)
    except Exception:
        return point, point
    low = _clamp_probability(low)
    high = _clamp_probability(high)
    if low > high:
        low, high = high, low
    # Keep the point estimate inside its own band; the gate's verdict should
    # never sit outside the forecast's interval.
    low = min(low, point)
    high = max(high, point)
    return low, high


def forecast_dependency_tree(
    deps: Any,
    score_fn: ScoreFn,
    band_fn: BandFn | None = None,
    wide_band_threshold: float = 0.30,
) -> dict:
    """Score a dependency set and roll it up into a submission-level forecast.

    Args:
      deps: any shape accepted by parse_dependencies.
      score_fn: callable taking a normalized {"name", "version"} dict and
        returning that dependency's compromise probability in [0, 1]. Pluggable,
        a trained model or a hand-built stub. Returned scores are clamped.
      band_fn: optional callable returning that dependency's (low, high)
        quantile bounds. When provided, the roll-up is computed at the low and
        high bounds too, so submission_risk carries a forecast interval instead
        of a single point. When omitted the interval collapses onto the point.
      wide_band_threshold: a dependency whose band is at least this wide is
        flagged high-volatility and routed to a human, the forecast is too
        uncertain on it to lean on the point estimate.

    Returns a dict with:
      per_dep: [{"name", "version", "probability", "p_low", "p_high",
        "band_width", "route_to_human"}] in input order.
      submission_risk: 1 - product(1 - p_i), the probability that at least one
        dependency is compromised. 0.0 for an empty set.
      submission_risk_interval: {"low", "high", "width"}, the same roll-up at
        the per-dep low and high bounds. Collapses to (point, point, 0.0) with
        no band_fn. This is the honest probabilistic number: a band, not a
        point dressed as one.
      expected_compromised: sum(p_i), expected count of compromised deps. 0.0
        for an empty set.
      riskiest: per_dep sorted by probability descending (stable on ties).
      high_volatility: per_dep entries whose band_width >= wide_band_threshold,
        the ones the forecast cannot call tightly and that route to a human.
      n_deps: number of scored dependencies.
      mean_probability: arithmetic mean of probabilities, 0.0 for an empty set.
    """

    parsed = parse_dependencies(deps)

    per_dep: list[dict] = []
    for dep in parsed:
        probability = _clamp_probability(score_fn(dep))
        p_low, p_high = _band_bounds(band_fn, dep, probability)
        band_width = p_high - p_low
        per_dep.append(
            {
                "name": dep["name"],
                "version": dep["version"],
                "probability": probability,
                "p_low": p_low,
                "p_high": p_high,
                "band_width": band_width,
                "route_to_human": band_width >= wide_band_threshold,
            }
        )

    n_deps = len(per_dep)
    probabilities = [entry["probability"] for entry in per_dep]

    if n_deps == 0:
        submission_risk = 0.0
        expected_compromised = 0.0
        mean_probability = 0.0
        risk_low = 0.0
        risk_high = 0.0
    else:
        submission_risk = 1.0 - _product_of_survivals(probabilities)
        expected_compromised = sum(probabilities)
        mean_probability = expected_compromised / n_deps
        risk_low = 1.0 - _product_of_survivals(e["p_low"] for e in per_dep)
        risk_high = 1.0 - _product_of_survivals(e["p_high"] for e in per_dep)

    # Stable sort keeps input order among equal-probability deps.
    riskiest = sorted(per_dep, key=lambda entry: entry["probability"], reverse=True)
    high_volatility = [entry for entry in per_dep if entry["route_to_human"]]

    return {
        "per_dep": per_dep,
        "submission_risk": submission_risk,
        "submission_risk_interval": {
            "low": risk_low,
            "high": risk_high,
            "width": risk_high - risk_low,
        },
        "expected_compromised": expected_compromised,
        "riskiest": riskiest,
        "high_volatility": high_volatility,
        "n_deps": n_deps,
        "mean_probability": mean_probability,
    }


def scan_depth_for_volatility(
    short_horizon_mape: float,
    standard_above: float = 0.10,
    deep_above: float = 0.25,
) -> dict:
    """Map a forecast's short-horizon error to how hard the gate should look.

    The conceded result is that the Sybilion forecast does not detect a dying
    or compromised package. What it does track is volatility: a noisy,
    fast-moving series. High short-horizon MAPE means frequent version bumps,
    which means a larger cumulative version-delta surface for an attacker to
    hide in. So we do not ask the forecast to judge the package. We let its
    volatility set how deep the deterministic gate scans the delta.

    Returns {"depth", "scan_multiplier", "reason"} where depth is one of
    "shallow" / "standard" / "deep". depth never decides the verdict, it only
    scales scrutiny. A NaN or negative MAPE falls back to "standard".
    """

    try:
        mape = float(short_horizon_mape)
    except (TypeError, ValueError):
        mape = standard_above
    if mape != mape or mape < 0.0:  # NaN or negative
        mape = standard_above

    if mape >= deep_above:
        depth, mult = "deep", 2.0
    elif mape >= standard_above:
        depth, mult = "standard", 1.0
    else:
        depth, mult = "shallow", 0.5

    return {
        "depth": depth,
        "scan_multiplier": mult,
        "reason": (
            f"short-horizon MAPE {mape:.3f} -> {depth} delta scan "
            f"(deep>={deep_above:.2f}, standard>={standard_above:.2f}); "
            f"volatility scales scrutiny, it does not decide the verdict"
        ),
    }


def summarize(result: dict, top_k: int = 3) -> str:
    """Render a one-paragraph memo for the acting agent.

    Names the top_k riskiest dependencies and states submission_risk as a
    percentage. Safe on an empty forecast.
    """

    n_deps = result.get("n_deps", 0)
    submission_risk = _clamp_probability(result.get("submission_risk", 0.0))
    risk_pct = submission_risk * 100.0

    if n_deps == 0:
        return (
            "No dependencies were submitted, so the submission-level "
            "supply-chain risk is 0.0 percent. Nothing for the agent to act on."
        )

    expected = float(result.get("expected_compromised", 0.0))
    riskiest = result.get("riskiest", [])
    k = max(0, int(top_k))
    top = riskiest[:k]

    if top:
        named = ", ".join(
            f"{entry['name']}@{entry['version']} "
            f"({_clamp_probability(entry.get('probability', 0.0)) * 100.0:.1f} percent)"
            for entry in top
        )
        names_clause = f" The riskiest dependencies are {named}."
    else:
        names_clause = ""

    interval = result.get("submission_risk_interval") or {}
    width = float(interval.get("width", 0.0))
    if width > 1e-9:
        lo = _clamp_probability(interval.get("low", submission_risk)) * 100.0
        hi = _clamp_probability(interval.get("high", submission_risk)) * 100.0
        band_clause = (
            f" The forecast band runs {lo:.1f} to {hi:.1f} percent; "
            f"the wider that band, the less the point estimate can be trusted."
        )
    else:
        band_clause = ""

    n_route = len(result.get("high_volatility", []))
    if n_route:
        route_word = "dependency" if n_route == 1 else "dependencies"
        route_clause = (
            f" {n_route} {route_word} carry a band too wide to call and route "
            f"to a human."
        )
    else:
        route_clause = ""

    dep_word = "dependency" if n_deps == 1 else "dependencies"
    return (
        f"Across {n_deps} {dep_word}, the forecast puts the chance that at "
        f"least one introduces a supply-chain compromise at {risk_pct:.1f} "
        f"percent, with an expected {expected:.2f} compromised "
        f"{dep_word}.{names_clause}{band_clause}{route_clause}"
    )
