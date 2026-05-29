#!/usr/bin/env python3
"""Build contrastive version-diff dossiers from LOCAL corpus tarballs.

Replaces the live npm fetch in
``corpus_walker -> version_pair_extractor.extract_one()`` with reads
from the pre-downloaded ZeroToOne corpus. Matches the ``affected``
(vulnerable) and ``first_patched`` (benign) artifacts of one advisory
case by ``case_id`` across ``artifact-index.jsonl``, diffs the two LOCAL
tarballs with the existing ``_diff_trees`` / ``_package_json_changes``,
builds a ``VersionPair`` carrying the real tgz sha256 values, and emits
SFT records. The vulnerable-vs-patched pair is the strongest training
signal: vulnerable version -> BLOCK / QUARANTINE with capability deltas;
patched version -> ALLOW.

Cases with only a benign artifact fall back to a cold-start dossier.

SAFETY:

- Static only. Extraction goes through ``_safe_tar_extract`` (rejects
  absolute paths, ``..`` traversal, symlink / hardlink members; never
  ``tarfile.extractall``).
- Never shell out to node / npm; never execute package code or install
  scripts. The diff reads file bytes as text and runs regexes only.
- ``.partial`` files are skipped.
- ``--local-corpus-only`` (default True) hard-blocks any registry fetch;
  there is no httpx import in this script at all.
- ``normalize_dossier`` runs on every record before it reaches the model.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import logging
import sys
import tarfile
import tempfile
from collections import Counter, defaultdict
from pathlib import Path
from typing import Any, Mapping

_REPO_ROOT = Path(__file__).resolve().parents[2]
if str(_REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(_REPO_ROOT))

from finetune.python.pipeline.dossier_builder import build_dossier  # noqa: E402
from finetune.python.pipeline.report_template import build_report  # noqa: E402
from finetune.python.pipeline.sft_pair_builder import build_sft_record  # noqa: E402
from finetune.python.pipeline.version_pair_extractor import (  # noqa: E402
    MAX_TARBALL_BYTES,
    VersionPair,
    _diff_trees,
    _npm_root,
    _package_json_changes,
    _safe_tar_extract,
)
from finetune.python.data.ingestion_hardening import normalize_dossier  # noqa: E402

logger = logging.getLogger("modulewarden.build_dossiers_from_corpus")

# Roles in artifact-index. The vulnerable bucket carries likely_affected
# versions; the benign bucket carries first_patched versions.
_VULN_BUCKET = "vulnerable"
_BENIGN_BUCKET = "benign"


def _split_for_package(
    package: str, *, train: float = 0.70, validation: float = 0.15
) -> str:
    h = hashlib.sha256(package.encode("utf-8")).digest()
    bucket = int.from_bytes(h[:4], "big") / 0xFFFFFFFF
    if bucket < train:
        return "train"
    if bucket < train + validation:
        return "validation"
    return "test"


def _tgz_sha256(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as fh:
        for chunk in iter(lambda: fh.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


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


def _usable_path(
    artifact: Mapping[str, Any], corpus_root: Path | None, max_bytes: int
) -> Path | None:
    """Resolve and validate a local .tgz path. None if unusable."""
    path = _resolve_artifact_path(artifact, corpus_root)
    if path is None:
        return None
    if path.name.endswith(".partial"):
        return None
    if not path.is_file():
        return None
    try:
        if path.stat().st_size > max_bytes:
            return None
    except OSError:
        return None
    return path


def _synthetic_case(
    case_id: str,
    package: str,
    advisory_ids: list[str],
    *,
    case_type: str,
    severity: str,
) -> dict[str, Any]:
    return {
        "schema_version": "modulewarden.scraped_case.v1",
        "case_id": case_id,
        "package": package,
        "case_type": case_type,
        "severity": severity,
        "advisory_ids": advisory_ids,
        "summary": (
            f"Corpus-derived case {case_id} for npm package {package}."
        ),
        "source": "corpus_local_tarballs",
    }


def build_contrastive_pair(
    vuln_path: Path,
    benign_path: Path,
    *,
    package: str,
    vuln_version: str,
    benign_version: str,
    advisory_ids: list[str],
    severity: str,
    work_dir: Path,
) -> VersionPair:
    """Diff the local vulnerable .tgz against the local benign .tgz.

    Mirrors version_pair_extractor.extract_one's tail (extract both,
    _npm_root, _diff_trees, _package_json_changes) but with local reads.
    Real tgz sha256 values are recorded in notes for downstream use.
    """
    with tempfile.TemporaryDirectory(dir=str(work_dir)) as tmp:
        tmp_path = Path(tmp)
        vuln_dir = tmp_path / "vulnerable"
        benign_dir = tmp_path / "benign"

        n_vuln = _safe_tar_extract(vuln_path, vuln_dir)
        n_benign = _safe_tar_extract(benign_path, benign_dir)

        vuln_root = _npm_root(vuln_dir)
        benign_root = _npm_root(benign_dir)

        # Unpatched = vulnerable (before), patched = benign (after).
        changes = _diff_trees(vuln_root, benign_root)
        pkg_changes = _package_json_changes(vuln_root, benign_root)

    notes = [
        "local_corpus_only=true",
        f"vulnerable_extracted_members={n_vuln}",
        f"benign_extracted_members={n_benign}",
        f"vulnerable_tgz_sha256={_tgz_sha256(vuln_path)}",
        f"benign_tgz_sha256={_tgz_sha256(benign_path)}",
    ]
    return VersionPair(
        package=package,
        unpatched_version=vuln_version,
        patched_version=benign_version,
        advisory_ids=advisory_ids,
        severity=severity,
        file_changes=changes,
        package_json_changes=pkg_changes,
        extraction_method="local_tarball_diff",
        notes=notes,
    )


def build_cold_start_pair(
    benign_path: Path,
    *,
    package: str,
    benign_version: str,
    advisory_ids: list[str],
    severity: str,
) -> VersionPair:
    """Benign-only case: cold-start pair, no diff. Real sha256 in notes."""
    return VersionPair(
        package=package,
        unpatched_version="",
        patched_version=benign_version,
        advisory_ids=advisory_ids,
        severity=severity,
        file_changes=[],
        package_json_changes={},
        extraction_method="local_corpus_cold_start",
        notes=[
            "local_corpus_only=true",
            f"benign_tgz_sha256={_tgz_sha256(benign_path)}",
        ],
    )


def _records_for_pair(
    case: Mapping[str, Any],
    pair: VersionPair,
    *,
    audit_mode: str | None,
    source: str,
) -> dict[str, Any]:
    """dossier -> normalize -> report -> sft, all reused from the pipeline."""
    dossier = build_dossier(case, pair, audit_mode=audit_mode)
    dossier = normalize_dossier(dossier)
    report = build_report(dossier, scraped_case=case)
    split = _split_for_package(str(case.get("package") or pair.package))
    sft = build_sft_record(dossier, report, split=split, source=source)
    return {
        "sft": sft,
        "verdict": str(report.get("verdict") or ""),
        "split": split,
        "audit_id": dossier.get("audit_id"),
    }


def _index_by_case(
    index_path: Path, corpus_root: Path | None, max_bytes: int
) -> dict[str, dict[str, list[dict[str, Any]]]]:
    """Group artifacts by case_id then bucket.

    Returns {case_id: {"vulnerable": [...], "benign": [...]}}.
    An artifact with N case_ids is attached to all N cases.
    """
    by_case: dict[str, dict[str, list[dict[str, Any]]]] = defaultdict(
        lambda: {"vulnerable": [], "benign": []}
    )
    with index_path.open("r", encoding="utf-8") as fh:
        for line in fh:
            stripped = line.strip()
            if not stripped:
                continue
            try:
                artifact = json.loads(stripped)
            except json.JSONDecodeError:
                continue
            if not isinstance(artifact, dict):
                continue
            bucket = str(artifact.get("bucket") or "")
            if bucket not in (_VULN_BUCKET, _BENIGN_BUCKET):
                continue
            case_ids = artifact.get("case_ids") or []
            if not isinstance(case_ids, list) or not case_ids:
                continue
            for cid in case_ids:
                by_case[str(cid)][bucket].append(artifact)
    return by_case


def process_index(
    index_path: Path,
    output_path: Path,
    *,
    corpus_root: Path | None,
    max_cases: int | None,
    max_tarball_bytes: int,
    local_corpus_only: bool,
) -> dict[str, Any]:
    """Build contrastive + cold-start SFT records from the local corpus."""
    if not local_corpus_only:
        # This script has no registry path by design. Refuse rather than
        # silently fetch a malicious tarball from a remote.
        raise ValueError(
            "build-dossiers-from-corpus is local-only; "
            "--local-corpus-only cannot be disabled."
        )

    output_path.parent.mkdir(parents=True, exist_ok=True)
    by_case = _index_by_case(index_path, corpus_root, max_tarball_bytes)

    counters: Counter[str] = Counter()
    verdict_counters: Counter[str] = Counter()
    split_counters: Counter[str] = Counter()
    written = 0

    with tempfile.TemporaryDirectory(prefix="mw_corpus_dossier_") as work_root, \
            output_path.open("w", encoding="utf-8") as out_fh:
        work_dir = Path(work_root)
        for case_id in sorted(by_case):
            buckets = by_case[case_id]
            vuln_arts = buckets["vulnerable"]
            benign_arts = buckets["benign"]

            vuln_art = vuln_arts[0] if vuln_arts else None
            benign_art = benign_arts[0] if benign_arts else None

            advisory_ids: list[str] = []
            for art in (vuln_art, benign_art):
                if art:
                    advisory_ids = list(art.get("advisory_ids") or advisory_ids)
                    if advisory_ids:
                        break

            try:
                if vuln_art and benign_art:
                    vuln_path = _usable_path(vuln_art, corpus_root, max_tarball_bytes)
                    benign_path = _usable_path(benign_art, corpus_root, max_tarball_bytes)
                    if vuln_path is None or benign_path is None:
                        counters["skip:missing_tgz"] += 1
                        continue
                    package = str(vuln_art.get("package") or benign_art.get("package") or "")
                    pair = build_contrastive_pair(
                        vuln_path,
                        benign_path,
                        package=package,
                        vuln_version=str(vuln_art.get("version") or ""),
                        benign_version=str(benign_art.get("version") or ""),
                        advisory_ids=advisory_ids,
                        severity="high",
                        work_dir=work_dir,
                    )
                    case = _synthetic_case(
                        case_id, package, advisory_ids,
                        case_type="cve_diff", severity="high",
                    )
                    result = _records_for_pair(
                        case, pair, audit_mode="version_diff", source="cve_diff"
                    )
                    counters["written:contrastive"] += 1
                elif benign_art:
                    benign_path = _usable_path(benign_art, corpus_root, max_tarball_bytes)
                    if benign_path is None:
                        counters["skip:missing_tgz"] += 1
                        continue
                    package = str(benign_art.get("package") or "")
                    pair = build_cold_start_pair(
                        benign_path,
                        package=package,
                        benign_version=str(benign_art.get("version") or ""),
                        advisory_ids=advisory_ids,
                        severity="low",
                    )
                    case = _synthetic_case(
                        case_id, package, advisory_ids,
                        case_type="benign_neighbor", severity="low",
                    )
                    result = _records_for_pair(
                        case, pair, audit_mode="cold_start", source="benign_neighbor"
                    )
                    counters["written:cold_start"] += 1
                else:
                    # vulnerable-only with no benign counterpart: still
                    # produce a record so the BLOCK signal is captured.
                    vuln_path = _usable_path(vuln_art, corpus_root, max_tarball_bytes) if vuln_art else None
                    if vuln_path is None:
                        counters["skip:missing_tgz"] += 1
                        continue
                    package = str(vuln_art.get("package") or "")
                    pair = build_cold_start_pair(
                        vuln_path,
                        package=package,
                        benign_version=str(vuln_art.get("version") or ""),
                        advisory_ids=advisory_ids,
                        severity="high",
                    )
                    pair.extraction_method = "local_corpus_vuln_only"
                    case = _synthetic_case(
                        case_id, package, advisory_ids,
                        case_type="incident_replay", severity="high",
                    )
                    result = _records_for_pair(
                        case, pair, audit_mode="incident_replay", source="incident_replay"
                    )
                    counters["written:vuln_only"] += 1
            except (tarfile.TarError, OSError) as exc:
                logger.warning("case %s tar/io error: %s", case_id, exc)
                counters["skip:tar_corrupt"] += 1
                continue
            except Exception as exc:  # noqa: BLE001 - one bad case must not halt the walk
                logger.warning("case %s build error: %s", case_id, exc)
                counters[f"skip:build_error:{exc.__class__.__name__}"] += 1
                continue

            out_fh.write(json.dumps(result["sft"]) + "\n")
            written += 1
            counters["written"] += 1
            verdict_counters[str(result["verdict"]).lower() or "unknown"] += 1
            split_counters[str(result["split"])] += 1

            if max_cases is not None and written >= max_cases:
                break

    manifest = {
        "index_path": str(index_path),
        "output_path": str(output_path),
        "corpus_root": str(corpus_root) if corpus_root else None,
        "local_corpus_only": local_corpus_only,
        "n_cases_grouped": len(by_case),
        "written": written,
        "by_verdict": dict(verdict_counters),
        "by_split": dict(split_counters),
        "counters": dict(counters),
    }
    return manifest


def _build_arg_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        description="Build contrastive version-diff dossiers from local corpus tarballs."
    )
    p.add_argument(
        "--artifact-index",
        type=Path,
        default=Path("finetune/corpus/artifact-index.jsonl"),
    )
    p.add_argument(
        "--output",
        type=Path,
        default=Path("finetune/corpus/sft-records.corpus.jsonl"),
    )
    p.add_argument("--corpus-root", type=Path, default=None)
    p.add_argument("--max-cases", type=int, default=None)
    p.add_argument("--max-tarball-bytes", type=int, default=MAX_TARBALL_BYTES)
    p.add_argument(
        "--local-corpus-only",
        action="store_true",
        default=True,
        help="Default True and cannot be disabled; this script never "
        "contacts a registry.",
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
        max_cases=args.max_cases,
        max_tarball_bytes=args.max_tarball_bytes,
        local_corpus_only=args.local_corpus_only,
    )
    print(json.dumps({"manifest": manifest}, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
