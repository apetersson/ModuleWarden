#!/usr/bin/env python3
"""Static feature extraction over the ZeroToOne tarball corpus.

Reads ``artifact-index.jsonl`` and, for each artifact, opens the local
``.tgz`` with ``tarfile.open(path, "r:*")``, iterates ``getmembers()``
behind a reject filter (no absolute paths, no ``..`` traversal, no
symlink / hardlink members), reads ``package/package.json``, walks the
textual files, and runs the existing capability detectors from
``finetune/python/pipeline/dossier_builder.py`` (``_detect_caps_in_text``
and ``_detect_lifecycle_script_delta``). One row per artifact is written
to ``tarball-features.jsonl`` and the capability-signal distribution is
printed across both buckets.

SAFETY (the vulnerable bucket is live malware):

- Never ``tarfile.extractall``. Members are streamed in-memory via
  ``extractfile`` after the reject filter, never written to disk.
- Never shell out to ``node`` / ``npm`` / ``npx``. No subprocess at all.
- Never execute package code or lifecycle scripts. Script bodies are
  read as TEXT and matched against regexes only.
- Static read only. Files ending ``.partial`` are skipped.
- Per-tarball byte cap and per-file byte cap mirror
  ``version_pair_extractor``.

This module is import-safe with zero corpus present: the heavy work is
behind ``main()`` and the reusable logic
(``extract_artifact_features``) takes an open tarfile, so the pytest
smoke test can drive it against a tiny synthetic tarball.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import logging
import math
import os
import sys
import tarfile
from collections import Counter
from pathlib import Path
from typing import Any, Iterable, Mapping

# Repo root is finetune/scripts/ -> ../.. so the finetune.python package
# resolves whether the script is run from the repo root or elsewhere.
_REPO_ROOT = Path(__file__).resolve().parents[2]
if str(_REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(_REPO_ROOT))

from finetune.python.pipeline.dossier_builder import (  # noqa: E402
    _detect_caps_in_text,
    _detect_lifecycle_script_delta,
)
from finetune.python.pipeline.version_pair_extractor import (  # noqa: E402
    MAX_FILE_BYTES,
    MAX_TARBALL_BYTES,
    TEXTUAL_EXTENSIONS,
)

logger = logging.getLogger("modulewarden.extract_tarball_features")

SCHEMA_VERSION = "modulewarden.tarball_features.v1"

# Lifecycle hooks we surface in has_install_script / lifecycle_hooks_present.
_INSTALL_HOOKS: tuple[str, ...] = ("preinstall", "install", "postinstall")

# No-extension files worth scanning, mirrors version_pair_extractor._walk_textual_files.
_NO_EXT_ALLOWLIST = {"LICENSE", "README", "Makefile", "CHANGELOG"}

# All capability keys the detectors can emit. Pre-seed the signal dict so
# every row carries the full set of booleans, making the bucket
# distribution directly comparable across artifacts.
_CAPABILITY_KEYS: tuple[str, ...] = (
    "lifecycle_script",
    "network_access",
    "credential_or_env_access",
    "process_execution",
    "dynamic_code_execution",
    "obfuscation",
    "filesystem_sensitive_access",
    "native_or_wasm",
)


class _RejectedMember(Exception):
    """Internal marker for a tar member that fails the reject filter."""


def _member_is_safe(member: tarfile.TarInfo) -> bool:
    """Mirror version_pair_extractor._safe_tar_extract's member filter.

    Reject absolute paths, ``..`` traversal, and symlink / hardlink
    members. Returns True only for plain regular files / dirs that stay
    inside the archive tree.
    """
    name = member.name
    if not name or name.startswith("/") or os.path.isabs(name):
        return False
    if ".." in Path(name).parts:
        return False
    if member.issym() or member.islnk():
        return False
    return True


def _shannon_entropy(data: bytes) -> float:
    """Shannon entropy (bits per byte) of a byte string. 0.0 for empty."""
    if not data:
        return 0.0
    counts = Counter(data)
    length = len(data)
    entropy = 0.0
    for count in counts.values():
        p = count / length
        entropy -= p * math.log2(p)
    return entropy


def _is_textual(name: str) -> bool:
    p = Path(name)
    return p.suffix.lower() in TEXTUAL_EXTENSIONS or p.name in _NO_EXT_ALLOWLIST


def _decode(raw: bytes) -> str:
    try:
        return raw.decode("utf-8")
    except UnicodeDecodeError:
        try:
            return raw.decode("latin-1")
        except UnicodeDecodeError:
            return ""


def _package_root_prefix(names: Iterable[str]) -> str:
    """Return the top-level dir prefix npm tarballs ship under.

    npm tarballs nest content under ``package/``. Fall back to "" when
    the prefix is absent so we still find package.json at the root.
    """
    for name in names:
        head = name.split("/", 1)[0]
        if head == "package":
            return "package/"
    return ""


def _read_package_json(
    tf: tarfile.TarFile, members: list[tarfile.TarInfo], root_prefix: str
) -> dict[str, Any]:
    """Read and parse ``<root>/package.json`` statically. {} on any failure."""
    target = f"{root_prefix}package.json"
    for member in members:
        if member.name == target or member.name == "package.json":
            if not member.isfile():
                continue
            if member.size > MAX_FILE_BYTES:
                logger.debug("package.json over cap, skipping: %s", member.name)
                continue
            try:
                fh = tf.extractfile(member)
                if fh is None:
                    continue
                raw = fh.read()
            except (OSError, tarfile.TarError) as exc:
                logger.debug("package.json read failed: %s", exc)
                continue
            text = _decode(raw)
            if not text:
                continue
            try:
                parsed = json.loads(text)
            except json.JSONDecodeError as exc:
                logger.debug("package.json parse failed: %s", exc)
                return {}
            if isinstance(parsed, dict):
                return parsed
    return {}


def extract_artifact_features(
    tf: tarfile.TarFile,
    *,
    package: str,
    version: str,
    bucket: str,
) -> dict[str, Any]:
    """Build the feature row for one already-opened tarfile.

    Pure-static: iterates ``getmembers()`` behind the reject filter,
    reads ``package/package.json``, walks textual files in-memory,
    applies ``_detect_caps_in_text`` per file plus
    ``_detect_lifecycle_script_delta`` on the parsed scripts, and
    computes file_count plus a corpus-level entropy aggregate.

    No disk writes, no execution. The caller owns opening / closing the
    tarfile so this is trivially testable against a synthetic archive.
    """
    try:
        all_members = tf.getmembers()
    except tarfile.TarError as exc:
        logger.warning("getmembers failed for %s@%s: %s", package, version, exc)
        all_members = []

    safe_members = [m for m in all_members if _member_is_safe(m)]
    rejected = len(all_members) - len(safe_members)
    file_members = [m for m in safe_members if m.isfile()]
    file_count = len(file_members)

    root_prefix = _package_root_prefix(m.name for m in safe_members)
    pkg_json = _read_package_json(tf, safe_members, root_prefix)

    scripts = pkg_json.get("scripts") if isinstance(pkg_json.get("scripts"), dict) else {}
    lifecycle_hooks_present = [h for h in _INSTALL_HOOKS if h in scripts and scripts.get(h)]
    has_install_script = bool(lifecycle_hooks_present)
    lifecycle_script_bodies = {
        h: str(scripts.get(h))[:280] for h in lifecycle_hooks_present
    }

    deps = pkg_json.get("dependencies") if isinstance(pkg_json.get("dependencies"), dict) else {}
    dev_deps = (
        pkg_json.get("devDependencies")
        if isinstance(pkg_json.get("devDependencies"), dict)
        else {}
    )

    # Capability signals start all-false so every row is directly comparable.
    capability_signals = {k: False for k in _CAPABILITY_KEYS}
    capability_deltas: list[dict[str, Any]] = []
    seen_caps: set[str] = set()

    # The detector consumes "added text". For a cold tarball scan there is
    # no diff, so the whole file body is the added text.
    entropy_total = 0.0
    entropy_files = 0
    for member in file_members:
        if not _is_textual(member.name):
            continue
        if member.size > MAX_FILE_BYTES:
            continue
        try:
            fh = tf.extractfile(member)
            if fh is None:
                continue
            raw = fh.read()
        except (OSError, tarfile.TarError) as exc:
            logger.debug("read failed for %s: %s", member.name, exc)
            continue
        entropy_total += _shannon_entropy(raw)
        entropy_files += 1
        text = _decode(raw)
        if not text:
            continue
        rel = member.name
        if root_prefix and rel.startswith(root_prefix):
            rel = rel[len(root_prefix):]
        caps = _detect_caps_in_text(text, rel, f"ev.file.{member.name}")
        for cap in caps:
            key = cap.get("capability")
            if isinstance(key, str) and key in capability_signals:
                capability_signals[key] = True
            if isinstance(key, str) and key not in seen_caps:
                seen_caps.add(key)
                capability_deltas.append(cap)

    # Lifecycle script presence is a capability signal in its own right.
    # Treat any present install hook as a "before: none -> after: present"
    # delta so the existing detector emits the canonical lifecycle row.
    if has_install_script:
        capability_signals["lifecycle_script"] = True
        pkg_changes = {
            "before": {"scripts": {}},
            "after": {"scripts": dict(scripts)},
        }
        lifecycle_delta = _detect_lifecycle_script_delta(
            pkg_changes, "ev.pkg.scripts.001"
        )
        if lifecycle_delta is not None and "lifecycle_script" not in seen_caps:
            seen_caps.add("lifecycle_script")
            capability_deltas.append(lifecycle_delta)

    avg_entropy = round(entropy_total / entropy_files, 4) if entropy_files else 0.0

    return {
        "schema_version": SCHEMA_VERSION,
        "package": package or str(pkg_json.get("name") or ""),
        "version": version or str(pkg_json.get("version") or ""),
        "bucket": bucket,
        "file_count": file_count,
        "rejected_members": rejected,
        "has_install_script": has_install_script,
        "lifecycle_hooks_present": lifecycle_hooks_present,
        "lifecycle_script_bodies": lifecycle_script_bodies,
        "capability_signals": capability_signals,
        "capability_deltas": capability_deltas,
        "entropy": avg_entropy,
        "package_json_summary": {
            "has_install_script": has_install_script,
            "dep_count": len(deps),
            "dev_dep_count": len(dev_deps),
        },
    }


def _tgz_sha256(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as fh:
        for chunk in iter(lambda: fh.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def _resolve_artifact_path(
    artifact: Mapping[str, Any], corpus_root: Path | None
) -> Path | None:
    """Resolve the local .tgz path for an artifact-index row.

    Honors an absolute ``path`` directly; otherwise joins a relative
    ``path`` under ``corpus_root``. Returns None when no path field is
    present.
    """
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
    max_artifacts: int | None,
    max_tarball_bytes: int,
    local_corpus_only: bool,
) -> dict[str, Any]:
    """Scan every artifact in the index, write tarball-features.jsonl.

    ``local_corpus_only`` is accepted for parity with the other corpus
    scripts; this extractor is local-only by construction (it never
    contacts a registry), so the flag only documents intent and is
    recorded in the manifest.
    """
    output_path.parent.mkdir(parents=True, exist_ok=True)

    counters: Counter[str] = Counter()
    # Per-bucket capability-signal tallies for the headline distribution.
    bucket_signal: dict[str, Counter[str]] = {}
    bucket_total: Counter[str] = Counter()

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

            package = str(artifact.get("package") or "")
            version = str(artifact.get("version") or "")
            bucket = str(artifact.get("bucket") or "unknown")

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
                tgz_sha256 = _tgz_sha256(path)
                with tarfile.open(path, mode="r:*") as tf:
                    row = extract_artifact_features(
                        tf, package=package, version=version, bucket=bucket
                    )
            except (tarfile.TarError, OSError) as exc:
                logger.warning("tar open failed for %s: %s", path, exc)
                counters["skip:tar_corrupt"] += 1
                continue

            row["path"] = str(path)
            row["tgz_sha256"] = tgz_sha256
            row["advisory_ids"] = list(artifact.get("advisory_ids") or [])
            row["case_ids"] = list(artifact.get("case_ids") or [])

            out_fh.write(json.dumps(row) + "\n")
            written += 1
            counters["written"] += 1

            tally = bucket_signal.setdefault(bucket, Counter())
            bucket_total[bucket] += 1
            for key, present in row["capability_signals"].items():
                if present:
                    tally[key] += 1

            if max_artifacts is not None and written >= max_artifacts:
                break

    distribution = {
        bucket: {
            "artifacts": bucket_total[bucket],
            "signals": dict(bucket_signal.get(bucket, Counter())),
        }
        for bucket in sorted(bucket_total)
    }

    manifest = {
        "index_path": str(index_path),
        "output_path": str(output_path),
        "corpus_root": str(corpus_root) if corpus_root else None,
        "local_corpus_only": local_corpus_only,
        "written": written,
        "counters": dict(counters),
        "capability_distribution": distribution,
    }
    return manifest


def _print_distribution(manifest: Mapping[str, Any]) -> None:
    dist = manifest.get("capability_distribution") or {}
    print("\nCapability-signal distribution by bucket")
    print("=" * 48)
    for bucket, info in dist.items():
        total = info.get("artifacts", 0)
        print(f"\n[{bucket}]  {total} artifacts")
        signals = info.get("signals") or {}
        if not signals:
            print("  (no capability signals detected)")
            continue
        for key in _CAPABILITY_KEYS:
            count = signals.get(key, 0)
            pct = (100.0 * count / total) if total else 0.0
            print(f"  {key:<28} {count:>6}  ({pct:5.1f}%)")


def _build_arg_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        description="Static feature extraction over the ZeroToOne tarball corpus."
    )
    p.add_argument(
        "--artifact-index",
        type=Path,
        default=Path("finetune/corpus/artifact-index.jsonl"),
        help="Path to artifact-index.jsonl.",
    )
    p.add_argument(
        "--output",
        type=Path,
        default=Path("finetune/corpus/tarball-features.jsonl"),
        help="Path to write tarball-features.jsonl.",
    )
    p.add_argument(
        "--corpus-root",
        type=Path,
        default=None,
        help="Root dir for resolving relative artifact paths. Absolute "
        "paths in the index are used as-is.",
    )
    p.add_argument("--max-artifacts", type=int, default=None)
    p.add_argument(
        "--max-tarball-bytes",
        type=int,
        default=MAX_TARBALL_BYTES,
        help="Per-tarball byte cap. Default 50 MiB.",
    )
    p.add_argument(
        "--local-corpus-only",
        action="store_true",
        help="Document intent: never touch a registry. This extractor is "
        "local-only by construction; the flag is recorded in the manifest.",
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
        max_artifacts=args.max_artifacts,
        max_tarball_bytes=args.max_tarball_bytes,
        local_corpus_only=args.local_corpus_only,
    )
    _print_distribution(manifest)
    print("\n" + json.dumps({"manifest": {k: v for k, v in manifest.items() if k != "capability_distribution"}}, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
