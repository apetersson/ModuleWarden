"""Decepticon HPC config preflight. Run before spending GPU on Leonardo.

Verifies Decepticon is correctly configured WITHOUT needing a GPU, so it can run
on a Leonardo login node:

- all Decepticon modules import (no missing deps)
- the deterministic core runs offline and is GPU-free (no torch/vLLM pulled)
- the adversarial generator and coverage scorer produce output
- hard-negative SFT records are canonical (train split, synthetic_teacher)
- the corpus-walker hard-negatives wiring is present
- endpoint config status, and reachability if an endpoint is set

Exit 0 = ready. Exit 1 = a hard requirement failed. An unset endpoint is a WARN
(offline generation still works); an endpoint that is set but unreachable is a
FAIL, because a misconfigured endpoint would silently waste GPU time.

Usage:
    python -m finetune.python.decepticon.config_check
"""

from __future__ import annotations

import inspect
import json
import sys
import urllib.request

PASS, WARN, FAIL = "PASS", "WARN", "FAIL"


def _check_imports() -> tuple[str, str]:
    try:
        from . import adversary, coverage, mapper, model_client  # noqa: F401
        return PASS, "mapper, coverage, model_client, adversary import cleanly"
    except Exception as exc:  # noqa: BLE001
        return FAIL, f"import error: {exc.__class__.__name__}: {exc}"


def _check_gpu_free() -> tuple[str, str]:
    heavy = {"torch", "vllm", "transformers", "peft", "trl", "bitsandbytes"}
    pulled = sorted(h for h in heavy if any(k == h or k.startswith(h + ".") for k in sys.modules))
    if pulled:
        return WARN, f"heavy deps loaded into this process: {pulled} (core should be stdlib-only)"
    return PASS, "deterministic core is stdlib-only; runs on a login node with no GPU"


def _check_coverage() -> tuple[str, str]:
    try:
        from . import coverage
        s = coverage.coverage_summary()
        if s["techniques_total"] <= 0:
            return FAIL, "coverage_summary returned no techniques"
        return PASS, f"{s['techniques_total']} techniques, deterministic_coverage={s['deterministic_coverage']:.0%}"
    except Exception as exc:  # noqa: BLE001
        return FAIL, f"coverage error: {exc}"


def _check_adversary() -> tuple[str, str]:
    try:
        from . import adversary
        res = adversary.generate_hard_negatives(12, seed=7, use_model=False)
        if res["n_total"] != 12:
            return FAIL, f"expected 12 scenarios, got {res['n_total']}"
        return PASS, f"offline generation works, evasion_rate={res['evasion_rate']:.0%}"
    except Exception as exc:  # noqa: BLE001
        return FAIL, f"adversary error: {exc}"


def _check_hard_negative_records() -> tuple[str, str]:
    try:
        from . import adversary
        recs = adversary.hard_negative_records(5, seed=7)
        if not recs:
            return FAIL, "no hard-negative records produced"
        bad = [
            r["record_id"]
            for r in recs
            if r.get("split") != "train"
            or r.get("source") != "synthetic_teacher"
            or not r.get("record_id", "").startswith("sft_decepticon_hardneg_")
        ]
        if bad:
            return FAIL, f"non-canonical records: {bad[:3]}"
        return PASS, f"{len(recs)} canonical train-split hard negatives (synthetic_teacher)"
    except Exception as exc:  # noqa: BLE001
        return FAIL, f"record error: {exc}"


def _check_walker_wiring() -> tuple[str, str]:
    try:
        from ..pipeline import corpus_walker
    except Exception as exc:  # noqa: BLE001
        return WARN, f"corpus_walker import failed ({exc.__class__.__name__}); install its deps (httpx) on the HPC env"
    params = inspect.signature(corpus_walker.run_walker).parameters
    if "hard_negatives" not in params:
        return FAIL, "corpus_walker.run_walker is missing the hard_negatives parameter"
    return PASS, "corpus_walker --hard-negatives wiring present"


def _check_endpoint() -> tuple[str, str]:
    from . import model_client
    cfg = model_client.resolve_config()
    if cfg is None:
        return WARN, (
            "no Decepticon endpoint set. Offline generation works. To use the GGUF/"
            "bf16 model set DECEPTICON_MODEL_ENDPOINT_BASE_URL (see SERVE.md)"
        )
    # endpoint set: probe reachability via the OpenAI-compatible models list
    url = f"{cfg.base_url}/models"
    try:
        req = urllib.request.Request(
            url,
            headers={"Authorization": f"Bearer {cfg.api_key}"} if cfg.api_key else {},
        )
        with urllib.request.urlopen(req, timeout=8) as resp:
            ok = resp.status == 200
        if ok:
            return PASS, f"endpoint reachable: {cfg.base_url} (model={cfg.model}, source={cfg.source})"
        return FAIL, f"endpoint {cfg.base_url} returned HTTP {resp.status}"
    except Exception as exc:  # noqa: BLE001
        return FAIL, f"endpoint set ({cfg.base_url}) but unreachable: {exc.__class__.__name__}: {exc}"


CHECKS = [
    ("imports", _check_imports),
    ("gpu_free_core", _check_gpu_free),
    ("coverage_scorer", _check_coverage),
    ("adversary_offline", _check_adversary),
    ("hard_negative_records", _check_hard_negative_records),
    ("corpus_walker_wiring", _check_walker_wiring),
    ("model_endpoint", _check_endpoint),
]


def run_checks() -> dict:
    results = []
    for name, fn in CHECKS:
        try:
            status, detail = fn()
        except Exception as exc:  # noqa: BLE001
            status, detail = FAIL, f"unexpected: {exc}"
        results.append({"check": name, "status": status, "detail": detail})
    has_fail = any(r["status"] == FAIL for r in results)
    return {"ready": not has_fail, "results": results}


def main(argv: list[str] | None = None) -> int:
    report = run_checks()
    if argv and "--json" in argv:
        print(json.dumps(report, indent=2))
    else:
        print("Decepticon config preflight (Leonardo HPC):\n")
        for r in report["results"]:
            print(f"  [{r['status']:<4}] {r['check']:<22} {r['detail']}")
        print()
        print("READY" if report["ready"] else "NOT READY (a hard requirement failed)")
    return 0 if report["ready"] else 1


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
