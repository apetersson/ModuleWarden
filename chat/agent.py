"""Conversational underwriter assistant agent.

Two execution paths:

1. Deterministic router. Always available. Matches the user's message
   against a small intent grammar (lookup, list, explain, gate-walk,
   incident-summary, help) and returns a templated answer assembled from
   the demo/incidents fixtures plus the canonical schemas.

2. LLM-augmented mode. When the operator has set ``OPENAI_API_KEY`` (and
   optionally ``OPENAI_BASE_URL``), the deterministic router runs first
   as a guard rail and produces structured evidence, then a chat
   completion is invoked with the system prompt at
   ``chat/prompts/system.md`` plus the structured evidence plus the user
   message. The LLM never gets to invent verdicts: the dossier and
   report are already pinned by the router.

Both paths return the same shape: ``ChatTurn`` with a markdown response
string and a structured evidence block the UI can render alongside.
"""

from __future__ import annotations

import json
import os
import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

REPO_ROOT = Path(__file__).resolve().parents[1]
DEMO_INCIDENTS = REPO_ROOT / "demo" / "incidents"
SYSTEM_PROMPT_PATH = Path(__file__).resolve().parent / "prompts" / "system.md"


# ---------------------------------------------------------------------------
# Data shape
# ---------------------------------------------------------------------------


@dataclass
class ChatTurn:
    response_md: str
    evidence: dict[str, Any] = field(default_factory=dict)
    route: str = "router"  # "router" | "llm" | "fallback"


# ---------------------------------------------------------------------------
# Incident library
# ---------------------------------------------------------------------------


def _list_incidents() -> list[str]:
    if not DEMO_INCIDENTS.exists():
        return []
    return sorted(
        p.stem.replace(".dossier", "")
        for p in DEMO_INCIDENTS.glob("*.dossier.json")
    )


def _load_pair(incident_id: str) -> tuple[dict[str, Any], dict[str, Any]] | None:
    dossier_path = DEMO_INCIDENTS / f"{incident_id}.dossier.json"
    report_path = DEMO_INCIDENTS / f"{incident_id}.report.json"
    if not dossier_path.exists() or not report_path.exists():
        return None
    with dossier_path.open(encoding="utf-8") as fh:
        dossier = json.load(fh)
    with report_path.open(encoding="utf-8") as fh:
        report = json.load(fh)
    return dossier, report


# ---------------------------------------------------------------------------
# Intent detection
# ---------------------------------------------------------------------------


_PKG_AT_VER = re.compile(r"([@\w/.-]+?)@([\w.+-]+)")
_VERBS_LIST = ("list", "what packages", "available", "show me incidents")
_VERBS_EXPLAIN = ("explain", "why", "rationale", "details", "tell me more")
_VERBS_GATE = ("gate", "policy", "rules", "deterministic", "five rules")
_VERBS_INCIDENT = ("postmark", "shai-hulud", "shai hulud", "event-stream", "event stream", "lodash")
_HELP_VERBS = ("help", "what can you do", "what do you do")


def _detect_intent(message: str) -> tuple[str, dict[str, Any]]:
    msg = message.strip().lower()
    facts: dict[str, Any] = {}

    if any(v in msg for v in _HELP_VERBS) and len(msg) < 60:
        return "help", facts

    m = _PKG_AT_VER.search(message)
    if m:
        facts["package"] = m.group(1).strip()
        facts["version"] = m.group(2).strip()
        # Try to find a matching dossier first.
        candidate = f"{facts['package']}-{facts['version']}"
        if candidate in _list_incidents():
            facts["incident_id"] = candidate
            return "lookup", facts
        return "lookup_unknown", facts

    if any(v in msg for v in _VERBS_GATE):
        return "gate", facts

    if any(v in msg for v in _VERBS_LIST):
        return "list", facts

    if any(v in msg for v in _VERBS_INCIDENT):
        # Find which incident the user is asking about.
        for ev in _list_incidents():
            if any(part.lower() in msg for part in ev.split("-")):
                facts["incident_id"] = ev
                return "lookup", facts
        return "incident_overview", facts

    if any(v in msg for v in _VERBS_EXPLAIN):
        return "explain", facts

    return "freeform", facts


# ---------------------------------------------------------------------------
# Templated responses
# ---------------------------------------------------------------------------


def _format_verdict_line(incident_id: str, report: dict[str, Any]) -> str:
    pkg = incident_id.rsplit("-", 1)
    name = pkg[0]
    ver = pkg[1] if len(pkg) > 1 else ""
    verdict = (report.get("verdict") or "unknown").upper()
    risk = report.get("risk_level") or "n/a"
    conf = report.get("confidence") or "n/a"
    return f"> **{name}@{ver}  ::  VERDICT: {verdict}  ::  risk_level={risk}  ::  confidence={conf}**"


def _format_findings(report: dict[str, Any]) -> str:
    findings = report.get("primary_findings") or []
    if not findings:
        return "No primary findings recorded for this release."
    lines = []
    for f in findings:
        sev = (f.get("severity") or "?").upper()
        cat = f.get("category") or "?"
        claim = f.get("claim") or ""
        refs = ", ".join(f.get("evidence_refs") or []) or "(no refs)"
        lines.append(f"- **[{sev}] {cat}** -- {claim}\n  - evidence: `{refs}`")
    return "\n".join(lines)


def _underwriting_implication(verdict: str, risk_level: str) -> str:
    v = (verdict or "").lower()
    r = (risk_level or "").lower()
    if v == "block":
        return (
            "**Underwriting implication.** This release should fail the "
            "supply-chain section of the underwriting questionnaire. If the "
            "client has this version on the dependency surface, "
            "control-class credit is not applicable until the client pins "
            "to the last-known-clean release."
        )
    if v == "quarantine":
        return (
            "**Underwriting implication.** Conditionally underwritable. "
            "Add a remediation clause requiring the client to either pin "
            "an allowlisted version, supply a maintainer attestation, or "
            "exclude this dependency from production by policy bind."
        )
    if v == "allow":
        if r in {"none", "low"}:
            return (
                "**Underwriting implication.** Clean control signal. "
                "Counts toward supply-chain control-class credit at "
                "policy bind."
            )
        return (
            "**Underwriting implication.** Allowed by the gate; the model "
            "still flags residual risk. Treat as a positive signal but "
            "weight it by the residual risk level when computing premium "
            "credit."
        )
    return ""


def _render_lookup(incident_id: str, dossier: dict[str, Any], report: dict[str, Any]) -> str:
    verdict_line = _format_verdict_line(incident_id, report)
    summary = report.get("summary") or ""
    implication = _underwriting_implication(
        report.get("verdict") or "", report.get("risk_level") or ""
    )
    findings = _format_findings(report)
    memo_path = f"demo/outputs/{incident_id}__YYYY-MM-DD.md"
    body = [
        verdict_line,
        "",
        summary,
        "",
        implication,
        "",
        "### Primary findings",
        "",
        findings,
        "",
        f"_Control Evidence Memo path (after running the live replay): `{memo_path}`_",
    ]
    return "\n".join(body)


def _render_list() -> str:
    incidents = _list_incidents()
    if not incidents:
        return "No incident fixtures are installed under `demo/incidents/`."
    lines = ["Here are the incidents I have audit dossiers for:", ""]
    for i in incidents:
        lines.append(f"- `{i}`")
    lines.append("")
    lines.append("Ask about any of them by name, e.g. `look up postmark-mcp@1.0.16`.")
    return "\n".join(lines)


def _render_gate() -> str:
    return (
        "ModuleWarden's deterministic gate evaluates five rules on every "
        "candidate install. Any FAIL row triggers a `quarantine` action; "
        "PASS-only rows produce an `allow` action.\n\n"
        "1. **release-age** -- release must be >= 14 days old by default. "
        "Newer-than-policy releases are deemed too unseasoned to ship.\n"
        "2. **install-scripts** -- no new postinstall / preinstall / "
        "prepare lifecycle hooks introduced versus the baseline. New "
        "lifecycle code is the single most common npm supply-chain "
        "abuse point.\n"
        "3. **source-match** -- declared `repository.url` resolves and "
        "the tarball SHA matches what the source repo would build.\n"
        "4. **SRI checksum** -- candidate integrity hash is present, "
        "matches the tarball, and the algorithm is on the allowed list.\n"
        "5. **allowlist** -- explicit per-organization allowlist hit. "
        "Skipped when the package and version is not on the allowlist.\n\n"
        "For an underwriter, the gate output is a structured, auditable "
        "control signal that an insurer's evidence pack can cite without "
        "trusting the customer's self-attestation."
    )


def _render_help() -> str:
    return (
        "I help an underwriter reason about npm supply-chain risk on a "
        "client account. Things I can do:\n\n"
        "- **Look up a package.** Try `postmark-mcp@1.0.16` or "
        "`lodash@4.17.21`.\n"
        "- **Explain the deterministic gate.** Ask `what are the gate "
        "rules?` and I will walk the five rules.\n"
        "- **List incidents I have dossiers for.** Ask `list incidents`.\n"
        "- **Summarize a real supply-chain incident.** Ask about "
        "`postmark`, `Shai-Hulud`, `event-stream`, or `lodash`.\n\n"
        "Drop a package.json or pnpm-lock.yaml into the side panel "
        "(Streamlit UI) for a portfolio-style roll-up across an account."
    )


def _render_unknown(facts: dict[str, Any]) -> str:
    pkg = facts.get("package")
    ver = facts.get("version")
    if pkg and ver:
        return (
            f"I do not have an audit dossier for `{pkg}@{ver}` yet. "
            f"In the production pipeline, ModuleWarden would queue the "
            f"audit and return a verdict within seconds. For this demo, "
            f"I can show you the verdict for any of these incidents:\n\n"
            f"{_render_list()}"
        )
    return _render_help()


def _render_freeform(message: str) -> str:
    return (
        "I focused on the supply-chain risk question. Could you tell me "
        "which package and version you would like me to look up, or ask "
        "`help` for what I can do?"
    )


# ---------------------------------------------------------------------------
# Public entry point
# ---------------------------------------------------------------------------


def handle_query(message: str, history: list[dict[str, str]] | None = None) -> ChatTurn:
    """Route a user message to a response.

    history is an optional list of ``{"role", "content"}`` dicts; the
    deterministic router ignores history but the LLM mode forwards it.
    """
    history = history or []
    intent, facts = _detect_intent(message)

    if intent == "help":
        return ChatTurn(response_md=_render_help(), evidence={"intent": "help"})

    if intent == "list":
        return ChatTurn(
            response_md=_render_list(),
            evidence={"intent": "list", "incidents": _list_incidents()},
        )

    if intent == "gate":
        return ChatTurn(response_md=_render_gate(), evidence={"intent": "gate"})

    if intent == "lookup":
        incident_id = facts.get("incident_id")
        if not incident_id:
            return ChatTurn(response_md=_render_unknown(facts), evidence={"intent": "lookup_unknown"})
        pair = _load_pair(incident_id)
        if pair is None:
            return ChatTurn(response_md=_render_unknown(facts), evidence={"intent": "lookup_unknown"})
        dossier, report = pair
        return ChatTurn(
            response_md=_render_lookup(incident_id, dossier, report),
            evidence={
                "intent": "lookup",
                "incident_id": incident_id,
                "verdict": report.get("verdict"),
                "risk_level": report.get("risk_level"),
                "confidence": report.get("confidence"),
                "primary_findings_count": len(report.get("primary_findings") or []),
            },
        )

    if intent == "lookup_unknown":
        return ChatTurn(response_md=_render_unknown(facts), evidence={"intent": "lookup_unknown"})

    if intent == "incident_overview":
        return ChatTurn(
            response_md="Which incident were you asking about? I have dossiers for: "
            + ", ".join(f"`{i}`" for i in _list_incidents())
            + ".",
            evidence={"intent": "incident_overview"},
        )

    if intent == "explain":
        return ChatTurn(
            response_md=(
                "Happy to explain. Ask me about a specific package and version "
                "(e.g. `postmark-mcp@1.0.16`) or about the gate (`what are the "
                "gate rules?`) and I will walk through the reasoning."
            ),
            evidence={"intent": "explain"},
        )

    return ChatTurn(response_md=_render_freeform(message), evidence={"intent": "freeform"})
