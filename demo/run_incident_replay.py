"""Live-demo CLI replaying confirmed npm supply-chain incidents.

Loads a paired (AuditDossier, AuditReport) fixture, walks the deterministic
policy gate first, then prints the model verdict, then writes a Control
Evidence Memo to ``demo/outputs/``. The output is colored for terminal
projection and reads cleanly on plain stdout.

Demo recipes (from finetune/python/pitch/slide-deck.md slide 5):

    python -m demo.run_incident_replay --incident postmark-mcp-1.0.16
    python -m demo.run_incident_replay --incident postmark-mcp-1.0.12
    python -m demo.run_incident_replay --incident lodash-4.17.21

Use ``--list`` to enumerate incidents, ``--no-color`` for plain output,
and ``--no-write`` to skip memo generation.
"""

from __future__ import annotations

import argparse
import json
import sys
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

# ----- repo-relative paths --------------------------------------------------

_THIS = Path(__file__).resolve()
DEMO_ROOT = _THIS.parent
INCIDENTS_DIR = DEMO_ROOT / "incidents"
OUTPUTS_DIR = DEMO_ROOT / "outputs"

# ----- ANSI palette ---------------------------------------------------------


class _Palette:
    """Minimal 16-color ANSI palette with a no-color fallback."""

    def __init__(self, enabled: bool) -> None:
        self.enabled = enabled

    def _w(self, code: str, text: str) -> str:
        return f"\x1b[{code}m{text}\x1b[0m" if self.enabled else text

    def red(self, t: str) -> str:
        return self._w("31;1", t)

    def green(self, t: str) -> str:
        return self._w("32;1", t)

    def yellow(self, t: str) -> str:
        return self._w("33;1", t)

    def cyan(self, t: str) -> str:
        return self._w("36;1", t)

    def gray(self, t: str) -> str:
        return self._w("90", t)

    def bold(self, t: str) -> str:
        return self._w("1", t)


# ----- rule-table model -----------------------------------------------------


@dataclass
class GateResult:
    rule: str
    status: str  # "PASS" | "FAIL" | "SKIP"
    detail: str


# ----- incident catalog -----------------------------------------------------


def _available_incidents() -> list[str]:
    return sorted(
        p.stem.replace(".dossier", "")
        for p in INCIDENTS_DIR.glob("*.dossier.json")
    )


def _load_paired_fixture(incident_id: str) -> tuple[dict[str, Any], dict[str, Any]]:
    dossier_path = INCIDENTS_DIR / f"{incident_id}.dossier.json"
    report_path = INCIDENTS_DIR / f"{incident_id}.report.json"
    if not dossier_path.exists() or not report_path.exists():
        raise FileNotFoundError(
            f"no fixture for incident '{incident_id}'. Use --list to enumerate."
        )
    with dossier_path.open(encoding="utf-8") as fh:
        dossier = json.load(fh)
    with report_path.open(encoding="utf-8") as fh:
        report = json.load(fh)
    return dossier, report


# ----- deterministic gate ---------------------------------------------------


def _run_deterministic_gate(dossier: dict[str, Any]) -> list[GateResult]:
    """Walk the documented gate rules against the dossier evidence."""
    diff = dossier.get("diff_summary") or {}
    deltas = dossier.get("capability_deltas") or []
    release = dossier.get("release_context") or {}
    pkg = dossier.get("package") or {}

    def has_capability(name: str) -> bool:
        for d in deltas:
            if not isinstance(d, dict):
                continue
            # Schema permits either "capability" (current schema) or
            # "capability_id" (older fixtures); accept both.
            cap = d.get("capability") or d.get("capability_id") or ""
            if cap == name and d.get("change") == "added":
                return True
        return False

    results: list[GateResult] = []

    # release-age (heuristic: a release published less than 14 days back is
    # newer than the policy default).
    pub = release.get("published_at") or pkg.get("published_at") or ""
    age_status = "SKIP"
    age_detail = "no published_at available"
    if pub:
        try:
            published_dt = datetime.fromisoformat(pub.replace("Z", "+00:00"))
            now = datetime.now(timezone.utc)
            days = (now - published_dt).days
            if days < 14:
                age_status, age_detail = "FAIL", f"published {days} days ago (policy: >=14)"
            else:
                age_status, age_detail = "PASS", f"published {days} days ago"
        except ValueError:
            age_detail = f"unparseable published_at: {pub}"
    results.append(GateResult("release-age", age_status, age_detail))

    # install-scripts: any new lifecycle hook (capability OR observable file diff)
    has_lifecycle_cap = has_capability("lifecycle_script") or has_capability(
        "cap.lifecycle.postinstall_added"
    ) or has_capability("cap.lifecycle.preinstall_added")
    notable = diff.get("notable_file_changes") or []
    file_diff_hits_lifecycle = any(
        isinstance(c, dict)
        and (c.get("path") or "").endswith("package.json")
        and "postinstall" in (c.get("summary") or "").lower()
        for c in notable
    )
    if has_lifecycle_cap or file_diff_hits_lifecycle:
        results.append(GateResult("install-scripts", "FAIL", "new lifecycle hook in version diff"))
    else:
        results.append(GateResult("install-scripts", "PASS", "no new lifecycle hooks"))

    # source-match: repository.url declared
    repo = release.get("repository_url")
    if release.get("source_tarball_mismatch"):
        results.append(GateResult("source-match", "FAIL", "tarball does not match declared source"))
    elif repo:
        results.append(GateResult("source-match", "PASS", f"declared {repo}"))
    else:
        results.append(GateResult("source-match", "FAIL", "no repository.url declared"))

    # SRI checksum: integrity present
    if pkg.get("candidate_integrity"):
        results.append(GateResult("sri-checksum", "PASS", f"candidate integrity present"))
    else:
        results.append(GateResult("sri-checksum", "FAIL", "no candidate integrity declared"))

    # allowlist
    is_allowed = release.get("allowlisted") is True
    if is_allowed:
        results.append(GateResult("allowlist", "PASS", "version on explicit allowlist"))
    else:
        results.append(GateResult("allowlist", "SKIP", "no allowlist hit; defer to gate verdict"))

    return results


def _gate_verdict(results: list[GateResult]) -> str:
    """If any FAIL, gate would quarantine the install pending review."""
    return "quarantine" if any(r.status == "FAIL" for r in results) else "allow"


# ----- rendering ------------------------------------------------------------


def _render_header(p: _Palette, incident_id: str, dossier: dict[str, Any]) -> None:
    pkg = dossier.get("package") or {}
    name = pkg.get("name") or "unknown"
    ver = pkg.get("candidate_version") or "0.0.0"
    mode = dossier.get("audit_mode") or "unknown"
    print(p.bold(f"\n  ModuleWarden incident replay  ::  {incident_id}"))
    print(p.gray(f"  package={name}@{ver}  mode={mode}  audit_id={dossier.get('audit_id')}\n"))


def _render_gate_table(p: _Palette, results: list[GateResult]) -> None:
    print(p.bold("  Deterministic policy gate"))
    print(p.gray("  " + "-" * 64))
    for r in results:
        if r.status == "FAIL":
            badge = p.red(" FAIL ")
        elif r.status == "PASS":
            badge = p.green(" PASS ")
        else:
            badge = p.yellow(" SKIP ")
        print(f"    {badge}  {r.rule:<18}  {p.gray(r.detail)}")
    print()


def _render_model_verdict(p: _Palette, report: dict[str, Any]) -> None:
    verdict = (report.get("verdict") or "unknown").lower()
    conf = report.get("confidence") or "n/a"
    risk = report.get("risk_level") or "n/a"
    if verdict == "block":
        line = p.red(f"  VERDICT: BLOCK")
    elif verdict == "quarantine":
        line = p.yellow(f"  VERDICT: QUARANTINE")
    elif verdict == "allow":
        line = p.green(f"  VERDICT: ALLOW")
    else:
        line = p.gray(f"  VERDICT: {verdict.upper()}")
    print(p.bold("  Cited-model audit report"))
    print(p.gray("  " + "-" * 64))
    print(f"  {line}   confidence={conf}   risk_level={risk}")
    summary = report.get("summary") or ""
    if summary:
        print(p.gray(f"  {summary}"))
    print()

    findings = report.get("primary_findings") or []
    if findings:
        print(p.bold("  Primary findings"))
        print(p.gray("  " + "-" * 64))
        for f in findings:
            sev = (f.get("severity") or "?").upper()
            cat = f.get("category") or "?"
            claim = f.get("claim") or ""
            refs = ", ".join(f.get("evidence_refs") or []) or "(no refs)"
            print(f"    {p.cyan('[' + sev + ']')} {p.bold(cat)}")
            print(f"      {claim}")
            print(p.gray(f"      evidence: {refs}"))
        print()

    rec = report.get("recommended_agent_checks") or []
    if rec:
        print(p.bold("  Recommended agent (PI) follow-up checks"))
        print(p.gray("  " + "-" * 64))
        for check in rec:
            print(f"    {p.gray('-')} {check}")
        print()


def _render_summaries(p: _Palette, report: dict[str, Any]) -> None:
    dev = report.get("developer_safe_summary") or ""
    adm = report.get("security_admin_summary") or ""
    if dev:
        print(p.bold("  Developer-safe summary"))
        print(p.gray("  " + "-" * 64))
        print(f"  {dev}\n")
    if adm:
        print(p.bold("  Security-admin summary"))
        print(p.gray("  " + "-" * 64))
        print(f"  {adm}\n")


def _write_evidence_memo(
    incident_id: str,
    dossier: dict[str, Any],
    report: dict[str, Any],
    gate_results: list[GateResult],
    output_dir: Path,
) -> Path:
    output_dir.mkdir(parents=True, exist_ok=True)
    stamp = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    path = output_dir / f"{incident_id}__{stamp}.md"
    pkg = dossier.get("package") or {}
    name = pkg.get("name") or "unknown"
    ver = pkg.get("candidate_version") or "0.0.0"

    lines: list[str] = [
        f"# Control Evidence Memo: {name}@{ver}",
        "",
        f"audit_id: {dossier.get('audit_id')}",
        f"schema_version: {report.get('schema_version')}",
        f"verdict: {report.get('verdict')}",
        f"confidence: {report.get('confidence')}",
        f"risk_level: {report.get('risk_level')}",
        f"generated_at: {datetime.now(timezone.utc).isoformat()}",
        "",
        "## Deterministic policy gate",
        "",
        "| rule | status | detail |",
        "|---|---|---|",
    ]
    for r in gate_results:
        lines.append(f"| {r.rule} | {r.status} | {r.detail} |")

    lines += [
        "",
        "## Primary findings",
        "",
    ]
    for f in report.get("primary_findings") or []:
        sev = (f.get("severity") or "?").upper()
        cat = f.get("category") or "?"
        claim = f.get("claim") or ""
        refs = ", ".join(f.get("evidence_refs") or []) or "(no refs)"
        lines.append(f"- **[{sev}] {cat}** -- {claim}")
        lines.append(f"  - evidence: {refs}")

    lines += [
        "",
        "## Developer-safe summary",
        "",
        report.get("developer_safe_summary") or "(none)",
        "",
        "## Security-admin summary",
        "",
        report.get("security_admin_summary") or "(none)",
        "",
        "## Output integrity",
        "",
        "- schema validation: audit_report.v1 (see finetune/contracts/audit-report.schema.json)",
        "- generated by: demo.run_incident_replay",
        f"- source dossier: demo/incidents/{incident_id}.dossier.json",
        "",
    ]
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")
    return path


# ----- CLI ------------------------------------------------------------------


def _make_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        prog="python -m demo.run_incident_replay",
        description=(
            "Replay a confirmed npm supply-chain incident through the "
            "ModuleWarden deterministic gate plus cited model verdict."
        ),
    )
    p.add_argument(
        "--incident",
        help="incident id (see --list for available)",
        default=None,
    )
    p.add_argument(
        "--list",
        action="store_true",
        help="list available incident fixtures and exit",
    )
    p.add_argument(
        "--no-color",
        action="store_true",
        help="disable ANSI color in output",
    )
    p.add_argument(
        "--no-write",
        action="store_true",
        help="skip writing the Control Evidence Memo",
    )
    p.add_argument(
        "--output-dir",
        type=Path,
        default=OUTPUTS_DIR,
        help=f"directory to write the memo (default: {OUTPUTS_DIR})",
    )
    return p


def main(argv: list[str] | None = None) -> int:
    args = _make_parser().parse_args(argv)
    palette = _Palette(enabled=(not args.no_color) and sys.stdout.isatty())

    if args.list or not args.incident:
        ids = _available_incidents()
        if not ids:
            print("no incident fixtures found in demo/incidents/")
            return 2
        print("Available incidents:")
        for i in ids:
            print(f"  {i}")
        if not args.incident:
            print("\nPass --incident <id> to replay one.")
        return 0

    try:
        dossier, report = _load_paired_fixture(args.incident)
    except FileNotFoundError as e:
        print(f"error: {e}", file=sys.stderr)
        return 2

    gate_results = _run_deterministic_gate(dossier)
    gate_action = _gate_verdict(gate_results)

    _render_header(palette, args.incident, dossier)
    _render_gate_table(palette, gate_results)
    print(palette.gray(f"  Deterministic-gate action: {gate_action}\n"))
    _render_model_verdict(palette, report)
    _render_summaries(palette, report)

    if not args.no_write:
        memo_path = _write_evidence_memo(
            incident_id=args.incident,
            dossier=dossier,
            report=report,
            gate_results=gate_results,
            output_dir=args.output_dir,
        )
        print(palette.bold(f"  Control Evidence Memo written: {memo_path}\n"))

    final = (report.get("verdict") or "unknown").lower()
    return 0 if final in {"allow", "quarantine", "block"} else 1


if __name__ == "__main__":
    sys.exit(main())
