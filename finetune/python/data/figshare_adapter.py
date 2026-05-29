"""Map the figshare NPM-malware dataset into ModuleWarden scraped_case.v1 JSONL.

Dataset (TASK-32, decision-5, verified):

- arXiv:2603.27549 "Understanding NPM Malicious Package Detection"
- figshare DOI 10.6084/m9.figshare.31869370
- 13,708 labeled packages (6,420 malicious + 7,288 benign)
- ~6.55 GB across 3 ZIPs, CC BY 4.0 (paper PDF says CC0; attribute to be safe)

The dataset is NOT downloaded in this repo. This adapter is built to run the
moment the data lands, and it import-and-runs today against a tiny synthetic
sample (see ``synthetic_records`` / the pytest) so there is no 6.55 GB
dependency for development.

Label mapping (per TASK-32 + decision-5):

- malicious -> case_type "incident_replay"
- benign    -> case_type "benign_neighbor"

Provenance: the scraped_case.v1 schema ``source`` enum is closed
(github_advisory, osv, npm_packument, manual) with additionalProperties:false,
so there is no literal "figshare" source value. The honest mapping is
``source = "manual"`` (a curated research corpus, not a live advisory/registry
feed). The figshare provenance is recorded explicitly in:

- ``case_id`` prefix ``figshare_...``
- a ``references`` entry pointing at the figshare DOI
- the ``summary`` text naming the dataset

SAFETY

This adapter reads dataset METADATA and LABELS only (JSON/CSV). It never
executes, imports, installs, or evaluates any package. If a figshare record
embeds package source code, this adapter only reads it as TEXT for length /
presence signals; it is never run. Static analysis only. No network access:
the input path is a local directory or file, never a URL.
"""

from __future__ import annotations

import argparse
import csv
import json
import logging
import re
from collections.abc import Iterable, Iterator, Mapping
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

logger = logging.getLogger("modulewarden.figshare_adapter")

SCHEMA_VERSION = "modulewarden.scraped_case.v1"

# Figshare provenance constants (verified in decision-5 / TASK-32).
FIGSHARE_DOI = "10.6084/m9.figshare.31869370"
FIGSHARE_DOI_URL = "https://doi.org/10.6084/m9.figshare.31869370"
FIGSHARE_ARXIV = "arXiv:2603.27549"
DATASET_NAME = "Understanding NPM Malicious Package Detection (figshare)"

# Binary label -> scraped_case.v1 case_type. The figshare dataset is a labeled
# corpus, so each record carries a ground-truth class; that class drives the
# case_type field rather than any inferred severity.
_LABEL_TO_CASE_TYPE: dict[str, str] = {
    "malicious": "incident_replay",
    "benign": "benign_neighbor",
}

# Accepted aliases for the two label classes, normalized to the canonical key.
# Kept generous because the exact figshare column has not been inspected yet
# (the 6.55 GB download is deferred). Unknown labels are skipped, not guessed.
_LABEL_ALIASES: dict[str, str] = {
    "malicious": "malicious",
    "malware": "malicious",
    "mal": "malicious",
    "1": "malicious",
    "true": "malicious",
    "positive": "malicious",
    "benign": "benign",
    "clean": "benign",
    "safe": "benign",
    "0": "benign",
    "false": "benign",
    "negative": "benign",
}

# Field-name candidates we probe, in order, when the figshare record schema is
# not yet pinned down. First non-empty match wins.
_NAME_KEYS = ("package", "package_name", "name", "pkg", "pkg_name")
_VERSION_KEYS = ("version", "package_version", "ver")
_LABEL_KEYS = ("label", "class", "category", "is_malicious", "malicious", "type")

_INVALID_CASE_ID_CHARS = re.compile(r"[^a-zA-Z0-9]+")


def _first(record: Mapping[str, Any], keys: Iterable[str]) -> Any:
    for key in keys:
        if key in record and record[key] not in (None, ""):
            return record[key]
    return None


def _normalize_label(raw: Any) -> str | None:
    """Map a raw figshare label to "malicious" / "benign", or None if unknown."""
    if raw is None:
        return None
    if isinstance(raw, bool):
        return "malicious" if raw else "benign"
    text = str(raw).strip().lower()
    return _LABEL_ALIASES.get(text)


def _case_id(label: str, package: str, ordinal: int) -> str:
    safe_pkg = _INVALID_CASE_ID_CHARS.sub("_", package).strip("_") or "pkg"
    parts = ["figshare", label, safe_pkg, str(ordinal)]
    joined = "_".join(parts)
    joined = re.sub(r"_+", "_", joined).strip("_")
    return joined


def map_record(
    record: Mapping[str, Any],
    *,
    ordinal: int,
    scraped_at: str,
) -> dict[str, Any] | None:
    """Map one figshare record to a scraped_case.v1 dict, or None to skip.

    Returns None (and logs at debug) for malformed records: missing package
    name, or a label that does not resolve to malicious/benign. Skipping keeps
    the emitted corpus honest - we never guess a class for an ambiguous row.
    """
    if not isinstance(record, Mapping):
        logger.debug("skip ordinal=%s: not a mapping", ordinal)
        return None

    package = _first(record, _NAME_KEYS)
    if not package or not str(package).strip():
        logger.debug("skip ordinal=%s: missing package name", ordinal)
        return None
    package = str(package).strip()

    label = _normalize_label(_first(record, _LABEL_KEYS))
    if label is None:
        logger.debug("skip ordinal=%s pkg=%s: unresolved label", ordinal, package)
        return None

    case_type = _LABEL_TO_CASE_TYPE[label]

    version = _first(record, _VERSION_KEYS)
    candidate_versions: list[dict[str, Any]] = []
    benign_neighbor_versions: list[dict[str, Any]] = []
    if version and str(version).strip():
        version = str(version).strip()
        entry = {"role": "unknown", "version": version, "published_at": None}
        if label == "malicious":
            entry["role"] = "likely_affected"
            candidate_versions.append(entry)
        else:
            entry["role"] = "benign_before"
            benign_neighbor_versions.append(entry)

    summary = (
        f"{label.capitalize()} npm package from the figshare dataset "
        f"{DATASET_NAME} ({FIGSHARE_ARXIV}, DOI {FIGSHARE_DOI})."
    )

    references = [FIGSHARE_DOI_URL]
    extra_ref = _first(record, ("url", "reference", "source_url"))
    if extra_ref and str(extra_ref).strip():
        references.append(str(extra_ref).strip())

    return {
        "schema_version": SCHEMA_VERSION,
        "case_id": _case_id(label, package, ordinal),
        # Closed enum; figshare is a curated research corpus, mapped to "manual".
        "source": "manual",
        "case_type": case_type,
        "package": package,
        "advisory_ids": [],
        "severity": "critical" if label == "malicious" else None,
        "summary": summary,
        "cwes": [],
        "affected_range": None,
        "first_patched_version": None,
        "candidate_versions": candidate_versions,
        "benign_neighbor_versions": benign_neighbor_versions,
        "references": references,
        "source_code_location": None,
        "npm": None,
        "osv_ids": [],
        # The corpus is labeled but not version-enriched yet, so it lands as a
        # candidate for the downstream corpus_walker to enrich.
        "triage_status": "candidate",
        "scraped_at": scraped_at,
    }


def _iter_input_records(path: Path) -> Iterator[Mapping[str, Any]]:
    """Yield raw records from a figshare metadata file or directory.

    Supports:

    - ``.jsonl`` / ``.ndjson``: one JSON object per line
    - ``.json``: a top-level list, or a dict with a list under a common key
    - ``.csv``: header row + rows
    - a directory: recurse into the above file types

    Malformed individual lines are skipped with a warning; a whole unreadable
    file is logged and skipped.
    """
    if path.is_dir():
        for child in sorted(path.rglob("*")):
            if child.is_file() and child.suffix.lower() in (
                ".jsonl",
                ".ndjson",
                ".json",
                ".csv",
            ):
                yield from _iter_input_records(child)
        return

    suffix = path.suffix.lower()
    try:
        if suffix in (".jsonl", ".ndjson"):
            with path.open("r", encoding="utf-8") as fh:
                for line in fh:
                    stripped = line.strip()
                    if not stripped:
                        continue
                    try:
                        rec = json.loads(stripped)
                    except json.JSONDecodeError as exc:
                        logger.warning("skip malformed JSONL line in %s: %s", path, exc)
                        continue
                    if isinstance(rec, Mapping):
                        yield rec
        elif suffix == ".json":
            data = json.loads(path.read_text(encoding="utf-8"))
            records = _coerce_json_to_records(data)
            for rec in records:
                if isinstance(rec, Mapping):
                    yield rec
        elif suffix == ".csv":
            with path.open("r", encoding="utf-8", newline="") as fh:
                reader = csv.DictReader(fh)
                for rec in reader:
                    yield rec
        else:
            logger.warning("unsupported input file type, skipping: %s", path)
    except (OSError, json.JSONDecodeError) as exc:
        logger.warning("skip unreadable file %s: %s", path, exc)


def _coerce_json_to_records(data: Any) -> list[Any]:
    if isinstance(data, list):
        return data
    if isinstance(data, Mapping):
        for key in ("records", "packages", "data", "items", "rows"):
            value = data.get(key)
            if isinstance(value, list):
                return value
        # A single record object.
        return [data]
    return []


def convert(
    records: Iterable[Mapping[str, Any]],
    *,
    scraped_at: str | None = None,
) -> Iterator[dict[str, Any]]:
    """Map raw figshare records to scraped_case.v1 dicts.

    Skips malformed records and de-duplicates on the semantic identity
    (case_type + package + version), so a package repeated in the source is
    emitted once. The ordinal is the running INPUT index and only feeds the
    case_id to keep ids unique across genuinely distinct rows of the same
    package; it is not part of the dedup key.
    """
    if scraped_at is None:
        scraped_at = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")

    seen: set[tuple[str, str, str]] = set()
    for ordinal, record in enumerate(records):
        mapped = map_record(record, ordinal=ordinal, scraped_at=scraped_at)
        if mapped is None:
            continue
        versions = mapped["candidate_versions"] or mapped["benign_neighbor_versions"]
        version = versions[0]["version"] if versions else ""
        dedup_key = (mapped["case_type"], mapped["package"], version)
        if dedup_key in seen:
            logger.debug("skip duplicate %s", dedup_key)
            continue
        seen.add(dedup_key)
        yield mapped


def convert_path(
    input_path: str | Path,
    *,
    scraped_at: str | None = None,
) -> Iterator[dict[str, Any]]:
    """Read a figshare metadata path and yield scraped_case.v1 dicts."""
    path = Path(input_path)
    if not path.exists():
        raise FileNotFoundError(f"figshare input path not found: {path}")
    yield from convert(_iter_input_records(path), scraped_at=scraped_at)


def write_jsonl(
    input_path: str | Path,
    output_path: str | Path,
    *,
    scraped_at: str | None = None,
) -> int:
    """Convert a figshare path to scraped_case.v1 JSONL. Returns count written."""
    out = Path(output_path)
    out.parent.mkdir(parents=True, exist_ok=True)
    count = 0
    with out.open("w", encoding="utf-8") as fh:
        for case in convert_path(input_path, scraped_at=scraped_at):
            fh.write(json.dumps(case, ensure_ascii=False) + "\n")
            count += 1
    return count


def synthetic_records() -> list[dict[str, Any]]:
    """A tiny in-memory sample in figshare-like shape, for import-time tests.

    Two valid (one malicious, one benign), one malformed (no name), one
    duplicate of the malicious package, and one unknown-label row. This lets the
    adapter import-and-run today with no 6.55 GB download.
    """
    return [
        {"package_name": "left-pad-stealer", "version": "1.0.0", "label": "malicious"},
        {"package_name": "is-even", "version": "1.0.0", "label": "benign"},
        {"version": "9.9.9", "label": "malicious"},  # malformed: no name -> skip
        {"package_name": "left-pad-stealer", "version": "1.0.0", "label": "malicious"},  # dup
        {"package_name": "mystery-pkg", "version": "0.1.0", "label": "uncertain"},  # unknown -> skip
    ]


def _build_arg_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description=(
            "Map the figshare NPM-malware dataset (DOI "
            f"{FIGSHARE_DOI}) into scraped_case.v1 JSONL. Reads metadata/labels "
            "only; never executes any package."
        )
    )
    parser.add_argument(
        "input",
        nargs="?",
        help="Path to the downloaded figshare metadata file or directory.",
    )
    parser.add_argument(
        "-o",
        "--output",
        help="Output JSONL path. Defaults to stdout.",
    )
    parser.add_argument(
        "--scraped-at",
        help="Override the scraped_at timestamp (ISO 8601). Defaults to now.",
    )
    parser.add_argument(
        "--self-test",
        action="store_true",
        help="Run against the built-in synthetic sample (no download needed).",
    )
    return parser


def main(argv: list[str] | None = None) -> int:
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s")
    args = _build_arg_parser().parse_args(argv)

    if args.self_test:
        cases = list(convert(synthetic_records(), scraped_at=args.scraped_at))
        for case in cases:
            print(json.dumps(case, ensure_ascii=False))
        logger.info("self-test emitted %d scraped_case.v1 records", len(cases))
        return 0

    if not args.input:
        _build_arg_parser().error("input path is required unless --self-test is given")

    if args.output:
        count = write_jsonl(args.input, args.output, scraped_at=args.scraped_at)
        logger.info("wrote %d scraped_case.v1 records to %s", count, args.output)
    else:
        count = 0
        for case in convert_path(args.input, scraped_at=args.scraped_at):
            print(json.dumps(case, ensure_ascii=False))
            count += 1
        logger.info("emitted %d scraped_case.v1 records", count)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
