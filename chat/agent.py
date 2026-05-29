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
from typing import Any, Literal

from . import model_client

REPO_ROOT = Path(__file__).resolve().parents[1]
DEMO_INCIDENTS = REPO_ROOT / "demo" / "incidents"
SYSTEM_PROMPT_PATH = Path(__file__).resolve().parent / "prompts" / "system.md"


def _load_system_prompt() -> str:
    """Load the underwriter system prompt. Wired in (was previously dead)."""
    try:
        return SYSTEM_PROMPT_PATH.read_text(encoding="utf-8")
    except OSError:
        return "You are the ModuleWarden Underwriter Assistant."


# ---------------------------------------------------------------------------
# Data shape
# ---------------------------------------------------------------------------


@dataclass
class ChatTurn:
    response_md: str
    evidence: dict[str, Any] = field(default_factory=dict)
    route: Literal["router", "llm"] = "router"


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

# Catches `1.0.16`, `v1.0.16`, `1.0.0-rc.1`, `1.0.0+build.7`.
_VERSION_HINT = re.compile(r"\bv?(\d+\.\d+(?:\.\d+)?(?:[+-][\w.+-]*)?)\b")


def _detect_intent(message: str) -> tuple[str, dict[str, Any]]:
    msg = message.strip().lower()
    facts: dict[str, Any] = {}

    if any(v in msg for v in _HELP_VERBS) and len(msg) < 60:
        return "help", facts

    # Bare incident id (e.g. the Streamlit sidebar button pastes `look up
    # lodash-4.17.21` which previously got mis-parsed into a fake
    # `lodash-4.17.21@4.17.21`). Accept the id verbatim when it matches a
    # known incident exactly.
    for ev in _list_incidents():
        if ev in message:
            facts["incident_id"] = ev
            return "lookup", facts

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
        # Collect every incident the message could plausibly be about by
        # name. Then prefer the one whose version actually appears in the
        # message; if the user did not name a specific version, disambiguate
        # rather than silently picking the lex-first match.
        candidates: list[str] = []
        for ev in _list_incidents():
            if any(part.lower() in msg for part in ev.split("-")):
                candidates.append(ev)
        if candidates:
            for ver in _VERSION_HINT.findall(message):
                for ev in candidates:
                    if ev.endswith(f"-{ver}"):
                        facts["incident_id"] = ev
                        return "lookup", facts
            if len(candidates) == 1:
                facts["incident_id"] = candidates[0]
                return "lookup", facts
            facts["candidates"] = candidates
            return "disambiguate", facts
        return "incident_overview", facts

    if any(v in msg for v in _VERBS_EXPLAIN):
        return "explain", facts

    return "freeform", facts


def lookup_by_incident_id(incident_id: str) -> ChatTurn:
    """Direct UI shortcut: turn a known incident id into a ChatTurn.

    The Streamlit sidebar buttons call this so we never need to reconstruct
    a `package@version` string and re-run the regex parser on it. The
    previous version of the sidebar did `f'{x.split("-")[0]}-{x.split("-")[1]}@{x.rsplit("-",1)[1]}'`
    which produced `lodash-4.17.21@4.17.21` for any one-token package name --
    that string did not match any incident and fell through to
    ``lookup_unknown``. Direct id lookup avoids the entire round trip.
    """
    pair = _load_pair(incident_id)
    if pair is None:
        return ChatTurn(
            response_md=f"No fixture for incident `{incident_id}`.",
            evidence={"intent": "lookup_unknown", "incident_id": incident_id},
        )
    dossier, report = pair
    memo = _render_underwriting_memo(incident_id, dossier, report)
    prose, route, endpoint_error = narrate_underwriting(incident_id, dossier, report)
    # The deterministic memo is always shown (verdict is pinned). When the
    # fine-tuned model is configured and responds, its underwriter narrative
    # leads, with the pinned memo beneath it as the audit trail.
    if prose:
        response_md = f"{prose.strip()}\n\n---\n\n{memo}"
    else:
        response_md = memo
    evidence = {
        "intent": "lookup",
        "incident_id": incident_id,
        "verdict": report.get("verdict"),
        "risk_level": report.get("risk_level"),
        "confidence": report.get("confidence"),
        "underwriting_tier": _underwriting_tier(
            report.get("verdict") or "", report.get("risk_level") or ""
        ),
        "primary_findings_count": len(report.get("primary_findings") or []),
        "model_backed": route == "llm",
    }
    if endpoint_error:
        evidence["endpoint_error"] = endpoint_error
    return ChatTurn(response_md=response_md, evidence=evidence, route=route)


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


# ---------------------------------------------------------------------------
# Underwriting Control Evidence Memo
#
# The verdict is pinned by the deterministic gate + the audit report. These
# functions translate that pinned verdict into the three fields a UNIQA
# cyber-policy underwriter acts on: a risk tier, a premium/exclusion
# recommendation, and the cited evidence. NONE of this is model-generated;
# the model (when configured) narrates this card, it does not produce it.
# ---------------------------------------------------------------------------


def _underwriting_tier(verdict: str, risk_level: str) -> str:
    """Map the pinned verdict + risk level to an underwriting decision tier."""
    v = (verdict or "").lower()
    r = (risk_level or "").lower()
    if v == "block":
        return "DECLINE (refer to security; supply-chain control credit withheld)"
    if v == "quarantine":
        return "ACCEPT-WITH-CONDITIONS (remediation clause required before bind)"
    if v == "allow":
        if r in {"none", "low"}:
            return "ACCEPT (clean supply-chain control signal; credit-eligible)"
        return "ACCEPT-WITH-CONDITIONS (residual risk; partial control credit)"
    return "REFER (verdict unavailable; manual review)"


def _premium_exclusion_line(incident_id: str, dossier: dict[str, Any], report: dict[str, Any]) -> str:
    """The premium-loading / exclusion recommendation for the policy file."""
    v = (report.get("verdict") or "").lower()
    name = (dossier.get("package") or {}).get("name") or incident_id.rsplit("-", 1)[0]
    baseline = (dossier.get("baseline") or {}).get("version")
    clean_ref = f"@{baseline}" if baseline else " a last-known-clean release"
    if v == "block":
        return (
            f"**Premium / exclusion.** Recommend a policy exclusion for losses "
            f"arising from `{name}` at the audited version until the insured pins "
            f"to {clean_ref}. Do not extend supply-chain control credit on this "
            f"dependency while the compromise is live."
        )
    if v == "quarantine":
        return (
            f"**Premium / exclusion.** Accept with a remediation clause: the "
            f"insured pins an allowlisted version of `{name}`, supplies a "
            f"maintainer attestation, or excludes it from production by bind. "
            f"Hold control credit pending remediation."
        )
    if v == "allow":
        r = (report.get("risk_level") or "").lower()
        if r in {"none", "low"}:
            return (
                f"**Premium / exclusion.** No loading. `{name}` is a positive "
                f"control-class signal and is eligible for the supply-chain "
                f"premium credit at bind."
            )
        return (
            f"**Premium / exclusion.** No exclusion, but weight the residual "
            f"risk on `{name}` when sizing the supply-chain credit; partial "
            f"credit only."
        )
    return "**Premium / exclusion.** Manual underwriting review required."


def _kill_chain_attack(dossier: dict[str, Any]) -> dict[str, Any] | None:
    """Map the dossier's static capability_deltas to a MITRE ATT&CK kill chain.

    Optional enrichment, never the verdict. Guarded import so the chat still
    runs if the mapper is unavailable; returns None when there is no chain.
    """
    try:
        from finetune.python.decepticon.mapper import kill_chain_narrative
    except Exception:
        return None
    kc = kill_chain_narrative(dossier.get("capability_deltas") or [])
    return kc if kc.get("depth", 0) > 0 else None


def _kill_chain_line(dossier: dict[str, Any]) -> str | None:
    """One-line ATT&CK attack-path summary for the underwriting memo."""
    kc = _kill_chain_attack(dossier)
    if not kc:
        return None
    techs = ", ".join(kc["technique_ids"])
    return (
        f"**Attack path (MITRE ATT&CK).** {kc['chain']} "
        f"({techs}), mapped from the package's observed capabilities."
    )


def _render_underwriting_memo(incident_id: str, dossier: dict[str, Any], report: dict[str, Any]) -> str:
    """Deterministic Control Evidence Memo, framed as an underwriting decision.

    Always renderable without the model. The verdict line is preserved so
    the verdict remains visible and auditable.
    """
    verdict = (report.get("verdict") or "unknown").lower()
    tier = _underwriting_tier(verdict, report.get("risk_level") or "")
    verdict_line = _format_verdict_line(incident_id, report)
    summary = report.get("summary") or ""
    premium = _premium_exclusion_line(incident_id, dossier, report)
    kill_chain = _kill_chain_line(dossier)
    findings = _format_findings(report)
    body = [
        "### Control Evidence Memo",
        "",
        verdict_line,
        "",
        f"**Risk tier.** {tier}",
        "",
        premium,
        "",
        kill_chain,
        "" if kill_chain else None,
        f"_Why:_ {summary}" if summary else "",
        "",
        "**Cited evidence**",
        "",
        findings,
    ]
    return "\n".join(line for line in body if line is not None)


def _render_lookup(incident_id: str, dossier: dict[str, Any], report: dict[str, Any]) -> str:
    """Lookup output is the underwriting Control Evidence Memo."""
    return _render_underwriting_memo(incident_id, dossier, report)


def narrate_underwriting(
    incident_id: str,
    dossier: dict[str, Any],
    report: dict[str, Any],
    history: list[dict[str, str]] | None = None,
) -> tuple[str | None, str, str | None]:
    """Ask the fine-tuned model to narrate the PINNED memo in underwriter voice.

    Returns ``(prose, route, error)``:
    - ``(text, "llm", None)`` when an endpoint is configured and responds.
    - ``(None, "router", None)`` when no endpoint is configured.
    - ``(None, "router", err)`` when an endpoint is configured but errored
      (surfaced, not hidden; the caller renders the deterministic memo).

    The model is given the pinned verdict + evidence and is instructed to
    explain, not to change, the decision. The verdict never comes from the
    model.
    """
    if not model_client.is_configured():
        return None, "router", None
    pinned = {
        "package": dossier.get("package"),
        "verdict": report.get("verdict"),
        "confidence": report.get("confidence"),
        "risk_level": report.get("risk_level"),
        "underwriting_tier": _underwriting_tier(
            report.get("verdict") or "", report.get("risk_level") or ""
        ),
        "primary_findings": report.get("primary_findings"),
        "summary": report.get("summary"),
        "mitre_attack_kill_chain": _kill_chain_attack(dossier),
    }
    user_msg = (
        "A UNIQA cyber-policy underwriter is assessing this applicant's "
        "dependency. The verdict and evidence below are PINNED by the "
        "ModuleWarden gate and are authoritative -- explain and frame them "
        "for the underwriter, do not change the verdict or invent findings. "
        "If mitre_attack_kill_chain is present, narrate it as the attack path "
        "in underwriter terms; cite only those technique ids, do not invent "
        "techniques.\n\n"
        + json.dumps(pinned, indent=2, ensure_ascii=False)
    )
    messages = [*(history or []), {"role": "user", "content": user_msg}]
    try:
        text = model_client.complete(
            system_prompt=_load_system_prompt(), messages=messages
        )
        return text, "llm", None
    except model_client.ModelEndpointError as exc:
        return None, "router", str(exc)


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
        if _load_pair(incident_id) is None:
            return ChatTurn(response_md=_render_unknown(facts), evidence={"intent": "lookup_unknown"})
        # Unified path: typed lookups and the CLI get the same model-backed
        # underwriting memo the sidebar button produces.
        return lookup_by_incident_id(incident_id)

    if intent == "lookup_unknown":
        return ChatTurn(response_md=_render_unknown(facts), evidence={"intent": "lookup_unknown"})

    if intent == "incident_overview":
        return ChatTurn(
            response_md="Which incident were you asking about? I have dossiers for: "
            + ", ".join(f"`{i}`" for i in _list_incidents())
            + ".",
            evidence={"intent": "incident_overview"},
        )

    if intent == "disambiguate":
        candidates = facts.get("candidates") or []
        listing = "\n".join(f"- `{c}`" for c in candidates)
        return ChatTurn(
            response_md=(
                "There are multiple incidents matching that name. Which "
                "version do you mean?\n\n"
                f"{listing}\n\n"
                "You can ask `look up <id>` or `look up <name>@<version>`."
            ),
            evidence={"intent": "disambiguate", "candidates": candidates},
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
