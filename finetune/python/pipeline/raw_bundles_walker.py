"""Walk raw-bundles dataset -> sft-records-diagnosis.jsonl.

Reads ``cases-index.jsonl`` and ``artifact-index.jsonl`` from the
Nextcloud raw-bundles directory, finds vulnerable/benign tarball paths
that are already on local disk, extracts and diffs them, builds
``audit_dossier.v1`` + ``diagnosis.v1`` pairs, and writes
``modulewarden.sft_record.v1`` JSONL.

Unlike ``corpus_walker.py``, this module does NOT fetch anything from
npm. The tarballs were pre-downloaded by the overnight scraper and
are already on disk. This is the local-to-remote bridge for TASK-50.

Usage:
    python -m finetune.python.pipeline.raw_bundles_walker \\
        --cases-index /path/to/raw-bundles/cases-index.jsonl \\
        --artifact-index /path/to/raw-bundles/artifact-index.jsonl \\
        --output /path/to/sft-records-diagnosis.jsonl \\
        --max-cases 200 --concurrency 4
"""

from __future__ import annotations

import argparse
import concurrent.futures
import hashlib
import json
import logging
import sys
import tempfile
import time
from collections import Counter
from pathlib import Path
from typing import Any, Mapping

from .version_pair_extractor import (
    _diff_trees,
    _npm_root,
    _package_json_changes,
    _safe_tar_extract,
)
from .dossier_builder import build_dossier, _stable_audit_id
from .report_template import build_diagnosis
from .sft_pair_builder import build_sft_record_diagnosis

logger = logging.getLogger("modulewarden.raw_bundles_walker")


def _read_jsonl(path: Path, max_cases: int | None) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    with path.open("r", encoding="utf-8") as fh:
        for line in fh:
            stripped = line.strip()
            if not stripped:
                continue
            try:
                rec = json.loads(stripped)
            except json.JSONDecodeError as exc:
                logger.warning("skipping malformed JSONL line: %s", exc)
                continue
            if not isinstance(rec, dict):
                continue
            out.append(rec)
            if max_cases is not None and len(out) >= max_cases:
                break
    return out


def _build_artifact_map(artifact_index: list[dict[str, Any]]) -> dict[tuple[str, str], dict[str, Any]]:
    """Build a lookup: (package, version) -> artifact record."""
    out: dict[tuple[str, str], dict[str, Any]] = {}
    for art in artifact_index:
        pkg = art.get("package")
        ver = art.get("version")
        if isinstance(pkg, str) and isinstance(ver, str):
            out[(pkg, ver)] = art
    return out


def _split_for_package(package: str, *, train: float = 0.70, validation: float = 0.15) -> str:
    """Deterministic 70/15/15 split by package name hash."""
    h = hashlib.sha256(package.encode("utf-8")).digest()
    bucket = int.from_bytes(h[:4], "big") / 0xFFFFFFFF
    if bucket < train:
        return "train"
    if bucket < train + validation:
        return "validation"
    return "test"


_CASE_TYPE_TO_SOURCE: dict[str, str] = {
    "incident_replay": "incident_replay",
    "cve_diff": "cve_diff",
}


def _diff_tarballs(
    vulnerable_tgz: Path,
    benign_tgz: Path,
    work_dir: Path,
) -> tuple[list[FileChange], dict[str, Any], str]:
    """Extract and diff two tarballs using native `tar` for speed.
    
    Returns (file_changes, pkg_json_changes, method).
    Skips tarballs > 30 MB (mostly binary assets, no useful diff signal).
    """
    import subprocess
    
    # Skip large tarballs - they're primarily binary assets or vendored deps
    MAX_TGZ = 30 * 1024 * 1024
    for label, tgz in [("vulnerable", vulnerable_tgz), ("benign", benign_tgz)]:
        try:
            size = tgz.stat().st_size
        except OSError:
            return [], {}, f"skipped_stat_fail:{label}"
        if size > MAX_TGZ:
            return [], {}, f"skipped_oversize:{label}_{size}"

    unpatched_dir = work_dir / "unpatched"
    patched_dir = work_dir / "patched"
    unpatched_dir.mkdir(parents=True, exist_ok=True)
    patched_dir.mkdir(parents=True, exist_ok=True)

    # Use native tar for speed (Python's tarfile is ~3-5x slower)
    for tgz, dest, label in [(vulnerable_tgz, unpatched_dir, "vuln"), (benign_tgz, patched_dir, "benign")]:
        try:
            subprocess.run(
                ["tar", "xzf", str(tgz), "-C", str(dest)],
                check=True, capture_output=True, timeout=30,
            )
        except (subprocess.CalledProcessError, subprocess.TimeoutExpired, FileNotFoundError) as exc:
            # Fall back to Python tarfile if native tar fails
            try:
                n = _safe_tar_extract(tgz, dest)
                if n == 0:
                    raise RuntimeError("empty extract")
            except Exception as exc2:
                return [], {}, f"skipped_tar_extract:{label}"

    unpatched_root = _npm_root(unpatched_dir)
    patched_root = _npm_root(patched_dir)

    changes = _diff_trees(unpatched_root, patched_root)
    pkg_changes = _package_json_changes(unpatched_root, patched_root)

    return changes, pkg_changes, "local_tarball_diff"


def _process_one(
    case: Mapping[str, Any],
    artifact_map: dict[tuple[str, str], dict[str, Any]],
) -> tuple[dict[str, Any], dict[str, Any] | None, str | None]:
    """Process one case from cases-index.jsonl. Returns (meta, sft_record, skip_reason).
    
    Each call creates its own temporary directory for tarball extraction so
    that concurrent workers never share extraction paths."""
    case_id = str(case.get("case_id") or "unknown")
    package = str(case.get("package") or "")
    case_type = str(case.get("case_type") or "")
    meta = {
        "case_id": case_id,
        "package": package,
        "case_type": case_type,
        "skip_reason": None,
        "elapsed_s": None,
    }

    if not package or case_type not in _CASE_TYPE_TO_SOURCE:
        meta["skip_reason"] = f"unsupported case_type={case_type!r}"
        return meta, None, meta["skip_reason"]

    vuln = case.get("vulnerable")
    benign = case.get("benign")
    if not isinstance(vuln, dict) or not isinstance(benign, dict):
        meta["skip_reason"] = "missing_vulnerable_or_benign"
        return meta, None, meta["skip_reason"]

    vuln_path = vuln.get("path")
    benign_path = benign.get("path")
    if not isinstance(vuln_path, str) or not isinstance(benign_path, str):
        meta["skip_reason"] = "missing_tarball_paths"
        return meta, None, meta["skip_reason"]

    vuln_tgz = Path(vuln_path)
    benign_tgz = Path(benign_path)

    # Path remapping: the cases-index.jsonl was written with the Nextcloud
    # classic path prefix. If files don't exist, try alternate mount points.
    _PATH_REMAPS = [
        ("/Users/andreas/nextcloud-classic", "/Users/andreas/Nextcloud/Z1Hackathon"),
        ("/Users/andreas/nextcloud-classic", "/Users/andreas/Nextcloud"),
    ]

    def _remap_tgz(tgz_path: Path) -> Path | None:
        if tgz_path.is_file():
            return tgz_path
        orig = str(tgz_path)
        for old_prefix, new_prefix in _PATH_REMAPS:
            if orig.startswith(old_prefix):
                alt = Path(new_prefix + orig[len(old_prefix):])
                if alt.is_file():
                    logger.debug("remapped path: %s -> %s", tgz_path, alt)
                    return alt
        return None

    vuln_tgz = _remap_tgz(vuln_tgz)
    benign_tgz = _remap_tgz(benign_tgz)

    if vuln_tgz is None:
        meta["skip_reason"] = f"vulnerable_tgz_missing:{vuln_path}"
        return meta, None, meta["skip_reason"]
    if benign_tgz is None:
        meta["skip_reason"] = f"benign_tgz_missing:{benign_path}"
        return meta, None, meta["skip_reason"]

    if not vuln_tgz.is_file():
        meta["skip_reason"] = f"vulnerable_tgz_missing:{vuln_path}"
        return meta, None, meta["skip_reason"]
    if not benign_tgz.is_file():
        meta["skip_reason"] = f"benign_tgz_missing:{benign_path}"
        return meta, None, meta["skip_reason"]

    t0 = time.monotonic()
    try:
        with tempfile.TemporaryDirectory(prefix="mw_rb_") as case_dir:
            file_changes, pkg_json_changes, method = _diff_tarballs(
                vuln_tgz, benign_tgz, Path(case_dir)
            )
    except Exception as exc:
        meta["elapsed_s"] = round(time.monotonic() - t0, 3)
        meta["skip_reason"] = f"diff_exception:{exc.__class__.__name__}"
        return meta, None, meta["skip_reason"]

    meta["elapsed_s"] = round(time.monotonic() - t0, 3)

    if not file_changes and method.startswith("skipped"):
        meta["skip_reason"] = method
        return meta, None, meta["skip_reason"]

    # Build a synthetic VersionPair-like object for dossier_builder
    vuln_ver = str(vuln.get("version") or "")
    benign_ver = str(benign.get("version") or "")

    pair = type("VersionPair", (), {
        "package": package,
        "unpatched_version": vuln_ver,
        "patched_version": benign_ver,
        "advisory_ids": list(case.get("advisory_ids") or []),
        "severity": str(case.get("severity") or "unknown"),
        "file_changes": file_changes,
        "package_json_changes": pkg_json_changes,
        "extraction_method": method,
        "notes": [],
    })()

    try:
        dossier = build_dossier(case, pair)
        diagnosis = build_diagnosis(dossier, scraped_case=case)
        split = _split_for_package(package)
        source = _CASE_TYPE_TO_SOURCE[case_type]
        sft = build_sft_record_diagnosis(dossier, diagnosis, split=split, source=source)
    except Exception as exc:
        meta["skip_reason"] = f"build_exception:{exc.__class__.__name__}"
        logger.warning("case %s build raised: %s", case_id, exc)
        return meta, None, meta["skip_reason"]

    meta["split"] = split
    meta["source"] = source
    meta["file_changes"] = len(file_changes)
    return meta, sft, None


def run_walker(
    cases_index_path: Path,
    artifact_index_path: Path,
    output_path: Path,
    *,
    max_cases: int | None,
    concurrency: int,
) -> dict[str, Any]:
    """Run the walker using a ThreadPoolExecutor so tar extraction
    doesn't block the main thread."""
    cases_index_path = Path(cases_index_path)
    output_path = Path(output_path)
    output_path.parent.mkdir(parents=True, exist_ok=True)

    cases = _read_jsonl(cases_index_path, max_cases=max_cases)
    logger.info("loaded %d cases from %s", len(cases), cases_index_path)

    artifacts = _read_jsonl(artifact_index_path, max_cases=None)
    artifact_map = _build_artifact_map(artifacts)
    logger.info("loaded %d artifacts into lookup", len(artifact_map))

    counters: Counter[str] = Counter()
    split_counters: Counter[str] = Counter()
    source_counters: Counter[str] = Counter()

    written = 0
    with output_path.open("w", encoding="utf-8") as out_fh:
        with concurrent.futures.ThreadPoolExecutor(max_workers=concurrency) as pool:
            futures = {pool.submit(_process_one, c, artifact_map): c for c in cases}
            for fut in concurrent.futures.as_completed(futures):
                meta, sft, skip_reason = fut.result()
                if skip_reason is not None:
                    key = f"skip:{skip_reason.split(':', 1)[0]}"
                    counters[key] += 1
                    continue
                counters["written"] += 1
                written += 1
                split_counters[str(meta.get("split"))] += 1
                source_counters[str(meta.get("source"))] += 1
                out_fh.write(json.dumps(sft) + "\n")
                out_fh.flush()
                if written % 50 == 0:
                    logger.info("progress: %d written, %d skipped", written, sum(v for k, v in counters.items() if k.startswith("skip:")))

    manifest = {
        "cases_index_path": str(cases_index_path),
        "artifact_index_path": str(artifact_index_path),
        "output_path": str(output_path),
        "n_input_cases": len(cases),
        "counters": dict(counters),
        "by_split": dict(split_counters),
        "by_source": dict(source_counters),
        "concurrency": concurrency,
    }
    logger.info(
        "walker done: %d written, %d skipped, splits=%s",
        counters.get("written", 0),
        sum(v for k, v in counters.items() if k.startswith("skip:")),
        dict(split_counters),
    )
    return manifest


def _build_arg_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(description="ModuleWarden raw-bundles walker (diagnosis target)")
    p.add_argument(
        "--cases-index",
        type=Path,
        required=True,
        help="Path to raw-bundles/cases-index.jsonl.",
    )
    p.add_argument(
        "--artifact-index",
        type=Path,
        required=True,
        help="Path to raw-bundles/artifact-index.jsonl.",
    )
    p.add_argument(
        "--output",
        type=Path,
        required=True,
        help="Path to write sft-records-diagnosis.jsonl.",
    )
    p.add_argument("--max-cases", type=int, default=None)
    p.add_argument("--concurrency", type=int, default=4)
    p.add_argument("-v", "--verbose", action="store_true")
    return p


def main(argv: list[str] | None = None) -> int:
    args = _build_arg_parser().parse_args(argv)
    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s %(message)s",
    )
    if not args.cases_index.exists():
        logger.error("cases index not found: %s", args.cases_index)
        return 2
    if not args.artifact_index.exists():
        logger.error("artifact index not found: %s", args.artifact_index)
        return 2
    manifest = run_walker(
        args.cases_index,
        args.artifact_index,
        args.output,
        max_cases=args.max_cases,
        concurrency=args.concurrency,
    )
    print(json.dumps(manifest, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
