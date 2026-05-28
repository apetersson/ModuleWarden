"""Generate labeled synthetic-malicious npm packages from a benign corpus.

Walks a directory of benign npm packages, samples patterns from the attack
catalog weighted by severity, and writes synthetic variants to disk along with
a JSONL manifest the downstream dataset builder can consume.

Usage:
    python scripts/synthesize_data.py \
        --benign-corpus data/raw/benign-packages/ \
        --catalog data/patterns/attack-catalog.yaml \
        --output data/synthetic/v1/ \
        --multiplier 8 \
        --seed 42 \
        --max-workers 8
"""

from __future__ import annotations

import argparse
import hashlib
import json
import logging
import random
import shutil
import sys
import time
from concurrent.futures import ProcessPoolExecutor, as_completed
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any

# Make the project root importable so `from data.patterns.injector import ...`
# works regardless of where the script is invoked from.
_THIS_FILE = Path(__file__).resolve()
_REPO_ROOT = _THIS_FILE.parent.parent
if str(_REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(_REPO_ROOT))

from data.patterns.injector import PatternInjector  # noqa: E402

logger = logging.getLogger("synthesize_data")


@dataclass
class SynthJob:
    """A unit of work for the worker pool: one (benign, pattern, variant_idx)."""

    benign_path: str
    pattern_id: str
    variant_idx: int
    seed: int
    output_root: str
    catalog_path: str


@dataclass
class ManifestEntry:
    """One line in the output manifest.jsonl."""

    path: str
    label: int
    source: str  # "benign" | "synthetic"
    pattern_id: str | None
    source_benign: str | None
    seed: int | None
    sha256_of_dir: str


def setup_logging(verbose: bool = False) -> None:
    """Configure root logger formatting."""
    logging.basicConfig(
        level=logging.DEBUG if verbose else logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s %(message)s",
    )


def discover_benign_packages(root: Path) -> list[Path]:
    """Find npm-package-shaped directories (must contain package.json)."""
    if not root.exists():
        return []
    candidates: list[Path] = []
    for pkg_json in root.glob("**/package.json"):
        # Reject deeply nested package.json files inside node_modules of a
        # package; we only want the top-level package.json per directory.
        rel = pkg_json.relative_to(root)
        parts = rel.parts
        if "node_modules" in parts:
            continue
        candidates.append(pkg_json.parent)
    # Deduplicate (a benign package could legitimately have one package.json).
    return sorted(set(candidates))


def sample_patterns(
    injector: PatternInjector,
    multiplier: int,
    rng: random.Random,
) -> list[str]:
    """Pick `multiplier` pattern ids weighted by severity (with replacement)."""
    patterns = injector.list_patterns()
    if not patterns:
        return []
    ids = [p.id for p in patterns]
    weights = [max(1, p.severity) for p in patterns]
    return rng.choices(ids, weights=weights, k=multiplier)


def sha256_of_dir(directory: Path) -> str:
    """Stable SHA256 over the contents of a directory (sorted, file-by-file)."""
    h = hashlib.sha256()
    for path in sorted(directory.rglob("*")):
        if path.is_dir():
            continue
        rel = path.relative_to(directory).as_posix()
        h.update(rel.encode("utf-8"))
        h.update(b"\0")
        try:
            h.update(path.read_bytes())
        except OSError:
            continue
    return h.hexdigest()


def copy_package(src: Path, dst: Path) -> None:
    """Copy a benign npm package directory to a new location."""
    if dst.exists():
        shutil.rmtree(dst)
    shutil.copytree(src, dst, symlinks=False, ignore_dangling_symlinks=True)


def process_job(job_dict: dict[str, Any]) -> dict[str, Any] | None:
    """Worker function: copy benign package, inject pattern, return manifest dict.

    Lives at module top level so ProcessPoolExecutor can pickle it.
    """
    job = SynthJob(**job_dict)
    try:
        injector = PatternInjector(job.catalog_path)
    except FileNotFoundError:
        # Surfaced again in the main process; do not crash workers loudly here.
        return None

    benign_path = Path(job.benign_path)
    benign_name = benign_path.name
    out_dir = Path(job.output_root) / job.pattern_id / f"{benign_name}__v{job.variant_idx}"
    try:
        copy_package(benign_path, out_dir)
        result = injector.inject(out_dir, job.pattern_id, seed=job.seed)
        digest = sha256_of_dir(out_dir)
        entry = ManifestEntry(
            path=str(out_dir),
            label=1,
            source="synthetic",
            pattern_id=job.pattern_id,
            source_benign=str(benign_path),
            seed=job.seed,
            sha256_of_dir=digest,
        )
        return {"entry": asdict(entry), "injection": result}
    except Exception as exc:  # noqa: BLE001 - we want to log per-job failures
        logger.exception("Job failed for %s + %s: %s", benign_name, job.pattern_id, exc)
        # Clean up partial output to keep the manifest honest.
        if out_dir.exists():
            shutil.rmtree(out_dir, ignore_errors=True)
        return None


def write_manifest_lines(manifest_path: Path, entries: list[dict[str, Any]]) -> None:
    """Append-write JSONL entries to the manifest."""
    manifest_path.parent.mkdir(parents=True, exist_ok=True)
    with manifest_path.open("a", encoding="utf-8") as fh:
        for entry in entries:
            fh.write(json.dumps(entry, sort_keys=True) + "\n")


def build_jobs(
    benign_packages: list[Path],
    injector: PatternInjector,
    multiplier: int,
    output_root: Path,
    catalog_path: Path,
    base_seed: int,
) -> list[dict[str, Any]]:
    """Construct the deterministic job list for the worker pool."""
    jobs: list[dict[str, Any]] = []
    for pkg_idx, pkg in enumerate(benign_packages):
        # Per-package RNG so reordering benign list does not change overall mix.
        pkg_seed = hashlib.sha256(f"{base_seed}|{pkg.name}".encode("utf-8")).digest()
        pkg_rng = random.Random(int.from_bytes(pkg_seed[:8], "big"))
        pattern_ids = sample_patterns(injector, multiplier, pkg_rng)
        for variant_idx, pid in enumerate(pattern_ids):
            jobs.append(
                asdict(
                    SynthJob(
                        benign_path=str(pkg),
                        pattern_id=pid,
                        variant_idx=variant_idx,
                        seed=(base_seed * 1_000_003 + pkg_idx * 1009 + variant_idx),
                        output_root=str(output_root),
                        catalog_path=str(catalog_path),
                    )
                )
            )
    return jobs


def emit_benign_manifest(
    benign_packages: list[Path], manifest_path: Path
) -> int:
    """Append manifest entries for the original benign packages (label=0)."""
    entries: list[dict[str, Any]] = []
    for pkg in benign_packages:
        digest = sha256_of_dir(pkg)
        entry = ManifestEntry(
            path=str(pkg),
            label=0,
            source="benign",
            pattern_id=None,
            source_benign=None,
            seed=None,
            sha256_of_dir=digest,
        )
        entries.append(asdict(entry))
    write_manifest_lines(manifest_path, entries)
    return len(entries)


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    """Parse CLI args."""
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--benign-corpus", required=True, type=Path,
                   help="root directory of benign npm packages")
    p.add_argument("--catalog", required=True, type=Path,
                   help="path to attack-catalog.yaml")
    p.add_argument("--output", required=True, type=Path,
                   help="output root for synthetic packages and manifest")
    p.add_argument("--multiplier", type=int, default=8,
                   help="number of synthetic variants per benign package")
    p.add_argument("--seed", type=int, default=42, help="master random seed")
    p.add_argument("--max-workers", type=int, default=4,
                   help="ProcessPoolExecutor worker count")
    p.add_argument("--dry-run", action="store_true",
                   help="print what would be done and exit without writing")
    p.add_argument("--verbose", action="store_true")
    return p.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    """Entry point."""
    args = parse_args(argv)
    setup_logging(args.verbose)

    if not args.catalog.exists():
        logger.error("Attack catalog not found at %s", args.catalog)
        logger.error(
            "The catalog file is produced by the catalog-author agent; "
            "rerun this script after that step has completed."
        )
        return 2

    # Loading the catalog up-front gives us a fast, single-process error if it
    # is malformed. Workers re-load it (cheap; small file).
    try:
        injector = PatternInjector(args.catalog)
    except Exception as exc:  # noqa: BLE001
        logger.exception("Failed to load catalog: %s", exc)
        return 2

    benign_packages = discover_benign_packages(args.benign_corpus)
    if not benign_packages:
        logger.warning(
            "No benign packages found under %s; nothing to synthesize",
            args.benign_corpus,
        )
        return 0

    logger.info(
        "Discovered %d benign packages; %d patterns in catalog; multiplier=%d",
        len(benign_packages), len(injector.patterns), args.multiplier,
    )

    jobs = build_jobs(
        benign_packages=benign_packages,
        injector=injector,
        multiplier=args.multiplier,
        output_root=args.output,
        catalog_path=args.catalog,
        base_seed=args.seed,
    )
    total_jobs = len(jobs)
    logger.info("Built %d synthesis jobs", total_jobs)

    if args.dry_run:
        logger.info("DRY RUN: not writing any output.")
        for j in jobs[:10]:
            logger.info(" sample job: %s", j)
        return 0

    args.output.mkdir(parents=True, exist_ok=True)
    manifest_path = args.output / "manifest.jsonl"
    # Truncate any prior manifest so reruns with same seed are clean.
    if manifest_path.exists():
        manifest_path.unlink()

    # Step 1: emit benign manifest first (label=0 entries).
    n_benign = emit_benign_manifest(benign_packages, manifest_path)
    logger.info("Wrote %d benign manifest entries", n_benign)

    # Step 2: dispatch synthesis jobs.
    start = time.time()
    completed = 0
    success = 0
    batch: list[dict[str, Any]] = []

    workers = max(1, args.max_workers)
    if workers == 1:
        # Run inline; easier to debug.
        for job in jobs:
            res = process_job(job)
            completed += 1
            if res is not None:
                batch.append(res["entry"])
                success += 1
            if completed % 100 == 0:
                rate = completed / max(1e-6, time.time() - start)
                logger.info(
                    "Progress: %d/%d (%.1f%%) success=%d rate=%.1f ex/s",
                    completed, total_jobs, 100 * completed / total_jobs,
                    success, rate,
                )
            if len(batch) >= 100:
                write_manifest_lines(manifest_path, batch)
                batch.clear()
    else:
        with ProcessPoolExecutor(max_workers=workers) as pool:
            futures = {pool.submit(process_job, job): job for job in jobs}
            for fut in as_completed(futures):
                completed += 1
                res = fut.result()
                if res is not None:
                    batch.append(res["entry"])
                    success += 1
                if completed % 100 == 0:
                    rate = completed / max(1e-6, time.time() - start)
                    logger.info(
                        "Progress: %d/%d (%.1f%%) success=%d rate=%.1f ex/s",
                        completed, total_jobs, 100 * completed / total_jobs,
                        success, rate,
                    )
                if len(batch) >= 100:
                    write_manifest_lines(manifest_path, batch)
                    batch.clear()

    if batch:
        write_manifest_lines(manifest_path, batch)

    elapsed = time.time() - start
    logger.info(
        "Done. %d/%d synthesis jobs succeeded in %.1fs (%.1f ex/s). "
        "Manifest: %s",
        success, total_jobs, elapsed,
        completed / max(1e-6, elapsed), manifest_path,
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
