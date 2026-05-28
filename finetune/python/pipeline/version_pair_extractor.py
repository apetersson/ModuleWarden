"""Version-pair extractor: fetch unpatched + patched npm tarballs, diff them.

For one ModuleWarden ``scraped-case.v1`` record, this module fetches both the
likely-affected version and the first-patched version from the npm registry,
safely extracts both tarballs, walks the trees, and computes a structural
diff that becomes the training signal for apiary's audit model.

Pipeline position::

    scrape-cases.mjs -> scraped-cases.jsonl  (Andreas's TS scraper)
    scraped_case_adapter.py                  (metadata-only SFT)
    version_pair_extractor.py  <-- THIS      (code + diff)
    raw_format_builder.py                    (classification-head)
    agentic_format_builder.py                (tool-use SFT)
    sft_lora.py                              (H100 fine-tune)

Safety:

- Hostname allowlist (``registry.npmjs.org``, ``registry.yarnpkg.com``)
  mirrors the SSRF guard in ``modulewarden_gate/gate.py``.
- Tarball extraction rejects absolute paths, ``..`` traversal, and
  symlink / hardlink members. We never call ``tarfile.extractall``.
- Tarballs over ``MAX_TARBALL_BYTES`` (default 50 MiB) are skipped.
- Each per-file unified diff is capped at ``MAX_DIFF_BYTES`` (default 50 KiB)
  to keep training records bounded.

npm registry rate limits:
    The public registry advertises roughly 50 requests/second per IP. We
    back off on HTTP 429 with exponential delay and cap concurrency at
    the value passed by the caller (default 6).
"""

from __future__ import annotations

import asyncio
import difflib
import hashlib
import io
import json
import logging
import os
import tarfile
import tempfile
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any, Iterator, Literal
from urllib.parse import urlparse

import httpx

logger = logging.getLogger("modulewarden.version_pair_extractor")

DEFAULT_REGISTRY = "https://registry.npmjs.org"
ALLOWED_TARBALL_HOSTS: frozenset[str] = frozenset(
    {"registry.npmjs.org", "registry.yarnpkg.com"}
)

MAX_TARBALL_BYTES = 50 * 1024 * 1024  # 50 MiB per tarball
MAX_DIFF_BYTES = 50 * 1024  # 50 KiB per file diff
MAX_FILE_BYTES = 2 * 1024 * 1024  # 2 MiB per file before we treat as binary
DEFAULT_REQUEST_TIMEOUT = 60.0
MAX_RETRIES_ON_429 = 4

# File extensions worth diffing for the training signal. We skip large
# binary blobs (.png, .woff, model checkpoints) that would either dwarf
# the diff payload or produce no useful textual signal.
TEXTUAL_EXTENSIONS: frozenset[str] = frozenset(
    {
        ".js",
        ".mjs",
        ".cjs",
        ".jsx",
        ".ts",
        ".tsx",
        ".json",
        ".yaml",
        ".yml",
        ".md",
        ".txt",
        ".html",
        ".css",
        ".sh",
        ".py",
        ".coffee",
        ".vue",
        ".d.ts",
    }
)


@dataclass
class FileChange:
    """One file's diff between unpatched and patched versions."""

    path: str
    change_kind: Literal["added", "removed", "modified"]
    added_lines: int
    removed_lines: int
    unified_diff: str
    file_size_before: int
    file_size_after: int


@dataclass
class VersionPair:
    """Extracted code + diff for one GHSA case."""

    package: str
    unpatched_version: str
    patched_version: str
    advisory_ids: list[str]
    severity: str
    file_changes: list[FileChange]
    package_json_changes: dict[str, Any]
    extraction_method: str
    notes: list[str] = field(default_factory=list)

    def to_json_dict(self) -> dict[str, Any]:
        """Round-trip dataclass to plain dict for JSON serialization."""
        return {
            "package": self.package,
            "unpatched_version": self.unpatched_version,
            "patched_version": self.patched_version,
            "advisory_ids": list(self.advisory_ids),
            "severity": self.severity,
            "file_changes": [asdict(fc) for fc in self.file_changes],
            "package_json_changes": dict(self.package_json_changes),
            "extraction_method": self.extraction_method,
            "notes": list(self.notes),
        }


class ExtractionError(Exception):
    """Raised when extraction cannot proceed for a case."""


def _validate_tarball_url(url: str) -> None:
    """Reject any tarball URL whose host is not in the allowlist.

    Mirrors the SSRF guard pattern in ``modulewarden_gate/gate.py``.
    """
    parsed = urlparse(url)
    if parsed.scheme not in ("http", "https"):
        raise ExtractionError(f"unsupported tarball scheme: {parsed.scheme!r}")
    host = (parsed.hostname or "").lower()
    if not host:
        raise ExtractionError("tarball URL has no host")
    if host not in ALLOWED_TARBALL_HOSTS:
        raise ExtractionError(
            f"tarball host {host!r} not in allowlist {sorted(ALLOWED_TARBALL_HOSTS)}"
        )


def _safe_tar_extract(archive_path: Path, dest: Path) -> int:
    """Extract a tarball into ``dest`` rejecting any path-traversal members.

    Returns the count of members extracted. We never call
    ``tarfile.extractall`` because it does not validate member names
    before writing them. Members that fail validation are logged and
    skipped (not raised) so a single bad entry does not kill the pair.
    """
    dest = dest.resolve()
    dest.mkdir(parents=True, exist_ok=True)
    n_ok = 0
    with tarfile.open(archive_path, mode="r:*") as tf:
        for member in tf.getmembers():
            name = member.name
            if not name or name.startswith("/") or os.path.isabs(name):
                logger.debug("skipping absolute tarball member: %s", name)
                continue
            if ".." in Path(name).parts:
                logger.debug("skipping traversal tarball member: %s", name)
                continue
            if member.issym() or member.islnk():
                logger.debug("skipping link tarball member: %s", name)
                continue
            target = (dest / name).resolve()
            try:
                target.relative_to(dest)
            except ValueError:
                logger.debug("skipping out-of-tree tarball member: %s", name)
                continue
            try:
                tf.extract(member, dest)
                n_ok += 1
            except (OSError, tarfile.TarError) as exc:
                logger.debug("extract failed for %s: %s", name, exc)
    return n_ok


async def _fetch_packument(
    client: httpx.AsyncClient, package: str, registry: str
) -> dict[str, Any]:
    """Fetch the npm packument for a package.

    The packument carries the version map with tarball URLs and integrity
    hashes for every published version, which is everything we need to
    pull a specific version's archive.
    """
    from urllib.parse import quote

    encoded = quote(package, safe="@/")
    url = f"{registry.rstrip('/')}/{encoded}"
    backoff = 1.0
    for attempt in range(MAX_RETRIES_ON_429):
        try:
            resp = await client.get(url, headers={"Accept": "application/json"})
        except httpx.HTTPError as exc:
            raise ExtractionError(f"packument fetch failed: {exc}") from exc
        if resp.status_code == 404:
            raise ExtractionError(f"package {package!r} not on registry")
        if resp.status_code == 429:
            logger.warning(
                "rate limited on packument for %s, backoff %.1fs", package, backoff
            )
            await asyncio.sleep(backoff)
            backoff *= 2
            continue
        if resp.status_code >= 400:
            raise ExtractionError(
                f"packument upstream {resp.status_code} for {package}"
            )
        try:
            return resp.json()
        except json.JSONDecodeError as exc:
            raise ExtractionError(f"packument non-JSON: {exc}") from exc
    raise ExtractionError(f"packument rate-limited after {MAX_RETRIES_ON_429} retries")


def _tarball_url_for(packument: dict[str, Any], version: str) -> str:
    versions = packument.get("versions") or {}
    if version not in versions:
        raise ExtractionError(f"version {version!r} not in packument")
    block = versions[version]
    if not isinstance(block, dict):
        raise ExtractionError(f"versions[{version}] is not an object")
    dist = block.get("dist") or {}
    if not isinstance(dist, dict):
        raise ExtractionError(f"versions[{version}].dist is not an object")
    url = dist.get("tarball")
    if not isinstance(url, str) or not url:
        raise ExtractionError(f"versions[{version}].dist.tarball missing")
    return url


def _integrity_for(packument: dict[str, Any], version: str) -> str | None:
    block = (packument.get("versions") or {}).get(version) or {}
    dist = block.get("dist") if isinstance(block, dict) else None
    if isinstance(dist, dict):
        integrity = dist.get("integrity")
        if isinstance(integrity, str):
            return integrity
    return None


async def _download_tarball(
    client: httpx.AsyncClient, url: str, dest: Path, max_bytes: int
) -> int:
    """Stream a tarball to disk with a hard byte cap.

    Returns bytes written. Raises ``ExtractionError`` if the cap is
    exceeded mid-stream so we abort the case instead of consuming
    unbounded disk.
    """
    _validate_tarball_url(url)
    backoff = 1.0
    for attempt in range(MAX_RETRIES_ON_429):
        try:
            async with client.stream("GET", url) as resp:
                if resp.status_code == 429:
                    logger.warning(
                        "rate limited on tarball %s, backoff %.1fs", url, backoff
                    )
                    await asyncio.sleep(backoff)
                    backoff *= 2
                    continue
                if resp.status_code >= 400:
                    raise ExtractionError(
                        f"tarball upstream {resp.status_code} for {url}"
                    )
                size = 0
                with dest.open("wb") as fh:
                    async for chunk in resp.aiter_bytes(chunk_size=64 * 1024):
                        size += len(chunk)
                        if size > max_bytes:
                            raise ExtractionError(
                                f"tarball exceeds {max_bytes} bytes: {url}"
                            )
                        fh.write(chunk)
                return size
        except httpx.HTTPError as exc:
            raise ExtractionError(f"tarball stream failed: {exc}") from exc
    raise ExtractionError(f"tarball rate-limited after {MAX_RETRIES_ON_429} retries")


def _npm_root(extract_dir: Path) -> Path:
    """Return the top-level package directory inside an extracted npm tarball.

    npm tarballs ship contents under a ``package/`` prefix. If that prefix
    is missing for some reason we fall back to the extract dir itself.
    """
    candidate = extract_dir / "package"
    if candidate.is_dir():
        return candidate
    children = [p for p in extract_dir.iterdir() if p.is_dir()]
    if len(children) == 1:
        return children[0]
    return extract_dir


def _walk_textual_files(root: Path) -> Iterator[tuple[str, Path]]:
    """Yield (relative_path, absolute_path) for files we care about diffing.

    We restrict to TEXTUAL_EXTENSIONS plus a small allowlist of well-known
    no-extension files so binaries (icons, fonts, model weights bundled
    into the package) do not enter the diff payload.
    """
    no_ext_allowlist = {"LICENSE", "README", "Makefile", "CHANGELOG"}
    for path in root.rglob("*"):
        if not path.is_file():
            continue
        rel = path.relative_to(root).as_posix()
        suffix = path.suffix.lower()
        name = path.name
        if suffix in TEXTUAL_EXTENSIONS or name in no_ext_allowlist:
            yield rel, path


def _read_text_safely(path: Path) -> tuple[str, int]:
    """Read a file as text. Returns (text, byte_size). Cap at MAX_FILE_BYTES."""
    try:
        size = path.stat().st_size
    except OSError:
        return "", 0
    if size > MAX_FILE_BYTES:
        return "", size
    try:
        raw = path.read_bytes()
    except OSError:
        return "", size
    try:
        return raw.decode("utf-8"), size
    except UnicodeDecodeError:
        try:
            return raw.decode("latin-1"), size
        except UnicodeDecodeError:
            return "", size


def _unified_diff_for(
    path_str: str,
    before_text: str,
    after_text: str,
) -> tuple[str, int, int]:
    """Compute the unified diff plus added / removed line counts."""
    before_lines = before_text.splitlines(keepends=True)
    after_lines = after_text.splitlines(keepends=True)
    diff_iter = difflib.unified_diff(
        before_lines,
        after_lines,
        fromfile=f"a/{path_str}",
        tofile=f"b/{path_str}",
        n=3,
    )
    pieces: list[str] = []
    total = 0
    added = 0
    removed = 0
    for piece in diff_iter:
        if piece.startswith("+") and not piece.startswith("+++"):
            added += 1
        elif piece.startswith("-") and not piece.startswith("---"):
            removed += 1
        if total + len(piece) > MAX_DIFF_BYTES:
            pieces.append(f"\n... [diff truncated at {MAX_DIFF_BYTES} bytes] ...\n")
            break
        pieces.append(piece)
        total += len(piece)
    return "".join(pieces), added, removed


def _package_json_changes(before_root: Path, after_root: Path) -> dict[str, Any]:
    """Capture before/after for package.json lifecycle scripts + deps.

    These are the fields most relevant to Class A compromised-maintainer
    attacks: an attacker who bumps a version typically modifies install
    scripts or pulls in a malicious transitive dependency.
    """
    def _load(p: Path) -> dict[str, Any]:
        f = p / "package.json"
        if not f.is_file():
            return {}
        try:
            return json.loads(f.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            return {}

    before = _load(before_root)
    after = _load(after_root)

    def _slice(d: dict[str, Any]) -> dict[str, Any]:
        scripts = d.get("scripts") if isinstance(d.get("scripts"), dict) else {}
        return {
            "scripts": {
                hook: scripts.get(hook)
                for hook in (
                    "preinstall",
                    "install",
                    "postinstall",
                    "preuninstall",
                    "postuninstall",
                )
                if hook in scripts
            },
            "dependencies": d.get("dependencies") or {},
            "devDependencies": d.get("devDependencies") or {},
            "optionalDependencies": d.get("optionalDependencies") or {},
            "repository": d.get("repository"),
            "version": d.get("version"),
        }

    return {
        "before": _slice(before),
        "after": _slice(after),
    }


def _diff_trees(before_root: Path, after_root: Path) -> list[FileChange]:
    """Compute file-level diff across two extracted npm trees."""
    before_files = dict(_walk_textual_files(before_root))
    after_files = dict(_walk_textual_files(after_root))

    all_rel = sorted(set(before_files) | set(after_files))
    changes: list[FileChange] = []
    for rel in all_rel:
        before_path = before_files.get(rel)
        after_path = after_files.get(rel)
        if before_path is None and after_path is not None:
            text, size = _read_text_safely(after_path)
            diff_text, added, removed = _unified_diff_for(rel, "", text)
            changes.append(
                FileChange(
                    path=rel,
                    change_kind="added",
                    added_lines=added,
                    removed_lines=removed,
                    unified_diff=diff_text,
                    file_size_before=0,
                    file_size_after=size,
                )
            )
        elif before_path is not None and after_path is None:
            text, size = _read_text_safely(before_path)
            diff_text, added, removed = _unified_diff_for(rel, text, "")
            changes.append(
                FileChange(
                    path=rel,
                    change_kind="removed",
                    added_lines=added,
                    removed_lines=removed,
                    unified_diff=diff_text,
                    file_size_before=size,
                    file_size_after=0,
                )
            )
        else:
            assert before_path is not None and after_path is not None
            before_text, before_size = _read_text_safely(before_path)
            after_text, after_size = _read_text_safely(after_path)
            if before_text == after_text:
                continue
            diff_text, added, removed = _unified_diff_for(
                rel, before_text, after_text
            )
            changes.append(
                FileChange(
                    path=rel,
                    change_kind="modified",
                    added_lines=added,
                    removed_lines=removed,
                    unified_diff=diff_text,
                    file_size_before=before_size,
                    file_size_after=after_size,
                )
            )
    return changes


def _pick_version_roles(case: dict[str, Any]) -> tuple[str | None, str | None]:
    """Pick (unpatched_version, patched_version) from a scraped-case record.

    Preference order for the unpatched side:
        1. first ``likely_affected`` entry in ``candidate_versions``
        2. None (the case cannot drive a diff)

    Preference order for the patched side:
        1. first ``first_patched`` entry in ``candidate_versions``
        2. top-level ``first_patched_version`` field
    """
    cvs = case.get("candidate_versions") or []
    unpatched: str | None = None
    patched: str | None = None
    for cv in cvs:
        role = cv.get("role")
        ver = cv.get("version")
        if not isinstance(ver, str) or not ver:
            continue
        if role == "likely_affected" and unpatched is None:
            unpatched = ver
        elif role == "first_patched" and patched is None:
            patched = ver
    if patched is None:
        fallback = case.get("first_patched_version")
        if isinstance(fallback, str) and fallback:
            patched = fallback
    return unpatched, patched


async def extract_one(
    case: dict[str, Any],
    client: httpx.AsyncClient,
    work_dir: Path,
    registry: str = DEFAULT_REGISTRY,
    max_tarball_bytes: int = MAX_TARBALL_BYTES,
) -> VersionPair:
    """Extract a VersionPair for one scraped-case.v1 record.

    On any non-recoverable failure (deleted package, version missing on
    npm, tarball over size cap) we return a VersionPair with an empty
    ``file_changes`` list and an ``extraction_method`` of
    ``skipped_*``. We never raise so the caller can persist the failure
    record and move on.
    """
    package = case.get("package") or "unknown"
    advisory_ids = list(case.get("advisory_ids") or [])
    severity = (case.get("severity") or "unknown") or "unknown"
    notes: list[str] = []

    unpatched, patched = _pick_version_roles(case)
    if not unpatched or not patched:
        return VersionPair(
            package=package,
            unpatched_version=unpatched or "",
            patched_version=patched or "",
            advisory_ids=advisory_ids,
            severity=severity,
            file_changes=[],
            package_json_changes={},
            extraction_method="skipped_missing_versions",
            notes=[
                "scraped-case lacks both likely_affected and first_patched roles"
            ],
        )
    if unpatched == patched:
        return VersionPair(
            package=package,
            unpatched_version=unpatched,
            patched_version=patched,
            advisory_ids=advisory_ids,
            severity=severity,
            file_changes=[],
            package_json_changes={},
            extraction_method="skipped_same_version",
            notes=["likely_affected and first_patched resolve to the same version"],
        )

    try:
        packument = await _fetch_packument(client, package, registry)
    except ExtractionError as exc:
        return VersionPair(
            package=package,
            unpatched_version=unpatched,
            patched_version=patched,
            advisory_ids=advisory_ids,
            severity=severity,
            file_changes=[],
            package_json_changes={},
            extraction_method="skipped_no_packument",
            notes=[str(exc)],
        )

    try:
        unpatched_url = _tarball_url_for(packument, unpatched)
        patched_url = _tarball_url_for(packument, patched)
    except ExtractionError as exc:
        return VersionPair(
            package=package,
            unpatched_version=unpatched,
            patched_version=patched,
            advisory_ids=advisory_ids,
            severity=severity,
            file_changes=[],
            package_json_changes={},
            extraction_method="skipped_no_tarball",
            notes=[str(exc)],
        )

    with tempfile.TemporaryDirectory(dir=str(work_dir)) as tmp:
        tmp_path = Path(tmp)
        unpatched_tgz = tmp_path / "unpatched.tgz"
        patched_tgz = tmp_path / "patched.tgz"
        unpatched_dir = tmp_path / "unpatched"
        patched_dir = tmp_path / "patched"

        try:
            up_size = await _download_tarball(
                client, unpatched_url, unpatched_tgz, max_tarball_bytes
            )
            pa_size = await _download_tarball(
                client, patched_url, patched_tgz, max_tarball_bytes
            )
        except ExtractionError as exc:
            return VersionPair(
                package=package,
                unpatched_version=unpatched,
                patched_version=patched,
                advisory_ids=advisory_ids,
                severity=severity,
                file_changes=[],
                package_json_changes={},
                extraction_method="skipped_tarball_oversize",
                notes=[str(exc)],
            )

        notes.append(f"unpatched_tarball_bytes={up_size}")
        notes.append(f"patched_tarball_bytes={pa_size}")
        up_integrity = _integrity_for(packument, unpatched) or ""
        pa_integrity = _integrity_for(packument, patched) or ""
        if up_integrity:
            notes.append(f"unpatched_integrity={up_integrity}")
        if pa_integrity:
            notes.append(f"patched_integrity={pa_integrity}")

        try:
            n_unpatched = _safe_tar_extract(unpatched_tgz, unpatched_dir)
            n_patched = _safe_tar_extract(patched_tgz, patched_dir)
        except tarfile.TarError as exc:
            return VersionPair(
                package=package,
                unpatched_version=unpatched,
                patched_version=patched,
                advisory_ids=advisory_ids,
                severity=severity,
                file_changes=[],
                package_json_changes={},
                extraction_method="skipped_tar_corrupt",
                notes=[str(exc)],
            )
        notes.append(f"unpatched_extracted_members={n_unpatched}")
        notes.append(f"patched_extracted_members={n_patched}")

        unpatched_root = _npm_root(unpatched_dir)
        patched_root = _npm_root(patched_dir)

        changes = _diff_trees(unpatched_root, patched_root)
        pkg_changes = _package_json_changes(unpatched_root, patched_root)

    return VersionPair(
        package=package,
        unpatched_version=unpatched,
        patched_version=patched,
        advisory_ids=advisory_ids,
        severity=severity,
        file_changes=changes,
        package_json_changes=pkg_changes,
        extraction_method="tarball_diff",
        notes=notes,
    )


def _tarball_sha256(blob: bytes) -> str:
    return hashlib.sha256(blob).hexdigest()


# Helper accessor for callers that want a single-shot synchronous extract.
def extract_one_sync(
    case: dict[str, Any],
    work_dir: Path | None = None,
    registry: str = DEFAULT_REGISTRY,
    max_tarball_bytes: int = MAX_TARBALL_BYTES,
    timeout: float = DEFAULT_REQUEST_TIMEOUT,
) -> VersionPair:
    """Sync wrapper around ``extract_one`` for one-off scripting use."""
    work_dir = work_dir or Path(tempfile.gettempdir())
    work_dir.mkdir(parents=True, exist_ok=True)

    async def _runner() -> VersionPair:
        async with httpx.AsyncClient(timeout=timeout) as client:
            return await extract_one(case, client, work_dir, registry, max_tarball_bytes)

    return asyncio.run(_runner())


__all__ = [
    "ALLOWED_TARBALL_HOSTS",
    "ExtractionError",
    "FileChange",
    "MAX_DIFF_BYTES",
    "MAX_TARBALL_BYTES",
    "VersionPair",
    "extract_one",
    "extract_one_sync",
]
