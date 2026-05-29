"""Decepticon adversarial test-case generator (offense-feeds-defense, synthetic, static).

Role 3, the loop-closer. Generates synthetic adversarial dossiers designed to slip
past the deterministic gate, scores each against the gate's known detection tiers
(coverage.py), and surfaces the ones that evade as hard negatives the defense can
train on.

SAFETY: every scenario is a synthetic DOSSIER (capability_deltas plus metadata),
never package code. Decepticon writes no working payloads, executes nothing, and
never touches the live-malware tarballs. Capabilities are drawn only from the
deterministic mapper catalog; nothing outside it is invented, including by the
model path (model output is filtered to the catalog).

Two generation modes:
  deterministic (always on, no GPU): build diverse capability combinations from
    the catalog. Scenarios that avoid the one gate_rule capability evade the hard
    gate by construction, which is the measured 11 percent coverage made concrete.
  model-enriched (when DECEPTICON_MODEL_ENDPOINT is set): ask the heretic-v2 GGUF
    for additional capability combinations, filtered to the catalog. Optional; the
    deterministic core stands alone and the tests run offline.
"""

from __future__ import annotations

import argparse
import json
import random
from pathlib import Path
from typing import Any

from . import coverage, mapper, model_client

CATALOG: list[str] = list(mapper._CAPABILITY_TO_ATTACK)
GATE_RULE_CAPS: frozenset[str] = frozenset(
    cap for cap, info in coverage._DETECTION_TIER.items() if info["tier"] == "gate_rule"
)


def score_scenario(capability_deltas: list[Any]) -> dict[str, Any]:
    """Score a scenario against the gate's detection tiers.

    detected_tier is the strongest tier any capability reaches (gate_rule >
    static_signal > blind_spot). evades_hard_gate is True when no capability is a
    deterministic gate-rule catch, i.e. the gate's one hard rule never fires.
    """
    caps = mapper._capability_keys(capability_deltas)
    tiers = {coverage._DETECTION_TIER.get(c, {}).get("tier", "blind_spot") for c in caps}
    if "gate_rule" in tiers:
        detected = "gate_rule"
    elif "static_signal" in tiers:
        detected = "static_signal"
    else:
        detected = "blind_spot"
    return {
        "detected_tier": detected,
        "evades_hard_gate": not (set(caps) & GATE_RULE_CAPS),
        "kill_chain": mapper.kill_chain_narrative(capability_deltas),
    }


def _scenario(caps: list[str], idx: int) -> dict[str, Any]:
    """A synthetic adversarial dossier (data only, no code)."""
    return {
        "package": {"name": f"synthetic-adv-{idx:03d}", "candidate_version": "1.0.0"},
        "capability_deltas": [{"capability": c} for c in caps],
        "role": "adversarial_synthetic",
        "source": "decepticon_adversary",
    }


def synthesize(n: int = 20, *, seed: int = 7, min_caps: int = 2, max_caps: int = 4) -> list[dict[str, Any]]:
    """Deterministically synthesize diverse capability-combination dossiers.

    Subsets are drawn from the full catalog, so some include the gate_rule
    capability (controls that get caught) and most do not (evasive). Deduped by
    capability set; seeded for reproducibility.
    """
    rng = random.Random(seed)
    seen: set[frozenset[str]] = set()
    out: list[dict[str, Any]] = []
    attempts = 0
    while len(out) < n and attempts < n * 40:
        attempts += 1
        k = rng.randint(min_caps, min(max_caps, len(CATALOG)))
        combo = frozenset(rng.sample(CATALOG, k))
        if combo in seen:
            continue
        seen.add(combo)
        out.append(_scenario(sorted(combo), len(out)))
    return out


def _model_enrich(n: int, *, timeout_s: float = 60.0) -> list[dict[str, Any]]:
    """Ask the GGUF for extra capability combinations, filtered to the catalog.

    Optional and fail-soft: returns [] if no endpoint is configured or the call
    fails, so the deterministic core always produces output. Never trusts the
    model to invent capabilities; anything outside CATALOG is dropped.
    """
    if not model_client.is_configured():
        return []
    system = (
        "You are Decepticon, generating adversarial test cases for DEFENSIVE "
        "testing. Propose capability combinations that a malicious npm package "
        "could use to evade a static gate. Use ONLY these capability keys: "
        + ", ".join(CATALOG)
        + ". Reply with a JSON array of arrays of capability keys, nothing else. "
        "No code, no payloads."
    )
    user = f"Propose {n} distinct capability combinations as JSON."
    try:
        text = model_client.complete(
            system_prompt=system,
            messages=[{"role": "user", "content": user}],
            timeout_s=timeout_s,
        )
        start, end = text.find("["), text.rfind("]")
        if start == -1 or end == -1:
            return []
        combos = json.loads(text[start : end + 1])
    except Exception:
        return []
    out: list[dict[str, Any]] = []
    for i, combo in enumerate(combos):
        caps = [c for c in combo if c in CATALOG] if isinstance(combo, list) else []
        if caps:
            s = _scenario(sorted(set(caps)), 900 + i)
            s["source"] = "decepticon_adversary_model"
            out.append(s)
    return out


def generate_hard_negatives(
    n: int = 20, *, seed: int = 7, use_model: bool = False
) -> dict[str, Any]:
    """Generate scenarios, score them, return the evasive ones plus an evasion rate."""
    scenarios = synthesize(n, seed=seed)
    if use_model:
        scenarios += _model_enrich(max(4, n // 4))
    scored = []
    for s in scenarios:
        verdict = score_scenario(s["capability_deltas"])
        scored.append({**s, "detection": verdict})
    hard = [s for s in scored if s["detection"]["evades_hard_gate"]]
    total = len(scored)
    return {
        "n_total": total,
        "n_hard_negatives": len(hard),
        "evasion_rate": round(len(hard) / total, 3) if total else 0.0,
        "hard_negatives": hard,
        "all_scored": scored,
    }


def to_sft_hard_negative(scenario: dict[str, Any]) -> dict[str, Any]:
    """Shape an evasive scenario as an SFT hard-negative row.

    The label is the verdict the defense SHOULD reach (block), so the auditor
    learns to catch the case even though the gate's hard rule did not fire.
    """
    chain = scenario["detection"]["kill_chain"] if "detection" in scenario else mapper.kill_chain_narrative(
        scenario.get("capability_deltas", [])
    )
    dossier = {
        "package": scenario.get("package"),
        "capability_deltas": scenario.get("capability_deltas"),
    }
    report = {
        "schema_version": "v1",
        "verdict": "block",
        "risk_level": "high",
        "summary": (
            "Adversarial synthetic case: reaches "
            f"{chain.get('chain') or 'no chain'} via "
            f"{', '.join(chain.get('technique_ids') or []) or 'no techniques'} "
            "while avoiding the install-scripts rule, so the deterministic gate's "
            "hard catch does not fire. Must be blocked on the capability chain."
        ),
        "primary_findings": [
            {
                "severity": "high",
                "category": s["tactic"],
                "claim": s["procedure"],
                "evidence_refs": [s["technique_id"]],
            }
            for s in (chain.get("steps") or [])
        ],
    }
    return {
        "split": "train",
        "meta": {"source": "decepticon_hard_negative"},
        "messages": [
            {"role": "system", "content": "You are the ModuleWarden auditor."},
            {"role": "user", "content": json.dumps(dossier, ensure_ascii=False)},
            {"role": "assistant", "content": json.dumps(report, ensure_ascii=False)},
        ],
    }


def detection_gaps_summary(result: dict[str, Any]) -> dict[str, Any]:
    """Which techniques the evasive scenarios reached, for the Decepticon wiki."""
    gaps: dict[str, int] = {}
    for s in result["hard_negatives"]:
        for tid in s["detection"]["kill_chain"].get("technique_ids", []):
            gaps[tid] = gaps.get(tid, 0) + 1
    return {
        "evasion_rate": result["evasion_rate"],
        "technique_frequency_in_evasions": dict(sorted(gaps.items(), key=lambda kv: -kv[1])),
    }


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="Decepticon adversarial test-case generator")
    ap.add_argument("-n", type=int, default=20)
    ap.add_argument("--seed", type=int, default=7)
    ap.add_argument("--use-model", action="store_true", help="enrich with the GGUF if configured")
    ap.add_argument("--out", type=Path, default=None, help="write hard-negative SFT rows here (JSONL)")
    args = ap.parse_args(argv)

    res = generate_hard_negatives(args.n, seed=args.seed, use_model=args.use_model)
    print(
        f"scenarios={res['n_total']} hard_negatives={res['n_hard_negatives']} "
        f"evasion_rate={res['evasion_rate']:.0%}"
    )
    gaps = detection_gaps_summary(res)
    print("techniques reached by evasions:", gaps["technique_frequency_in_evasions"])
    if args.out:
        args.out.parent.mkdir(parents=True, exist_ok=True)
        with args.out.open("w", encoding="utf-8") as fh:
            for s in res["hard_negatives"]:
                fh.write(json.dumps(to_sft_hard_negative(s), ensure_ascii=False) + "\n")
        print(f"wrote {res['n_hard_negatives']} hard-negative rows -> {args.out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
