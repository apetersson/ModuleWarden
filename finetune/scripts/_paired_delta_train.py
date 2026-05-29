#!/usr/bin/env python3
"""Paired-delta measurement: does the feature DELTA between two versions of the
SAME package carry a learnable vulnerability signal?

For each cve_diff case we have features for the vulnerable AND the first_patched
version of the same package. We build ONE siamese sample per case: a random ordering
(A, B) and delta = features(A) - features(B), labeled 1 if A is the vulnerable one.
A classifier on these deltas answers the thesis directly:

  AUROC >> 0.5  -> the delta is learnable: a real probabilistic layer is possible.
  AUROC ~ 0.5   -> the delta is not learnable from static features: the
                   deterministic gate is honestly the whole forecast (and the
                   embedding layer / task-18 is the only remaining lever).

Split is BY CASE (one sample per case) so there is no pair leakage. A cold-feature
baseline on the same packages is reported for contrast.

Never opens a tarball; reads only task-36's feature JSONL.
"""
from __future__ import annotations

import argparse
import importlib.util
import json
import random
from collections import defaultdict
from pathlib import Path

_HERE = Path(__file__).resolve().parent


def _load(name, fn):
    spec = importlib.util.spec_from_file_location(name, _HERE / fn)
    m = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(m)  # type: ignore
    return m


def _first_case_id(r: dict):
    v = r.get("case_ids")
    if isinstance(v, str):
        try:
            v = json.loads(v.replace("'", '"'))
        except json.JSONDecodeError:
            v = [v]
    return str(v[0]) if v else None


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--features", type=Path, default=Path("finetune/corpus/tarball-features-paired.jsonl"))
    ap.add_argument("--out-dir", type=Path, default=Path("finetune/python/eval/paired-delta"))
    ap.add_argument("--seed", type=int, default=42)
    args = ap.parse_args(argv)

    from sklearn.metrics import roc_auc_score, average_precision_score
    from sklearn.model_selection import train_test_split

    fc = _load("mw_flat_cal", "_flatten_and_calibrate.py")
    t39 = fc._load_task39()
    flatten_row = fc.flatten_row

    by_case = defaultdict(dict)
    for line in args.features.open(encoding="utf-8"):
        line = line.strip()
        if not line:
            continue
        r = json.loads(line)
        cid = _first_case_id(r)
        if cid and r.get("bucket") in ("vulnerable", "benign"):
            by_case[cid][r["bucket"]] = flatten_row(r)
    pairs = {c: d for c, d in by_case.items() if "vulnerable" in d and "benign" in d}
    print(f"complete matched pairs: {len(pairs)}")
    if len(pairs) < 30:
        print("too few pairs to measure; need more matched downloads")
        return 2

    # feature keys = numeric keys present on the flattened rows, excluding label
    feat_keys = set()
    for d in pairs.values():
        for row in d.values():
            for k, v in row.items():
                if k == "bucket":
                    continue
                if t39._coerce_numeric(v) is not None:
                    feat_keys.add(k)
    feat_keys = sorted(feat_keys)

    rng = random.Random(args.seed)

    def num(row, k):
        v = t39._coerce_numeric(row.get(k))
        return v if v is not None else 0.0

    # paired-delta samples (one per case, random order, split by case)
    delta_X, delta_y = [], []
    # cold-feature baseline samples (each version is its own row)
    cold_X, cold_y = [], []
    for cid, d in pairs.items():
        v, b = d["vulnerable"], d["benign"]
        if rng.random() < 0.5:
            A, B, label = v, b, 1
        else:
            A, B, label = b, v, 0
        delta_X.append([num(A, k) - num(B, k) for k in feat_keys])
        delta_y.append(label)
        cold_X.append([num(v, k) for k in feat_keys]); cold_y.append(1)
        cold_X.append([num(b, k) for k in feat_keys]); cold_y.append(0)

    def evaluate(X, y, tag):
        # drop constant columns
        nz = [j for j in range(len(feat_keys)) if len({row[j] for row in X}) > 1]
        Xr = [[row[j] for j in nz] for row in X]
        names = [feat_keys[j] for j in nz]
        xtr, xtmp, ytr, ytmp = train_test_split(Xr, y, test_size=0.4, random_state=args.seed, stratify=y)
        xcal, xte, ycal, yte = train_test_split(xtmp, ytmp, test_size=0.5, random_state=args.seed, stratify=ytmp)
        est, backend = t39._select_estimator(args.seed)
        est.fit(xtr, ytr)
        pte = [p[1] for p in est.predict_proba(xte)]
        pcal = [p[1] for p in est.predict_proba(xcal)]
        auroc = float(roc_auc_score(yte, pte))
        prauc = float(average_precision_score(yte, pte))
        brier = fc._brier(yte, pte)
        _, ece = fc._reliability(yte, pte)
        conf = fc._conformal(ycal, pcal, yte, pte, alpha=0.10)
        imps = []
        if hasattr(est, "feature_importances_"):
            imps = sorted(zip(names, [float(x) for x in est.feature_importances_]), key=lambda kv: kv[1], reverse=True)[:8]
        return {"tag": tag, "backend": backend, "n": len(y), "n_test": len(yte),
                "auroc": auroc, "pr_auc": prauc, "brier": brier, "ece": ece,
                "conformal_90": conf, "top_features": imps}

    delta_res = evaluate(delta_X, delta_y, "paired_delta")
    cold_res = evaluate(cold_X, cold_y, "cold_baseline_same_packages")

    args.out_dir.mkdir(parents=True, exist_ok=True)
    out = {"n_pairs": len(pairs), "paired_delta": delta_res, "cold_baseline": cold_res}
    (args.out_dir / "paired-delta-metrics.json").write_text(json.dumps(out, indent=2), encoding="utf-8")

    def show(r):
        print(f"[{r['tag']}] AUROC={r['auroc']:.4f} PR-AUC={r['pr_auc']:.4f} "
              f"Brier={r['brier']:.4f} ECE={r['ece']:.4f} n={r['n']} test={r['n_test']}")
        if r["conformal_90"]:
            print(f"   conformal@90 coverage={r['conformal_90']['empirical_coverage']:.3f}")
        print("   top:", ", ".join(f"{n}={i:.3f}" for n, i in r["top_features"][:5]))

    print(f"\nmatched pairs: {len(pairs)}")
    show(delta_res)
    show(cold_res)
    verdict = ("LEARNABLE: the static delta carries vulnerability signal"
               if delta_res["auroc"] >= 0.65 else
               ("WEAK: marginal delta signal" if delta_res["auroc"] >= 0.58 else
                "NOT LEARNABLE from static delta: the deterministic gate is the forecast; embeddings (task-18) are the only remaining lever"))
    print("\nVERDICT:", verdict)
    (args.out_dir / "paired-delta-report.md").write_text(
        f"# Paired-delta measurement\n\nMatched pairs: {len(pairs)}\n\n"
        f"- paired-delta AUROC: **{delta_res['auroc']:.4f}** (PR-AUC {delta_res['pr_auc']:.4f}, "
        f"Brier {delta_res['brier']:.4f}, ECE {delta_res['ece']:.4f})\n"
        f"- cold-feature baseline (same packages): AUROC {cold_res['auroc']:.4f}\n\n"
        f"Top delta features: " + ", ".join(f"`{n}` {i:.3f}" for n, i in delta_res['top_features'][:6]) + "\n\n"
        f"**Verdict:** {verdict}\n", encoding="utf-8")
    print(f"\nwrote -> {args.out_dir}/paired-delta-metrics.json and paired-delta-report.md")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
