"""Pluggable static-scanner evidence enricher for the dossier pipeline.

Runs a set of external static analyzers over an already-extracted npm
package directory and folds their findings into the AuditDossier v1
evidence shape (``finetune/contracts/audit-dossier.schema.json``).

Four scanners are supported:

* Semgrep      - source-pattern scanning (SAST).
* OSV-Scanner  - known-vulnerability lookup over the lockfile / SBOM.
* TruffleHog   - secret / credential scanning over the file tree.
* Syft + Grype - SBOM generation followed by vuln matching over the SBOM.

CRITICAL design constraints:

* These tools are very likely NOT installed on a given machine. Every
  runner probes ``shutil.which`` first and degrades gracefully: it logs
  a note, emits a single ``scanner_skipped`` evidence row, and returns.
  No tool is ever installed, and a missing tool never raises.
* This is STATIC analysis only. The scanners read package FILES; they
  never install, never run lifecycle scripts, never execute package
  code. We invoke the trusted scanner binary directly via ``subprocess``
  with an argument list (never ``shell=True`` with package-controlled
  input) and a bounded per-tool timeout.
* No runner is ever allowed to raise into the calling pipeline. Any
  failure (timeout, non-JSON output, crash, OSError) is caught and
  recorded as a ``scanner_error`` evidence row.

The output of :func:`enrich_with_scanners` is a list of dicts, each of
which validates against the ``evidence`` ``$def`` in the dossier schema
(``id``, ``kind``, ``path``, ``summary``, ``raw_excerpt_available``).
Findings that map to a behavioural capability also produce a parallel
``capability_delta`` row via :func:`scanner_capability_deltas`, so
``dossier_builder`` can fold both in without re-parsing tool output.
"""

from __future__ import annotations

import json
import logging
import shutil
import subprocess
from typing import Any, Callable

logger = logging.getLogger("modulewarden.scanner_evidence")

# Per-tool wall-clock ceiling. Static scans over a single extracted
# package are fast; a tool that blows past this is misbehaving and we
# would rather skip it than stall the batch pipeline.
DEFAULT_TIMEOUT_SECONDS = 120

# Cap on how many individual findings any one tool contributes, so a
# pathological package cannot flood the evidence_index.
MAX_FINDINGS_PER_TOOL = 50

# Severity strings accepted by the dossier capability_delta schema.
_ALLOWED_SEVERITIES = ("info", "low", "medium", "high", "critical")


def _normalize_severity(raw: Any) -> str:
    """Map an arbitrary tool severity string onto the schema enum."""
    if not isinstance(raw, str):
        return "info"
    s = raw.strip().lower()
    if s in _ALLOWED_SEVERITIES:
        return s
    # Common synonyms emitted by the various tools.
    mapping = {
        "error": "high",
        "warning": "medium",
        "warn": "medium",
        "moderate": "medium",
        "negligible": "low",
        "unknown": "info",
        "none": "info",
    }
    return mapping.get(s, "info")


def _evidence(
    ev_id: str,
    kind: str,
    path: str | None,
    summary: str,
    raw_excerpt_available: bool = True,
) -> dict[str, Any]:
    """Build one evidence row in the dossier schema shape."""
    return {
        "id": ev_id,
        "kind": kind,
        "path": path,
        "summary": summary,
        "raw_excerpt_available": raw_excerpt_available,
    }


def _skip_evidence(tool: str) -> dict[str, Any]:
    """Evidence row recording that ``tool`` was not present and was skipped."""
    logger.info("scanner %s not found on PATH; skipping (graceful degrade)", tool)
    return _evidence(
        f"ev.scan.{tool}.skipped",
        "scanner_skipped",
        None,
        f"{tool} not installed on this host (shutil.which returned None); scan skipped.",
        raw_excerpt_available=False,
    )


def _error_evidence(tool: str, reason: str) -> dict[str, Any]:
    """Evidence row recording that ``tool`` ran but failed; never raises."""
    logger.warning("scanner %s failed: %s", tool, reason)
    return _evidence(
        f"ev.scan.{tool}.error",
        "scanner_error",
        None,
        f"{tool} present but did not produce usable output: {reason}",
        raw_excerpt_available=False,
    )


def _run_tool(
    binary: str,
    args: list[str],
    *,
    cwd: str,
    timeout: int,
) -> tuple[bool, str, str]:
    """Run a scanner binary with a bounded timeout.

    Returns ``(ok, stdout, reason)``. ``ok`` is True when the process
    completed without timing out and without an OSError. We deliberately
    do NOT treat a non-zero return code as failure: most of these tools
    exit non-zero when they FIND something, which is the normal case.
    ``shell`` is never used; the binary is invoked directly with an
    argument list so package-controlled paths cannot inject a command.
    """
    cmd = [binary, *args]
    try:
        proc = subprocess.run(  # noqa: S603 - argument list, no shell, trusted binary
            cmd,
            cwd=cwd,
            capture_output=True,
            text=True,
            timeout=timeout,
            check=False,
        )
    except subprocess.TimeoutExpired:
        return False, "", f"timed out after {timeout}s"
    except OSError as exc:  # binary vanished, perms, etc.
        return False, "", f"OSError: {exc}"
    return True, proc.stdout or "", ""


def _parse_json(stdout: str) -> Any:
    """Parse tool stdout as JSON, tolerating leading/trailing noise.

    Some tools print a banner line before the JSON document. We fall
    back to slicing from the first ``{`` / ``[`` to the matching last
    ``}`` / ``]`` when a direct parse fails.
    """
    stdout = stdout.strip()
    if not stdout:
        raise ValueError("empty stdout")
    try:
        return json.loads(stdout)
    except json.JSONDecodeError:
        pass
    starts = [i for i in (stdout.find("{"), stdout.find("[")) if i != -1]
    if not starts:
        raise ValueError("no JSON document in stdout")
    start = min(starts)
    end = max(stdout.rfind("}"), stdout.rfind("]"))
    if end <= start:
        raise ValueError("no JSON document in stdout")
    return json.loads(stdout[start : end + 1])


# --------------------------------------------------------------------------- #
# Per-tool normalizers. Each takes the parsed JSON object and returns a list
# of finding dicts: {kind, path, summary, severity, capability}. These are
# pure functions over already-parsed JSON, which is what the unit tests
# exercise with canned fixtures (no real tool needed).
# --------------------------------------------------------------------------- #


def _norm_semgrep(doc: Any) -> list[dict[str, Any]]:
    findings: list[dict[str, Any]] = []
    results = doc.get("results", []) if isinstance(doc, dict) else []
    for r in results:
        if not isinstance(r, dict):
            continue
        extra = r.get("extra") or {}
        meta = extra.get("metadata") or {}
        sev = _normalize_severity(extra.get("severity") or meta.get("severity"))
        check_id = r.get("check_id") or "semgrep.finding"
        msg = extra.get("message") or meta.get("message") or check_id
        path = r.get("path")
        line = (r.get("start") or {}).get("line")
        loc = f"{path}:{line}" if path and line else path
        findings.append(
            {
                "kind": "scanner_sast",
                "path": loc,
                "summary": f"semgrep {check_id}: {msg}",
                "severity": sev,
                "capability": "static_pattern_match",
            }
        )
    return findings


def _norm_osv(doc: Any) -> list[dict[str, Any]]:
    findings: list[dict[str, Any]] = []
    if not isinstance(doc, dict):
        return findings
    for res in doc.get("results", []) or []:
        if not isinstance(res, dict):
            continue
        src = (res.get("source") or {}).get("path")
        for pkg in res.get("packages", []) or []:
            if not isinstance(pkg, dict):
                continue
            pkg_info = pkg.get("package") or {}
            pkg_name = pkg_info.get("name") or "unknown"
            pkg_ver = pkg_info.get("version") or "?"
            for vuln in pkg.get("vulnerabilities", []) or []:
                if not isinstance(vuln, dict):
                    continue
                vid = vuln.get("id") or "OSV-UNKNOWN"
                sev = "high"  # OSV entries are known CVEs; treat as high by default
                summary = vuln.get("summary") or vuln.get("details") or vid
                findings.append(
                    {
                        "kind": "scanner_vuln",
                        "path": src,
                        "summary": f"osv {vid} affects {pkg_name}@{pkg_ver}: {summary}",
                        "severity": _normalize_severity(sev),
                        "capability": "known_vulnerable_dependency",
                    }
                )
    return findings


def _norm_trufflehog(doc: Any) -> list[dict[str, Any]]:
    findings: list[dict[str, Any]] = []
    # TruffleHog emits one JSON object per line (NDJSON). When we parse a
    # whole file we may get a list; the canned fixture uses a list too.
    items = doc if isinstance(doc, list) else [doc]
    for item in items:
        if not isinstance(item, dict):
            continue
        detector = item.get("DetectorName") or item.get("detector_name") or "secret"
        verified = item.get("Verified") or item.get("verified") or False
        src_meta = item.get("SourceMetadata") or {}
        data = src_meta.get("Data") or {}
        fs = data.get("Filesystem") or {}
        path = fs.get("file") or fs.get("File")
        sev = "critical" if verified else "high"
        findings.append(
            {
                "kind": "scanner_secret",
                "path": path,
                "summary": (
                    f"trufflehog {detector} secret"
                    f"{' (verified live)' if verified else ' (unverified)'}"
                ),
                "severity": sev,
                "capability": "embedded_secret",
            }
        )
    return findings


def _norm_grype(doc: Any) -> list[dict[str, Any]]:
    findings: list[dict[str, Any]] = []
    matches = doc.get("matches", []) if isinstance(doc, dict) else []
    for m in matches:
        if not isinstance(m, dict):
            continue
        vuln = m.get("vulnerability") or {}
        vid = vuln.get("id") or "VULN-UNKNOWN"
        sev = _normalize_severity(vuln.get("severity"))
        artifact = m.get("artifact") or {}
        art_name = artifact.get("name") or "unknown"
        art_ver = artifact.get("version") or "?"
        locations = artifact.get("locations") or []
        path = None
        if locations and isinstance(locations[0], dict):
            path = locations[0].get("path")
        findings.append(
            {
                "kind": "scanner_vuln",
                "path": path,
                "summary": f"grype {vid} affects {art_name}@{art_ver}",
                "severity": sev,
                "capability": "known_vulnerable_dependency",
            }
        )
    return findings


def _findings_to_evidence(
    tool: str, findings: list[dict[str, Any]]
) -> list[dict[str, Any]]:
    """Convert normalized findings into dossier evidence rows."""
    rows: list[dict[str, Any]] = []
    capped = findings[:MAX_FINDINGS_PER_TOOL]
    for idx, f in enumerate(capped, start=1):
        rows.append(
            _evidence(
                f"ev.scan.{tool}.{idx:03d}",
                f.get("kind", "scanner_finding"),
                f.get("path"),
                f.get("summary", f"{tool} finding"),
                raw_excerpt_available=True,
            )
        )
    if len(findings) > MAX_FINDINGS_PER_TOOL:
        rows.append(
            _evidence(
                f"ev.scan.{tool}.truncated",
                "scanner_note",
                None,
                f"{tool} produced {len(findings)} findings; "
                f"truncated to first {MAX_FINDINGS_PER_TOOL}.",
                raw_excerpt_available=False,
            )
        )
    if not findings:
        rows.append(
            _evidence(
                f"ev.scan.{tool}.clean",
                "scanner_note",
                None,
                f"{tool} ran and reported no findings.",
                raw_excerpt_available=False,
            )
        )
    return rows


def _run_scanner(
    tool: str,
    binary: str,
    args: list[str],
    normalizer: Callable[[Any], list[dict[str, Any]]],
    pkg_dir: str,
    timeout: int,
) -> list[dict[str, Any]]:
    """Generic scanner driver: probe, run, parse, normalize, never raise."""
    if shutil.which(binary) is None:
        return [_skip_evidence(tool)]
    try:
        ok, stdout, reason = _run_tool(binary, args, cwd=pkg_dir, timeout=timeout)
        if not ok:
            return [_error_evidence(tool, reason)]
        doc = _parse_json(stdout)
        findings = normalizer(doc)
        return _findings_to_evidence(tool, findings)
    except Exception as exc:  # last-resort guard; pipeline must never see a raise
        return [_error_evidence(tool, f"{type(exc).__name__}: {exc}")]


# --------------------------------------------------------------------------- #
# Public per-tool entry points. Each runs the tool with --json output over
# the package directory and returns dossier evidence rows. STATIC ONLY:
# no install, no script execution, no package code is run.
# --------------------------------------------------------------------------- #


def run_semgrep(
    pkg_dir: str, timeout: int = DEFAULT_TIMEOUT_SECONDS
) -> list[dict[str, Any]]:
    """Run Semgrep (SAST source-pattern scan) over ``pkg_dir``."""
    return _run_scanner(
        "semgrep",
        "semgrep",
        ["--config", "auto", "--json", "--quiet", "--timeout", str(timeout), pkg_dir],
        _norm_semgrep,
        pkg_dir,
        timeout,
    )


def run_osv(
    pkg_dir: str, timeout: int = DEFAULT_TIMEOUT_SECONDS
) -> list[dict[str, Any]]:
    """Run OSV-Scanner (known-vuln lookup over lockfiles/SBOM) on ``pkg_dir``."""
    return _run_scanner(
        "osv",
        "osv-scanner",
        ["--format", "json", "--recursive", pkg_dir],
        _norm_osv,
        pkg_dir,
        timeout,
    )


def run_trufflehog(
    pkg_dir: str, timeout: int = DEFAULT_TIMEOUT_SECONDS
) -> list[dict[str, Any]]:
    """Run TruffleHog (secret scan) over the ``pkg_dir`` file tree.

    ``filesystem`` mode reads files only; it does not clone, install, or
    execute anything. ``--no-update`` keeps it from phoning home.
    """
    return _run_scanner(
        "trufflehog",
        "trufflehog",
        ["filesystem", pkg_dir, "--json", "--no-update"],
        _norm_trufflehog,
        pkg_dir,
        timeout,
    )


def run_syft_grype(
    pkg_dir: str, timeout: int = DEFAULT_TIMEOUT_SECONDS
) -> list[dict[str, Any]]:
    """Generate an SBOM with Syft, then match vulns with Grype.

    Both are static: Syft catalogs files into an SBOM and Grype matches
    that SBOM against a vuln database. Neither installs or runs the
    package. If Syft is present but Grype is not (or vice versa), the
    missing half degrades gracefully via the standard skip path.
    """
    rows: list[dict[str, Any]] = []

    syft_present = shutil.which("syft") is not None
    grype_present = shutil.which("grype") is not None

    if not syft_present and not grype_present:
        return [_skip_evidence("syft_grype")]
    if not syft_present:
        rows.append(_skip_evidence("syft"))
    if not grype_present:
        rows.append(_skip_evidence("grype"))

    # Grype can scan a directory directly (it shells out to Syft-equivalent
    # cataloging internally), so when Grype is present we point it at the
    # extracted dir and normalize its matches. This keeps the two-binary
    # handoff simple and avoids piping an intermediate SBOM file.
    if grype_present:
        grype_rows = _run_scanner(
            "grype",
            "grype",
            [f"dir:{pkg_dir}", "--output", "json"],
            _norm_grype,
            pkg_dir,
            timeout,
        )
        rows.extend(grype_rows)
    elif syft_present:
        # Syft alone produces an SBOM but no vuln verdicts; record that the
        # SBOM stage is available while vuln matching is not.
        rows.append(
            _evidence(
                "ev.scan.syft.sbom_only",
                "scanner_note",
                None,
                "syft present but grype absent; SBOM cataloging available, "
                "no vulnerability matching performed.",
                raw_excerpt_available=False,
            )
        )
    return rows


# Registry of the four scanner entry points, in a stable order.
_SCANNERS: tuple[Callable[[str], list[dict[str, Any]]], ...] = (
    run_semgrep,
    run_osv,
    run_trufflehog,
    run_syft_grype,
)


def enrich_with_scanners(
    pkg_dir: str, timeout: int = DEFAULT_TIMEOUT_SECONDS
) -> list[dict[str, Any]]:
    """Run every available static scanner over ``pkg_dir``.

    Returns a flat list of evidence rows in the dossier ``evidence``
    schema. Tools that are absent contribute a single ``scanner_skipped``
    row; tools that fail contribute a ``scanner_error`` row. This function
    never raises - a per-scanner crash is caught and recorded so the
    calling pipeline always gets a usable list.
    """
    evidence: list[dict[str, Any]] = []
    for scanner in _SCANNERS:
        try:
            evidence.extend(scanner(pkg_dir, timeout))
        except Exception as exc:  # belt-and-braces; runners already self-guard
            evidence.append(
                _error_evidence(getattr(scanner, "__name__", "scanner"), str(exc))
            )
    return evidence


def scanner_capability_deltas(
    evidence_rows: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    """Derive ``capability_delta`` rows from scanner evidence rows.

    Maps the scanner evidence ``kind`` onto a behavioural capability so
    ``dossier_builder`` can fold scanner output into ``capability_deltas``
    alongside the static-pattern deltas it already produces. Skip/error/
    note/clean rows do not produce capability deltas.
    """
    kind_to_cap = {
        "scanner_sast": ("static_pattern_match", "medium"),
        "scanner_secret": ("embedded_secret", "high"),
        "scanner_vuln": ("known_vulnerable_dependency", "high"),
    }
    deltas: list[dict[str, Any]] = []
    for row in evidence_rows:
        mapped = kind_to_cap.get(row.get("kind", ""))
        if mapped is None:
            continue
        capability, severity = mapped
        deltas.append(
            {
                "evidence_ref": row["id"],
                "capability": capability,
                "change": "added",
                "severity_hint": severity,
                "summary": row.get("summary", capability),
            }
        )
    return deltas


__all__ = [
    "run_semgrep",
    "run_osv",
    "run_trufflehog",
    "run_syft_grype",
    "enrich_with_scanners",
    "scanner_capability_deltas",
    "DEFAULT_TIMEOUT_SECONDS",
]
