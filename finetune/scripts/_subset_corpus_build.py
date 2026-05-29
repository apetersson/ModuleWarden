#!/usr/bin/env python3
"""Build a balanced LOCAL subset of the ZeroToOne tarball corpus from the npm CDN.

The team's full corpus (6,587 artifacts, ~14.5 GB) lives on Nextcloud and is being
assembled by a parallel process. Every row of artifact-index.jsonl also carries the
public ``url`` (https://registry.npmjs.org/...), so we can pull a small, balanced,
stratified subset straight from the registry CDN: fast, no auth, and no contention
with the team's Nextcloud build.

This is a helper/driver (underscore-prefixed) - it does NOT touch the team's two
task scripts (task-36 extract-tarball-features.py, task-39 train-malware-classifier.py).
It only produces a local artifact-index.jsonl that task-36 can consume via its
``--artifact-index`` flag.

SAFETY (the vulnerable bucket is live malware):
  - Tarballs are downloaded as inert, gzip-compressed .tgz BLOBS.
  - We NEVER extractall, NEVER npm/node/npx, NEVER execute package code.
  - Validation is a gzip-magic check plus tarfile header read (getmembers), which
    only parses tar headers in-memory - no member is written to disk.
  - Per-file byte cap rejects anything oversize before it is kept.
"""
from __future__ import annotations

import argparse
import hashlib
import io
import json
import random
import tarfile
import urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

GZIP_MAGIC = b"\x1f\x8b"
DEFAULT_MAX_BYTES = 50 * 1024 * 1024  # mirror task-36 MAX_TARBALL_BYTES (50 MiB)
UA = "modulewarden-corpus-subset/1.0 (static-research; no-execution)"


def _safe_name(row: dict) -> str:
    """Stable, filesystem-safe filename for an artifact (shasum preferred)."""
    sha = str(row.get("shasum") or "").strip()
    if len(sha) >= 8 and all(c in "0123456789abcdef" for c in sha.lower()):
        return f"{sha.lower()}.tgz"
    seed = f"{row.get('package')}@{row.get('version')}|{row.get('url')}"
    return hashlib.sha256(seed.encode()).hexdigest()[:40] + ".tgz"


def _download_one(row: dict, dest_dir: Path, max_bytes: int, timeout: float) -> dict | None:
    url = row.get("url")
    if not isinstance(url, str) or not url.startswith("https://"):
        return None
    dest = dest_dir / _safe_name(row)
    try:
        req = urllib.request.Request(url, headers={"User-Agent": UA})
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            blob = resp.read(max_bytes + 1)
    except Exception:
        return None
    if len(blob) > max_bytes or len(blob) < 64:
        return None
    if blob[:2] != GZIP_MAGIC:
        return None  # almost certainly a 404 HTML body, not a tgz
    # Static header-only validation: parse tar headers in-memory, never to disk.
    try:
        with tarfile.open(fileobj=io.BytesIO(blob), mode="r:*") as tf:
            if not tf.getmembers():
                return None
    except (tarfile.TarError, OSError):
        return None
    try:
        dest.write_bytes(blob)
    except OSError:
        return None
    return {
        "schema_version": "modulewarden.raw_bundle_artifact.local_subset.v1",
        "package": row.get("package"),
        "version": row.get("version"),
        "bucket": row.get("bucket"),
        "path": str(dest.resolve()),
        "url": url,
        "shasum": row.get("shasum"),
        "advisory_ids": row.get("advisory_ids"),
        "case_ids": row.get("case_ids"),
        "bytes": len(blob),
    }


def _sample(rows: list[dict], n: int, rng: random.Random) -> list[dict]:
    if n >= len(rows):
        return list(rows)
    return rng.sample(rows, n)


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--index", type=Path, default=Path("finetune/corpus/artifact-index-full.jsonl"))
    ap.add_argument("--out-index", type=Path, default=Path("finetune/corpus/local-artifact-index.jsonl"))
    ap.add_argument("--raw-root", type=Path, default=Path("finetune/corpus/raw"))
    ap.add_argument("--n-benign", type=int, default=600)
    ap.add_argument("--n-vulnerable", type=int, default=600)
    # Over-sample vulnerable URLs to absorb yanked-malware 404s.
    ap.add_argument("--vuln-oversample", type=float, default=1.7)
    ap.add_argument("--workers", type=int, default=16)
    ap.add_argument("--max-bytes", type=int, default=DEFAULT_MAX_BYTES)
    ap.add_argument("--timeout", type=float, default=25.0)
    ap.add_argument("--seed", type=int, default=42)
    args = ap.parse_args(argv)

    rng = random.Random(args.seed)
    benign, vuln = [], []
    with args.index.open(encoding="utf-8") as fh:
        for line in fh:
            line = line.strip()
            if not line:
                continue
            try:
                r = json.loads(line)
            except json.JSONDecodeError:
                continue
            if not r.get("url"):
                continue
            b = r.get("bucket")
            if b == "benign":
                benign.append(r)
            elif b == "vulnerable":
                vuln.append(r)

    pick_b = _sample(benign, args.n_benign, rng)
    pick_v = _sample(vuln, int(args.n_vulnerable * args.vuln_oversample), rng)
    print(f"index: benign={len(benign)} vulnerable={len(vuln)}")
    print(f"attempting: benign={len(pick_b)} vulnerable={len(pick_v)} (vuln over-sampled for 404s)")

    (args.raw_root / "benign").mkdir(parents=True, exist_ok=True)
    (args.raw_root / "vulnerable").mkdir(parents=True, exist_ok=True)

    results: list[dict] = []
    targets = {"benign": args.n_benign, "vulnerable": args.n_vulnerable}
    kept = {"benign": 0, "vulnerable": 0}

    jobs = [(r, args.raw_root / "benign") for r in pick_b] + \
           [(r, args.raw_root / "vulnerable") for r in pick_v]
    with ThreadPoolExecutor(max_workers=args.workers) as ex:
        futs = {ex.submit(_download_one, r, d, args.max_bytes, args.timeout): r.get("bucket")
                for (r, d) in jobs}
        done = 0
        for fut in as_completed(futs):
            done += 1
            row = fut.result()
            if row is None:
                continue
            b = row["bucket"]
            if kept.get(b, 0) >= targets.get(b, 0):
                # already have enough of this class; drop the inert blob to save space
                try:
                    Path(row["path"]).unlink(missing_ok=True)
                except OSError:
                    pass
                continue
            kept[b] += 1
            results.append(row)
            if done % 50 == 0:
                print(f"  progress: {done}/{len(jobs)} attempted, kept b={kept['benign']} v={kept['vulnerable']}")

    args.out_index.parent.mkdir(parents=True, exist_ok=True)
    total_bytes = 0
    with args.out_index.open("w", encoding="utf-8") as out:
        for row in results:
            total_bytes += int(row.get("bytes") or 0)
            out.write(json.dumps(row) + "\n")

    print("\n=== subset built ===")
    print(f"kept: benign={kept['benign']} vulnerable={kept['vulnerable']} total={len(results)}")
    print(f"download size: {total_bytes/1024/1024:.1f} MiB")
    print(f"local index -> {args.out_index}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
