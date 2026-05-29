#!/usr/bin/env python3
"""Download MATCHED version pairs (same package: vulnerable + first_patched).

Tests the delta thesis directly. The 0.54 floor was on cold per-version features;
the 0.98 malware number is largely a size signal between different packages. Neither
tests whether the FEATURE DELTA between two versions of the SAME package carries a
learnable vulnerability signal. This downloads both the vulnerable and the
first_patched tarball for the same cve_diff case so the paired-delta classifier
(_paired_delta_train.py) can be measured.

Static-safe: reuses _subset_corpus_build._download_one (inert blobs, never extracted,
never executed).
"""
from __future__ import annotations

import argparse
import importlib.util
import json
import random
from collections import defaultdict
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

_HERE = Path(__file__).resolve().parent
_spec = importlib.util.spec_from_file_location("_subset_corpus_build", _HERE / "_subset_corpus_build.py")
_b = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_b)  # type: ignore


def _first_case_id(r: dict) -> str | None:
    v = r.get("case_ids")
    if isinstance(v, str):
        try:
            v = json.loads(v.replace("'", '"'))
        except json.JSONDecodeError:
            v = [v]
    if v:
        return str(v[0])
    return None


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--index", type=Path, default=Path("finetune/corpus/artifact-index-full.jsonl"))
    ap.add_argument("--out-index", type=Path, default=Path("finetune/corpus/local-paired-index.jsonl"))
    ap.add_argument("--raw-root", type=Path, default=Path("finetune/corpus/raw-paired"))
    ap.add_argument("--n-cases", type=int, default=600)
    ap.add_argument("--workers", type=int, default=24)
    ap.add_argument("--seed", type=int, default=23)
    args = ap.parse_args(argv)

    cases: dict[str, dict[str, list]] = defaultdict(lambda: {"vulnerable": [], "benign": []})
    for line in args.index.open(encoding="utf-8"):
        line = line.strip()
        if not line:
            continue
        try:
            r = json.loads(line)
        except json.JSONDecodeError:
            continue
        if not r.get("url"):
            continue
        cid = _first_case_id(r)
        b = r.get("bucket")
        if cid and b in ("vulnerable", "benign"):
            cases[cid][b].append(r)

    both = [(cid, d) for cid, d in cases.items() if d["vulnerable"] and d["benign"]]
    print(f"cases with both vulnerable+benign artifacts: {len(both)}")
    rng = random.Random(args.seed)
    rng.shuffle(both)
    both = both[: args.n_cases]

    (args.raw_root / "benign").mkdir(parents=True, exist_ok=True)
    (args.raw_root / "vulnerable").mkdir(parents=True, exist_ok=True)
    jobs = []
    for cid, d in both:
        jobs.append((d["vulnerable"][0], args.raw_root / "vulnerable"))
        jobs.append((d["benign"][0], args.raw_root / "benign"))

    rows_by_case: dict[str, dict] = defaultdict(dict)
    with ThreadPoolExecutor(max_workers=args.workers) as ex:
        fut2cid = {}
        for (r, dest) in jobs:
            f = ex.submit(_b._download_one, r, dest, _b.DEFAULT_MAX_BYTES, 25.0)
            fut2cid[f] = _first_case_id(r)
        done = 0
        for f in as_completed(fut2cid):
            done += 1
            row = f.result()
            if row:
                rows_by_case[fut2cid[f]][row["bucket"]] = row
            if done % 100 == 0:
                complete = sum(1 for d in rows_by_case.values() if "vulnerable" in d and "benign" in d)
                print(f"  {done}/{len(jobs)} attempted, complete pairs={complete}")

    complete = {cid: d for cid, d in rows_by_case.items() if "vulnerable" in d and "benign" in d}
    args.out_index.parent.mkdir(parents=True, exist_ok=True)
    n = 0
    with args.out_index.open("w", encoding="utf-8") as out:
        for cid, d in complete.items():
            for b in ("vulnerable", "benign"):
                out.write(json.dumps(d[b]) + "\n")
                n += 1
    print(f"\n=== paired corpus built ===")
    print(f"complete matched pairs: {len(complete)} ({n} artifacts)")
    print(f"local index -> {args.out_index}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
