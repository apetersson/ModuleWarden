#!/usr/bin/env python3
"""Flatten task-36 features, train via task-39, and add a calibration/rigor layer.

WHY THIS EXISTS (two jobs):

1. FLATTEN FIX. task-39's vectorizer coerces any dict value to its len(), so
   task-36's ``capability_signals`` (8 booleans: network/obfuscation/dynamic_code/
   exec/...) collapses to the constant 8, and ``package_json_summary`` to the
   constant 3. The single most predictive static signals never reach the model.
   This driver lifts those nested booleans/counts to scalar columns (cap_*, pj_*)
   so the model actually sees them, and DROPS provenance fields (advisory_ids /
   case_ids) that are present on BOTH buckets (benign = the patched version of the
   same advisory) and would be a methodology smell.

2. RIGOR LAYER (forecasting-track requirement). task-39 reports AUROC only.
   A probabilistic-forecasting entry must show calibration, not just ranking.
   This adds: PR-AUC (honest under class imbalance), Brier score, 10-bin
   reliability diagram + ECE, FPR/precision/recall at operating points, and a
   MEASURED marginal split-conformal coverage check. No fabricated numbers - every
   figure is computed on a held-out split.

It reuses task-39's vectorize_features / extract_label / _select_estimator (the
unit-tested parts) rather than reimplementing them. It never opens a tarball.
"""
from __future__ import annotations

import argparse
import importlib.util
import json
import math
from pathlib import Path
from typing import Any

REPO_ROOT = Path(__file__).resolve().parents[2]
DEFAULT_FEATURES = REPO_ROOT / "finetune" / "corpus" / "tarball-features.jsonl"
DEFAULT_OUT_DIR = REPO_ROOT / "finetune" / "python" / "eval"
TASK39_PATH = REPO_ROOT / "finetune" / "scripts" / "train-malware-classifier.py"


def _load_task39():
    spec = importlib.util.spec_from_file_location("mw_task39", TASK39_PATH)
    mod = importlib.util.module_from_spec(spec)
    assert spec and spec.loader
    spec.loader.exec_module(mod)
    return mod


def flatten_row(row: dict[str, Any]) -> dict[str, Any]:
    """Lift task-36 nested dicts to scalar feature columns; drop provenance."""
    flat: dict[str, Any] = {"bucket": row.get("bucket")}  # label, ignored by vectorizer
    for k in ("file_count", "rejected_members", "entropy", "has_install_script"):
        if k in row:
            flat[k] = row[k]
    caps = row.get("capability_signals")
    if isinstance(caps, dict):
        for ck, cv in caps.items():
            flat[f"cap_{ck}"] = 1 if cv else 0
    pj = row.get("package_json_summary")
    if isinstance(pj, dict):
        for pk, pv in pj.items():
            flat[f"pj_{pk}"] = pv
    lh = row.get("lifecycle_hooks_present")
    flat["lifecycle_hook_count"] = len(lh) if isinstance(lh, (list, tuple)) else 0
    cd = row.get("capability_deltas")
    flat["capability_delta_count"] = len(cd) if isinstance(cd, (list, tuple)) else 0
    return flat


def _brier(y: list[int], p: list[float]) -> float:
    return sum((pi - yi) ** 2 for pi, yi in zip(p, y)) / len(y)


def _reliability(y: list[int], p: list[float], bins: int = 10):
    """Return (table rows, ECE). Each row: (lo, hi, count, mean_pred, frac_pos)."""
    rows = []
    ece = 0.0
    n = len(y)
    for b in range(bins):
        lo, hi = b / bins, (b + 1) / bins
        idx = [i for i, pi in enumerate(p) if (pi >= lo and (pi < hi or (b == bins - 1 and pi <= hi)))]
        if not idx:
            rows.append((lo, hi, 0, 0.0, 0.0))
            continue
        mp = sum(p[i] for i in idx) / len(idx)
        fp = sum(y[i] for i in idx) / len(idx)
        rows.append((lo, hi, len(idx), mp, fp))
        ece += (len(idx) / n) * abs(fp - mp)
    return rows, ece


def _metrics_at(y: list[int], p: list[float], thr: float) -> dict[str, float]:
    tp = sum(1 for yi, pi in zip(y, p) if pi >= thr and yi == 1)
    fp = sum(1 for yi, pi in zip(y, p) if pi >= thr and yi == 0)
    fn = sum(1 for yi, pi in zip(y, p) if pi < thr and yi == 1)
    tn = sum(1 for yi, pi in zip(y, p) if pi < thr and yi == 0)
    prec = tp / (tp + fp) if (tp + fp) else 0.0
    rec = tp / (tp + fn) if (tp + fn) else 0.0
    fpr = fp / (fp + tn) if (fp + tn) else 0.0
    return {"threshold": thr, "tp": tp, "fp": fp, "fn": fn, "tn": tn,
            "precision": prec, "recall": rec, "fpr": fpr}


def _conformal(y_cal, p_cal, y_test, p_test, alpha: float = 0.10):
    """Marginal split-conformal on binary scores. Returns coverage + avg set size."""
    # nonconformity = 1 - P(model assigns to the TRUE label)
    def pmodel(p, label):
        return p if label == 1 else (1.0 - p)
    cal_scores = sorted(1.0 - pmodel(pi, yi) for pi, yi in zip(p_cal, y_cal))
    n = len(cal_scores)
    if n == 0:
        return None
    # conformal quantile with finite-sample correction
    k = math.ceil((n + 1) * (1 - alpha))
    k = min(max(k, 1), n)
    q_hat = cal_scores[k - 1]
    covered = 0
    set_sizes = 0
    for pi, yi in zip(p_test, y_test):
        pred_set = [lab for lab in (0, 1) if (1.0 - pmodel(pi, lab)) <= q_hat]
        set_sizes += len(pred_set)
        if yi in pred_set:
            covered += 1
    return {"alpha": alpha, "target_coverage": 1 - alpha,
            "empirical_coverage": covered / len(y_test),
            "avg_set_size": set_sizes / len(y_test), "q_hat": q_hat, "n_cal": n}


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--features", type=Path, default=DEFAULT_FEATURES)
    ap.add_argument("--out-dir", type=Path, default=DEFAULT_OUT_DIR)
    ap.add_argument("--seed", type=int, default=42)
    ap.add_argument("--test-size", type=float, default=0.2)
    ap.add_argument("--calib-size", type=float, default=0.2)
    args = ap.parse_args(argv)

    from sklearn.metrics import roc_auc_score, average_precision_score
    from sklearn.model_selection import train_test_split

    t39 = _load_task39()

    raw_rows = []
    with args.features.open(encoding="utf-8") as fh:
        for line in fh:
            line = line.strip()
            if line:
                raw_rows.append(json.loads(line))
    flat = [flatten_row(r) for r in raw_rows]
    labels = [t39.extract_label(r) for r in flat]
    keep = [(f, y) for f, y in zip(flat, labels) if y is not None]
    flat = [f for f, _ in keep]
    labels = [y for _, y in keep]
    if len(set(labels)) < 2:
        print(f"need both classes; got {sorted(set(labels))}")
        return 2

    matrix, feature_index = t39.vectorize_features(flat)
    # drop constant columns (no signal) for an honest feature count
    nonconst = [j for j in range(len(feature_index))
                if len({matrix[i][j] for i in range(len(matrix))}) > 1]
    feature_index = [feature_index[j] for j in nonconst]
    matrix = [[row[j] for j in nonconst] for row in matrix]

    # train / calib / test (stratified)
    x_tr, x_tmp, y_tr, y_tmp = train_test_split(
        matrix, labels, test_size=args.test_size + args.calib_size,
        random_state=args.seed, stratify=labels)
    rel_test = args.test_size / (args.test_size + args.calib_size)
    x_cal, x_te, y_cal, y_te = train_test_split(
        x_tmp, y_tmp, test_size=rel_test, random_state=args.seed, stratify=y_tmp)

    est, backend = t39._select_estimator(args.seed)
    est.fit(x_tr, y_tr)
    p_te = [pp[1] for pp in est.predict_proba(x_te)]
    p_cal = [pp[1] for pp in est.predict_proba(x_cal)]

    auroc = float(roc_auc_score(y_te, p_te))
    prauc = float(average_precision_score(y_te, p_te))
    brier = _brier(y_te, p_te)
    rel_rows, ece = _reliability(y_te, p_te)
    op_05 = _metrics_at(y_te, p_te, 0.5)
    # high-precision operating point: smallest thr giving precision >= 0.95
    hp = None
    for thr in [i / 100 for i in range(50, 100)]:
        m = _metrics_at(y_te, p_te, thr)
        if m["precision"] >= 0.95 and m["tp"] > 0:
            hp = m
            break
    conf = _conformal(y_cal, p_cal, y_te, p_te, alpha=0.10)

    # feature importances if available
    importances = []
    if hasattr(est, "feature_importances_"):
        importances = sorted(zip(feature_index, [float(x) for x in est.feature_importances_]),
                             key=lambda kv: kv[1], reverse=True)

    args.out_dir.mkdir(parents=True, exist_ok=True)
    metrics = {
        "backend": backend, "n_total": len(labels),
        "n_train": len(y_tr), "n_calib": len(y_cal), "n_test": len(y_te),
        "n_benign": labels.count(0), "n_malicious": labels.count(1),
        "n_features": len(feature_index), "features": feature_index,
        "auroc": auroc, "pr_auc": prauc, "brier": brier, "ece": ece,
        "op_threshold_0.5": op_05, "op_high_precision": hp,
        "conformal_90": conf,
        "top_features": importances[:12],
    }
    (args.out_dir / "classifier-floor-metrics.json").write_text(
        json.dumps(metrics, indent=2), encoding="utf-8")

    # reliability PNG (best-effort)
    png_note = "matplotlib not available - skipped PNG (numbers below are authoritative)"
    try:
        import matplotlib
        matplotlib.use("Agg")
        import matplotlib.pyplot as plt
        xs = [r[3] for r in rel_rows if r[2] > 0]
        ys = [r[4] for r in rel_rows if r[2] > 0]
        fig, ax = plt.subplots(figsize=(5, 5))
        ax.plot([0, 1], [0, 1], "--", color="gray", label="perfect calibration")
        ax.plot(xs, ys, "o-", color="#10b981", label="ModuleWarden classifier")
        ax.set_xlabel("mean predicted P(malicious)")
        ax.set_ylabel("observed fraction malicious")
        ax.set_title(f"Reliability diagram (ECE={ece:.3f}, Brier={brier:.3f})")
        ax.legend(loc="upper left")
        fig.tight_layout()
        fig.savefig(args.out_dir / "reliability-diagram.png", dpi=130)
        png_note = f"reliability-diagram.png written ({args.out_dir/'reliability-diagram.png'})"
    except Exception as exc:  # noqa: BLE001
        png_note = f"matplotlib PNG skipped: {exc}"

    # markdown report
    lines = []
    lines.append("# ModuleWarden classifier floor - measured metrics\n")
    lines.append(f"Backend: `{backend}`  |  features: {len(feature_index)}  |  "
                 f"benign={labels.count(0)} malicious={labels.count(1)}  |  "
                 f"train/calib/test = {len(y_tr)}/{len(y_cal)}/{len(y_te)}\n")
    lines.append("## Ranking + calibration (held-out test)\n")
    lines.append(f"- AUROC: **{auroc:.4f}**")
    lines.append(f"- PR-AUC (avg precision): **{prauc:.4f}**  (honest under imbalance)")
    lines.append(f"- Brier score: **{brier:.4f}**  (lower is better)")
    lines.append(f"- ECE (10-bin): **{ece:.4f}**\n")
    if hp:
        lines.append(f"- High-precision op point thr={hp['threshold']:.2f}: "
                     f"precision={hp['precision']:.3f} recall={hp['recall']:.3f} FPR={hp['fpr']:.3f}")
    lines.append(f"- Default thr=0.50: precision={op_05['precision']:.3f} "
                 f"recall={op_05['recall']:.3f} FPR={op_05['fpr']:.3f}\n")
    if conf:
        lines.append("## Split-conformal (marginal, alpha=0.10)\n")
        lines.append(f"- target coverage {conf['target_coverage']:.2f}, "
                     f"**measured coverage {conf['empirical_coverage']:.3f}**, "
                     f"avg set size {conf['avg_set_size']:.2f} (n_cal={conf['n_cal']})\n")
    lines.append("## Reliability bins (mean predicted vs observed)\n")
    lines.append("| bin | n | mean P | obs frac |")
    lines.append("|----|---|--------|----------|")
    for lo, hi, c, mp, fp in rel_rows:
        if c:
            lines.append(f"| {lo:.1f}-{hi:.1f} | {c} | {mp:.3f} | {fp:.3f} |")
    if importances:
        lines.append("\n## Top static features by importance\n")
        for name, imp in importances[:12]:
            lines.append(f"- `{name}`: {imp:.4f}")
    lines.append(f"\n_{png_note}_\n")
    (args.out_dir / "classifier-floor-report.md").write_text("\n".join(lines), encoding="utf-8")

    print(f"backend={backend} features={len(feature_index)} "
          f"benign={labels.count(0)} malicious={labels.count(1)} "
          f"train/calib/test={len(y_tr)}/{len(y_cal)}/{len(y_te)}")
    print(f"AUROC={auroc:.4f}  PR-AUC={prauc:.4f}  Brier={brier:.4f}  ECE={ece:.4f}")
    if hp:
        print(f"high-precision thr={hp['threshold']:.2f}: P={hp['precision']:.3f} "
              f"R={hp['recall']:.3f} FPR={hp['fpr']:.3f}")
    if conf:
        print(f"conformal@90: measured coverage={conf['empirical_coverage']:.3f} "
              f"avg_set={conf['avg_set_size']:.2f}")
    print(png_note)
    print(f"wrote -> {args.out_dir/'classifier-floor-metrics.json'} and classifier-floor-report.md")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
