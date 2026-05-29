"""Decepticon detection-coverage scorer (offense-feeds-defense, static, GPU-free).

Decepticon's first step beyond narration. For every ATT&CK technique in the
deterministic mapper catalog, classify how well ModuleWarden's STATIC defense
surfaces it, producing a measured coverage matrix:

  gate_rule     a deterministic gate rule catches it (strong, auditable)
  static_signal observable in the static scan but weak alone (evadable, or common
                in benign packages, so not a detection by itself)
  blind_spot    the static JS scan cannot see it; needs the runtime or the
                code-change embedding layer (task-18)

No execution, no model. Pure reasoning over the mapper catalog and the gate's
known static-signal set. Honest by construction: the tiers reflect what a static
scan can and cannot see, grounded in the measured corpus (network_access is
present in 99.8 percent of benign packages, so it is a weak signal, not a
detection). This is what makes the "we measured our detection coverage against an
adversary" claim true rather than asserted.
"""

from __future__ import annotations

from typing import Any

from . import mapper

# Detection tier per capability the mapper knows about. Kept in sync with the
# mapper at runtime: coverage_matrix iterates the mapper catalog, and the test
# asserts every catalogued capability has a tier here.
_DETECTION_TIER: dict[str, dict[str, str]] = {
    "lifecycle_script": {
        "tier": "gate_rule",
        "detected_by": "install-scripts gate rule",
        "rationale": "A new install or lifecycle hook is caught deterministically by the install-scripts rule.",
    },
    "obfuscation": {
        "tier": "static_signal",
        "detected_by": "entropy + obfuscation heuristic",
        "rationale": "High entropy flags it, but obfuscation is evadable and some benign minified code scores high.",
    },
    "credential_or_env_access": {
        "tier": "static_signal",
        "detected_by": "static read-pattern scan",
        "rationale": "Env and credential reads are visible in source, but many legitimate packages also read env.",
    },
    "filesystem_sensitive_access": {
        "tier": "static_signal",
        "detected_by": "static read-pattern scan",
        "rationale": "Sensitive file reads are visible statically but are not malicious on their own.",
    },
    "process_execution": {
        "tier": "static_signal",
        "detected_by": "child_process / exec scan",
        "rationale": "Spawn and exec calls are visible in source but are common in build tooling.",
    },
    "network_access": {
        "tier": "static_signal",
        "detected_by": "outbound-call scan",
        "rationale": "Present in 99.8 percent of benign packages in the corpus, so a weak signal alone, not a detection.",
    },
    "native_or_wasm": {
        "tier": "blind_spot",
        "detected_by": "none (static JS only)",
        "rationale": "Compiled native addon or WASM; the static JS scan cannot read the executed code.",
    },
    "dynamic_code_execution": {
        "tier": "blind_spot",
        "detected_by": "none (payload assembled at runtime)",
        "rationale": "eval or Function on runtime-assembled strings; the payload is not in the published source.",
    },
    "behavioral_change_runtime": {
        "tier": "blind_spot",
        "detected_by": "version-delta + embedding (task-18)",
        "rationale": "Runtime divergence from the prior release; needs the code-change embedding, not a static flag.",
    },
}

_TIER_ORDER = {"gate_rule": 0, "static_signal": 1, "blind_spot": 2}
VALID_TIERS = frozenset(_TIER_ORDER)


def coverage_matrix() -> list[dict[str, Any]]:
    """One row per ATT&CK technique in the mapper, tagged with its detection tier."""
    rows: list[dict[str, Any]] = []
    for cap, atk in mapper._CAPABILITY_TO_ATTACK.items():
        tier = _DETECTION_TIER.get(
            cap,
            {"tier": "blind_spot", "detected_by": "none", "rationale": "uncatalogued capability"},
        )
        rows.append(
            {
                "capability": cap,
                "technique_id": atk["technique_id"],
                "technique_name": atk["technique_name"],
                "tactic": atk["tactic"],
                "detection_tier": tier["tier"],
                "detected_by": tier["detected_by"],
                "rationale": tier["rationale"],
            }
        )
    rows.sort(key=lambda r: (_TIER_ORDER.get(r["detection_tier"], 3), r["technique_id"]))
    return rows


def coverage_summary() -> dict[str, Any]:
    """Aggregate counts and the deterministic-coverage fraction."""
    rows = coverage_matrix()
    by_tier: dict[str, int] = {}
    for r in rows:
        by_tier[r["detection_tier"]] = by_tier.get(r["detection_tier"], 0) + 1
    total = len(rows)
    hard = by_tier.get("gate_rule", 0)
    return {
        "techniques_total": total,
        "by_tier": by_tier,
        "deterministic_coverage": round(hard / total, 3) if total else 0.0,
        # keyed by capability, not technique_id: a technique can be reachable via
        # both a visible and a blind capability (e.g. T1059 via process_execution
        # is a static_signal but via behavioral_change_runtime is a blind spot).
        "blind_spots": [
            f"{r['capability']} ({r['technique_id']})"
            for r in rows
            if r["detection_tier"] == "blind_spot"
        ],
        "note": (
            "Only gate_rule is a hard detection. static_signal is observable but "
            "weak alone. blind_spot techniques are what justify the code-change "
            "embedding layer (task-18)."
        ),
    }


def render_markdown() -> str:
    """A coverage table for the demo deck and the blue-team writeup."""
    s = coverage_summary()
    lines = [
        "# Decepticon detection-coverage matrix",
        "",
        f"Techniques scored: {s['techniques_total']}. "
        f"Deterministic (gate_rule) coverage: {s['deterministic_coverage']:.0%}. "
        f"Blind spots: {', '.join(s['blind_spots']) or 'none'}.",
        "",
        "| tier | technique | tactic | detected by | why |",
        "|------|-----------|--------|-------------|-----|",
    ]
    for r in coverage_matrix():
        lines.append(
            f"| {r['detection_tier']} | {r['technique_id']} {r['technique_name']} "
            f"| {r['tactic']} | {r['detected_by']} | {r['rationale']} |"
        )
    return "\n".join(lines)


def main(argv: list[str] | None = None) -> int:
    s = coverage_summary()
    print(
        f"techniques={s['techniques_total']} "
        f"deterministic_coverage={s['deterministic_coverage']:.0%} "
        f"by_tier={s['by_tier']}"
    )
    print("blind spots:", ", ".join(s["blind_spots"]) or "none")
    for r in coverage_matrix():
        print(f"  [{r['detection_tier']:<13}] {r['technique_id']:<10} {r['capability']}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
