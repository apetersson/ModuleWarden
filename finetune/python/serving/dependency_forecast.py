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
    "parse_dependencies",
    "forecast_dependency_tree",
    "summarize",
]

# A per-dependency scorer takes a normalized {"name", "version"} dict and
# returns the compromise probability for that single dependency in [0, 1].
ScoreFn = Callable[[dict], float]

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


def forecast_dependency_tree(deps: Any, score_fn: ScoreFn) -> dict:
    """Score a dependency set and roll it up into a submission-level forecast.

    Args:
      deps: any shape accepted by parse_dependencies.
      score_fn: callable taking a normalized {"name", "version"} dict and
        returning that dependency's compromise probability in [0, 1]. Pluggable,
        a trained model or a hand-built stub. Returned scores are clamped.

    Returns a dict with:
      per_dep: [{"name", "version", "probability"}] in input order.
      submission_risk: 1 - product(1 - p_i), the probability that at least one
        dependency is compromised. 0.0 for an empty set.
      expected_compromised: sum(p_i), expected count of compromised deps. 0.0
        for an empty set.
      riskiest: per_dep sorted by probability descending (stable on ties).
      n_deps: number of scored dependencies.
      mean_probability: arithmetic mean of probabilities, 0.0 for an empty set.
    """

    parsed = parse_dependencies(deps)

    per_dep: list[dict] = []
    for dep in parsed:
        probability = _clamp_probability(score_fn(dep))
        per_dep.append(
            {
                "name": dep["name"],
                "version": dep["version"],
                "probability": probability,
            }
        )

    n_deps = len(per_dep)
    probabilities = [entry["probability"] for entry in per_dep]

    if n_deps == 0:
        submission_risk = 0.0
        expected_compromised = 0.0
        mean_probability = 0.0
    else:
        submission_risk = 1.0 - _product_of_survivals(probabilities)
        expected_compromised = sum(probabilities)
        mean_probability = expected_compromised / n_deps

    # Stable sort keeps input order among equal-probability deps.
    riskiest = sorted(per_dep, key=lambda entry: entry["probability"], reverse=True)

    return {
        "per_dep": per_dep,
        "submission_risk": submission_risk,
        "expected_compromised": expected_compromised,
        "riskiest": riskiest,
        "n_deps": n_deps,
        "mean_probability": mean_probability,
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

    dep_word = "dependency" if n_deps == 1 else "dependencies"
    return (
        f"Across {n_deps} {dep_word}, the forecast puts the chance that at "
        f"least one introduces a supply-chain compromise at {risk_pct:.1f} "
        f"percent, with an expected {expected:.2f} compromised "
        f"{dep_word}.{names_clause}"
    )
