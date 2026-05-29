#!/usr/bin/env python3
"""Build benign ALLOW SFT records from the corpus to fix block_recall=0.

The fine-tune defaults to "quarantine" because every training record is
malicious; there are no benign negatives. This script walks the BENIGN
bucket (``first_patched`` artifacts) from ``artifact-index.jsonl``, runs
the same static capability detection as ``extract-tarball-features.py``,
builds a cold-start dossier (``audit_mode="cold_start"``, no diff
needed), calls ``normalize_dossier`` then ``build_report`` then
``build_sft_record``, and writes the ALLOW records to a JSONL.

For a cold-start dossier with no sensitive capability deltas the report
verdict is ALLOW by the labeling rubric in ``report_template``. A benign
artifact that happens to trip a sensitive-capability detector would
instead quarantine; those are skipped (and counted) rather than
mislabeled as ALLOW, because a quarantine record is not the benign
negative this script exists to produce.

SAFETY:

- Static read only. Reuses the tarball reader from
  ``extract-tarball-features.py`` (``extract_artifact_features`` over an
  open tarfile). Never ``extractall``, never execute, never shell out.
- ``.partial`` files are skipped.
- ``normalize_dossier`` runs on every record before it reaches the model.
- ``--local-corpus-only`` is the default behavior; the flag documents
  intent and is recorded in the manifest. No registry is ever contacted.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import logging
import sys
import tarfile
from collections import Counter
from pathlib import Path
from typing import Any, Mapping

_REPO_ROOT = Path(__file__).resolve().parents[2]
if str(_REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(_REPO_ROOT))

# Import the sibling extractor by file path; the filename has a hyphen so
# it cannot be a normal module import.
import importlib.util  # noqa: E402

_EXTRACTOR_PATH = Path(__file__).resolve().parent / "extract-tarball-features.py"
_spec = importlib.util.spec_from_file_location(
    "mw_extract_tarball_features", _EXTRACTOR_PATH
)
assert _spec is not None and _spec.loader is not None
_extractor = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_extractor)
extract_artifact_features = _extractor.extract_artifact_features

from finetune.python.pipeline.dossier_builder import build_dossier  # noqa: E402
from finetune.python.pipeline.report_template import build_report  # noqa: E402
from finetune.python.pipeline.sft_pair_builder import build_sft_record  # noqa: E402
from finetune.python.pipeline.version_pair_extractor import (  # noqa: E402
    MAX_TARBALL_BYTES,
    FileChange,
    VersionPair,
)
from finetune.python.data.ingestion_hardening import normalize_dossier  # noqa: E402

logger = logging.getLogger("modulewarden.build_benign_sft")

# benign records use the benign_neighbor source so they group cleanly in
# the SFT corpus and pass build_sft_record's source validation.
_SFT_SOURCE = "benign_neighbor"


def _split_for_package(
    package: str, *, train: float = 0.70, validation: float = 0.15
) -> str:
    """Deterministic 70/15/15 split by package name hash.

    Identical to corpus_walker._split_for_package so benign and malicious
    records share one split policy and no package leaks across splits.
    """
    h = hashlib.sha256(package.encode("utf-8")).digest()
    bucket = int.from_bytes(h[:4], "big") / 0xFFFFFFFF
    if bucket < train:
        return "train"
    if bucket < train + validation:
        return "validation"
    return "test"


def _synthetic_benign_case(
    package: str, version: str, artifact: Mapping[str, Any]
) -> dict[str, Any]:
    """Build a minimal scraped_case.v1-shaped dict for a benign artifact.

    The benign bucket is the ``first_patched`` side of a real advisory
    case, so it is a genuine non-malicious negative. ``case_type`` is set
    to ``benign_neighbor`` so build_report's rubric treats a clean
    cold-start dossier as ALLOW.
    """
    advisory_ids = list(artifact.get("advisory_ids") or [])
    case_ids = list(artifact.get("case_ids") or [])
    return {
        "schema_version": "modulewarden.scraped_case.v1",
        "case_id": (case_ids[0] if case_ids else f"benign_{package}_{version}"),
        "package": package,
        "case_type": "benign_neighbor",
        "severity": "low",
        "advisory_ids": advisory_ids,
        "summary": (
            f"First-patched (benign) version {version} of npm package "
            f"{package} drawn from the corpus benign bucket."
        ),
        "source": "corpus_benign_bucket",
    }


def _cold_start_pair(package: str, version: str) -> VersionPair:
    """A VersionPair carrying only the benign version, no diff.

    cold_start needs no predecessor; file_changes stays empty so the
    dossier has no capability deltas unless the static scan added them.
    """
    return VersionPair(
        package=package,
        unpatched_version="",
        patched_version=version,
        advisory_ids=[],
        severity="low",
        file_changes=[],
        package_json_changes={},
        extraction_method="local_corpus_cold_start",
        notes=["benign cold_start from local corpus tarball"],
    )


def _inject_capability_deltas(
    pair: VersionPair, features: Mapping[str, Any]
) -> None:
    """Fold the static scan's capability deltas into the dossier path.

    build_dossier reads deltas from file diffs, but a cold-start scan has
    no diff. We synthesize one synthetic FileChange whose added text is
    empty and instead attach the detected deltas directly by extending
    package_json_changes for the lifecycle case. Network / exec / etc.
    deltas are surfaced via the dossier's capability_deltas after the
    fact, so the report rubric can see sensitive caps and avoid a false
    ALLOW. We do this by setting up package_json scripts when present.
    """
    bodies = features.get("lifecycle_script_bodies") or {}
    if bodies:
        pair.package_json_changes = {
            "before": {"scripts": {}},
            "after": {"scripts": dict(bodies)},
        }


def _has_sensitive_signal(features: Mapping[str, Any]) -> bool:
    """True when the static scan tripped a sensitive (non-benign) capability.

    A purely benign package has lifecycle_script at most. Network,
    credential, process-exec, dynamic-eval, obfuscation, fs-sensitive, or
    native/wasm signals mean the artifact is not a clean ALLOW negative.
    """
    signals = features.get("capability_signals") or {}
    sensitive = (
        "network_access",
        "credential_or_env_access",
        "process_execution",
        "dynamic_code_execution",
        "obfuscation",
        "filesystem_sensitive_access",
        "native_or_wasm",
    )
    return any(bool(signals.get(k)) for k in sensitive)


def build_one_record(
    tf: tarfile.TarFile,
    artifact: Mapping[str, Any],
) -> tuple[dict[str, Any] | None, str | None]:
    """Build one benign ALLOW SFT record from an open tarfile.

    Returns (sft_record, skip_reason). skip_reason is set when the
    artifact is not a clean ALLOW negative (e.g. it tripped a sensitive
    capability or the report did not resolve to ALLOW).
    """
    package = str(artifact.get("package") or "")
    version = str(artifact.get("version") or "")
    bucket = str(artifact.get("bucket") or "benign")

    features = extract_artifact_features(
        tf, package=package, version=version, bucket=bucket
    )
    package = features["package"] or package
    version = features["version"] or version
    if not package:
        return None, "no_package_name"

    if _has_sensitive_signal(features):
        return None, "sensitive_capability_not_benign"

    case = _synthetic_benign_case(package, version, artifact)
    pair = _cold_start_pair(package, version)
    _inject_capability_deltas(pair, features)

    dossier = build_dossier(case, pair, audit_mode="cold_start")
    dossier = normalize_dossier(dossier)
    report = build_report(dossier, scraped_case=case)

    verdict = str(report.get("verdict") or "").lower()
    if verdict != "allow":
        return None, f"verdict_not_allow:{verdict or 'unknown'}"

    split = _split_for_package(package)
    sft = build_sft_record(dossier, report, split=split, source=_SFT_SOURCE)
    return sft, None


def _resolve_artifact_path(
    artifact: Mapping[str, Any], corpus_root: Path | None
) -> Path | None:
    raw = artifact.get("path")
    if not isinstance(raw, str) or not raw:
        return None
    p = Path(raw)
    if not p.is_absolute() and corpus_root is not None:
        p = corpus_root / p
    return p


def process_index(
    index_path: Path,
    output_path: Path,
    *,
    corpus_root: Path | None,
    benign_bucket: str,
    max_records: int | None,
    max_tarball_bytes: int,
    local_corpus_only: bool,
) -> dict[str, Any]:
    """Walk the benign bucket, write benign ALLOW SFT records JSONL."""
    output_path.parent.mkdir(parents=True, exist_ok=True)

    counters: Counter[str] = Counter()
    split_counters: Counter[str] = Counter()
    written = 0

    with index_path.open("r", encoding="utf-8") as idx_fh, output_path.open(
        "w", encoding="utf-8"
    ) as out_fh:
        for line in idx_fh:
            stripped = line.strip()
            if not stripped:
                continue
            try:
                artifact = json.loads(stripped)
            except json.JSONDecodeError:
                counters["skip:bad_json"] += 1
                continue
            if not isinstance(artifact, dict):
                counters["skip:not_object"] += 1
                continue
            if str(artifact.get("bucket") or "") != benign_bucket:
                counters["skip:not_benign"] += 1
                continue

            path = _resolve_artifact_path(artifact, corpus_root)
            if path is None:
                counters["skip:no_path"] += 1
                continue
            if path.name.endswith(".partial"):
                counters["skip:partial"] += 1
                continue
            if not path.is_file():
                counters["skip:missing_tgz"] += 1
                continue
            try:
                if path.stat().st_size > max_tarball_bytes:
                    counters["skip:oversize"] += 1
                    continue
            except OSError:
                counters["skip:stat_error"] += 1
                continue

            try:
                with tarfile.open(path, mode="r:*") as tf:
                    sft, skip = build_one_record(tf, artifact)
            except (tarfile.TarError, OSError) as exc:
                logger.warning("tar open failed for %s: %s", path, exc)
                counters["skip:tar_corrupt"] += 1
                continue
            except Exception as exc:  # noqa: BLE001 - never let one bad record halt the walk
                logger.warning("build failed for %s: %s", path, exc)
                counters[f"skip:build_error:{exc.__class__.__name__}"] += 1
                continue

            if skip is not None:
                counters[f"skip:{skip.split(':', 1)[0]}"] += 1
                continue

            out_fh.write(json.dumps(sft) + "\n")
            written += 1
            counters["written"] += 1
            split_counters[str(sft.get("split"))] += 1

            if max_records is not None and written >= max_records:
                break

    manifest = {
        "index_path": str(index_path),
        "output_path": str(output_path),
        "corpus_root": str(corpus_root) if corpus_root else None,
        "benign_bucket": benign_bucket,
        "local_corpus_only": local_corpus_only,
        "written": written,
        "by_split": dict(split_counters),
        "counters": dict(counters),
    }
    return manifest


def _build_arg_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        description="Build benign ALLOW SFT records from the corpus."
    )
    p.add_argument(
        "--artifact-index",
        type=Path,
        default=Path("finetune/corpus/artifact-index.jsonl"),
    )
    p.add_argument(
        "--output",
        type=Path,
        default=Path("finetune/corpus/sft-records.benign.jsonl"),
    )
    p.add_argument("--corpus-root", type=Path, default=None)
    p.add_argument(
        "--benign-bucket",
        default="benign",
        help="Value of the artifact-index 'bucket' field for benign artifacts.",
    )
    p.add_argument(
        "--max-records",
        type=int,
        default=None,
        help="Cap the number of benign records written (e.g. 300).",
    )
    p.add_argument("--max-tarball-bytes", type=int, default=MAX_TARBALL_BYTES)
    p.add_argument(
        "--local-corpus-only",
        action="store_true",
        help="Default behavior. Never contacts a registry; recorded in manifest.",
    )
    p.add_argument("-v", "--verbose", action="store_true")
    return p


def main(argv: list[str] | None = None) -> int:
    args = _build_arg_parser().parse_args(argv)
    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s %(message)s",
    )
    if not args.artifact_index.exists():
        logger.error("artifact-index not found: %s", args.artifact_index)
        return 2
    manifest = process_index(
        args.artifact_index,
        args.output,
        corpus_root=args.corpus_root,
        benign_bucket=args.benign_bucket,
        max_records=args.max_records,
        max_tarball_bytes=args.max_tarball_bytes,
        local_corpus_only=args.local_corpus_only,
    )
    print(json.dumps({"manifest": manifest}, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
