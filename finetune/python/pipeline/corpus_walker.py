"""Walk scraped-cases.jsonl -> sft-records.jsonl.

For each scraped case:

1. Run ``version_pair_extractor.extract_one`` to pull both tarballs and diff them.
2. Build an ``audit_dossier.v1`` via ``dossier_builder.build_dossier``.
3. Build a ground-truth ``audit_report.v1`` via ``report_template.build_report``.
4. Pair them into a ``sft_record.v1`` via ``sft_pair_builder.build_sft_record``.
5. Append the SFT record to the output JSONL.

The split assignment is BY PACKAGE NAME, per ``finetune/docs/corpus-plan.md``:
the deterministic 70/15/15 split is computed from a stable hash of the
package name, so re-running on the same corpus produces the same split
every time, and no package leaks across train/validation/test.

The walker is idempotent: re-running over the same scraped-cases.jsonl
overwrites the output JSONL with the same records (modulo ordering).
Concurrency defaults to 4 to stay below the npm registry's per-IP rate
limit and to keep the workstation safe from the OOM that killed the
17K-package run earlier.

SAFETY:

- No npm package is ever executed. Tarball extraction uses
  ``tarfile.open`` plus a path-traversal-safe filter from the cherrypicked
  ``version_pair_extractor`` module.
- Network access is restricted to ``registry.npmjs.org`` and
  ``registry.yarnpkg.com`` per the SSRF allowlist.
- The walker never reads `--scraped-cases` from a URL; only a local Path.
- Each output SFT record is JSON; nothing is shelled out, no subprocess
  is spawned.
"""

from __future__ import annotations

import argparse
import asyncio
import hashlib
import json
import logging
import sys
import tempfile
import time
from collections import Counter
from pathlib import Path
from typing import Any, Iterable, Mapping

import httpx

from .dossier_builder import build_dossier, serialize_version_pair
from .report_template import build_report
from .sft_pair_builder import build_sft_record
from .version_pair_extractor import (
    DEFAULT_REGISTRY,
    DEFAULT_REQUEST_TIMEOUT,
    MAX_TARBALL_BYTES,
    VersionPair,
    extract_one,
)

logger = logging.getLogger("modulewarden.corpus_walker")

# Map scraped-case.case_type -> sft_record.source per schema.
_CASE_TYPE_TO_SOURCE: dict[str, str] = {
    "incident_replay": "incident_replay",
    "benign_neighbor": "benign_neighbor",
    "cve_diff": "cve_diff",
    "dogfood_dependency": "dogfood_dependency",
    "synthetic_teacher": "synthetic_teacher",
    "manual_golden": "manual_golden",
}


def _read_jsonl(path: Path, max_cases: int | None) -> list[dict[str, Any]]:
    """Read up to ``max_cases`` records from a JSONL file."""
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


def _split_for_package(package: str, *, train: float = 0.70, validation: float = 0.15) -> str:
    """Deterministic 70/15/15 split by package name hash.

    Same package -> same split forever.
    """
    h = hashlib.sha256(package.encode("utf-8")).digest()
    bucket = int.from_bytes(h[:4], "big") / 0xFFFFFFFF
    if bucket < train:
        return "train"
    if bucket < train + validation:
        return "validation"
    return "test"


async def _process_one(
    scraped_case: Mapping[str, Any],
    client: httpx.AsyncClient,
    work_dir: Path,
    registry: str,
    max_tarball_bytes: int,
    semaphore: asyncio.Semaphore,
) -> tuple[dict[str, Any], dict[str, Any] | None, str | None]:
    """Process one scraped case end-to-end. Returns (meta, sft_record, skip_reason)."""
    case_id = str(scraped_case.get("case_id") or "unknown")
    package = str(scraped_case.get("package") or "")
    case_type = str(scraped_case.get("case_type") or "")
    meta = {
        "case_id": case_id,
        "package": package,
        "case_type": case_type,
        "extraction_method": None,
        "skip_reason": None,
        "elapsed_s": None,
    }

    if not package or case_type not in _CASE_TYPE_TO_SOURCE:
        meta["skip_reason"] = f"unsupported case_type={case_type!r}"
        return meta, None, meta["skip_reason"]

    t0 = time.monotonic()
    async with semaphore:
        try:
            pair: VersionPair = await extract_one(
                dict(scraped_case),
                client,
                work_dir,
                registry,
                max_tarball_bytes,
            )
        except Exception as exc:  # noqa: BLE001 - intentional catch-all
            meta["elapsed_s"] = round(time.monotonic() - t0, 3)
            meta["skip_reason"] = f"extractor_exception: {exc.__class__.__name__}"
            logger.warning("case %s extractor raised: %s", case_id, exc)
            return meta, None, meta["skip_reason"]
    meta["elapsed_s"] = round(time.monotonic() - t0, 3)
    meta["extraction_method"] = pair.extraction_method

    if pair.extraction_method.startswith("skipped_"):
        meta["skip_reason"] = pair.extraction_method
        return meta, None, meta["skip_reason"]

    try:
        dossier = build_dossier(scraped_case, pair)
        report = build_report(dossier, scraped_case=scraped_case)
        split = _split_for_package(package)
        source = _CASE_TYPE_TO_SOURCE[case_type]
        sft = build_sft_record(dossier, report, split=split, source=source)
    except Exception as exc:  # noqa: BLE001
        meta["skip_reason"] = f"build_exception: {exc.__class__.__name__}"
        logger.warning("case %s build raised: %s", case_id, exc)
        return meta, None, meta["skip_reason"]

    meta["split"] = split
    meta["source"] = source
    meta["audit_id"] = dossier["audit_id"]
    return meta, sft, None


async def run_walker(
    scraped_cases_path: Path,
    output_path: Path,
    *,
    max_cases: int | None,
    concurrency: int,
    registry: str,
    max_tarball_bytes: int,
    request_timeout: float,
    manifest_path: Path | None,
) -> dict[str, Any]:
    """Run the walker and return a manifest summary dict."""
    scraped_cases_path = Path(scraped_cases_path)
    output_path = Path(output_path)
    output_path.parent.mkdir(parents=True, exist_ok=True)

    cases = _read_jsonl(scraped_cases_path, max_cases=max_cases)
    logger.info("loaded %d scraped cases from %s", len(cases), scraped_cases_path)

    semaphore = asyncio.Semaphore(concurrency)
    counters: Counter[str] = Counter()
    split_counters: Counter[str] = Counter()
    source_counters: Counter[str] = Counter()
    metas: list[dict[str, Any]] = []

    with tempfile.TemporaryDirectory(prefix="mw_walker_") as work_root:
        work_dir = Path(work_root)
        async with httpx.AsyncClient(timeout=request_timeout) as client:
            tasks = [
                asyncio.create_task(
                    _process_one(
                        c,
                        client,
                        work_dir,
                        registry,
                        max_tarball_bytes,
                        semaphore,
                    )
                )
                for c in cases
            ]
            with output_path.open("w", encoding="utf-8") as out_fh:
                for fut in asyncio.as_completed(tasks):
                    meta, sft, skip_reason = await fut
                    metas.append(meta)
                    if skip_reason is not None:
                        counters[f"skip:{skip_reason.split(':', 1)[0]}"] += 1
                        continue
                    counters["written"] += 1
                    split_counters[str(meta.get("split"))] += 1
                    source_counters[str(meta.get("source"))] += 1
                    out_fh.write(json.dumps(sft) + "\n")

    manifest = {
        "scraped_cases_path": str(scraped_cases_path),
        "output_path": str(output_path),
        "n_input_cases": len(cases),
        "counters": dict(counters),
        "by_split": dict(split_counters),
        "by_source": dict(source_counters),
        "concurrency": concurrency,
        "registry": registry,
        "max_tarball_bytes": max_tarball_bytes,
    }
    if manifest_path is not None:
        manifest_path = Path(manifest_path)
        manifest_path.parent.mkdir(parents=True, exist_ok=True)
        manifest_path.write_text(
            json.dumps({"manifest": manifest, "cases": metas}, indent=2),
            encoding="utf-8",
        )
        logger.info("wrote manifest to %s", manifest_path)
    logger.info(
        "walker done: %d written, %d skipped, splits=%s",
        counters.get("written", 0),
        sum(v for k, v in counters.items() if k.startswith("skip:")),
        dict(split_counters),
    )
    return manifest


def _build_arg_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(description="ModuleWarden corpus walker")
    p.add_argument(
        "--scraped-cases",
        type=Path,
        default=Path("finetune/corpus/scraped-cases.jsonl"),
        help="Path to the scrape-cases.mjs output JSONL.",
    )
    p.add_argument(
        "--output",
        type=Path,
        default=Path("finetune/corpus/sft-records.jsonl"),
        help="Path to write sft_record.v1 JSONL.",
    )
    p.add_argument(
        "--manifest",
        type=Path,
        default=None,
        help="Optional manifest JSON path with per-case metadata.",
    )
    p.add_argument("--max-cases", type=int, default=None)
    p.add_argument(
        "--concurrency",
        type=int,
        default=4,
        help="Concurrent extractor tasks; default 4. Higher values can OOM and "
        "hit npm rate limits.",
    )
    p.add_argument("--registry", default=DEFAULT_REGISTRY)
    p.add_argument(
        "--max-tarball-bytes",
        type=int,
        default=MAX_TARBALL_BYTES,
        help="Per-tarball byte cap. Default 50 MiB.",
    )
    p.add_argument(
        "--request-timeout",
        type=float,
        default=DEFAULT_REQUEST_TIMEOUT,
        help="HTTP request timeout for npm registry calls.",
    )
    p.add_argument("-v", "--verbose", action="store_true")
    return p


def main(argv: list[str] | None = None) -> int:
    args = _build_arg_parser().parse_args(argv)
    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s %(message)s",
    )
    if not args.scraped_cases.exists():
        logger.error("scraped cases file not found: %s", args.scraped_cases)
        return 2
    manifest = asyncio.run(
        run_walker(
            args.scraped_cases,
            args.output,
            max_cases=args.max_cases,
            concurrency=args.concurrency,
            registry=args.registry,
            max_tarball_bytes=args.max_tarball_bytes,
            request_timeout=args.request_timeout,
            manifest_path=args.manifest,
        )
    )
    print(json.dumps(manifest, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
