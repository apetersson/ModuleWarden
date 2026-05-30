"""Conversational risk review assistant agent.

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
    """Load the risk-review system prompt. Wired in (was previously dead)."""
    try:
        return SYSTEM_PROMPT_PATH.read_text(encoding="utf-8")
    except OSError:
        return "You are the ModuleWarden Risk Review Assistant."


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
    # fine-tuned model is configured and responds, its risk-review narrative
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
            "**Decision: AVOID.** This release fails the supply-chain "
            "forecast. If the project has this version on the dependency "
            "surface, do not adopt it until the project pins to the "
            "last-known-clean release. The avoided downside is a live "
            "compromise reaching production."
        )
    if v == "quarantine":
        return (
            "**Decision: WAIT.** Adopt only with a condition: pin an "
            "allowlisted version, supply a maintainer attestation, or keep "
            "this dependency out of production until it clears."
        )
    if v == "allow":
        if r in {"none", "low"}:
            return (
                "**Decision: ADOPT.** Clean control signal. Safe to adopt "
                "for the software supply chain."
            )
        return (
            "**Decision: ADOPT with a watch.** Allowed by the gate; the "
            "model still flags residual risk. Treat as a positive signal "
            "but weight the residual risk before you adopt."
        )
    return ""


# ---------------------------------------------------------------------------
# Control Evidence Memo
#
# The verdict is pinned by the deterministic gate + the audit report. These
# functions translate that pinned verdict into the three fields a risk
# reviewer acts on: a risk tier, an adopt / wait / avoid decision, and the
# cited evidence. NONE of this is model-generated; the model (when
# configured) narrates this card, it does not produce it.
# ---------------------------------------------------------------------------


def _underwriting_tier(verdict: str, risk_level: str) -> str:
    """Map the pinned verdict + risk level to a risk-review decision tier."""
    v = (verdict or "").lower()
    r = (risk_level or "").lower()
    if v == "block":
        return "AVOID (refer to security; do not adopt until pinned clean)"
    if v == "quarantine":
        return "WATCH (remediation step required before you adopt)"
    if v == "allow":
        if r in {"none", "low"}:
            return "ADOPT (clean supply-chain control signal; safe to adopt)"
        return "WATCH (residual risk; adopt with a watch)"
    return "WATCH (verdict unavailable; manual review)"


def _premium_exclusion_line(incident_id: str, dossier: dict[str, Any], report: dict[str, Any]) -> str:
    """The adopt / wait / avoid decision line for the risk-review record."""
    v = (report.get("verdict") or "").lower()
    name = (dossier.get("package") or {}).get("name") or incident_id.rsplit("-", 1)[0]
    baseline = (dossier.get("baseline") or {}).get("version")
    clean_ref = f"@{baseline}" if baseline else " a last-known-clean release"
    if v == "block":
        return (
            f"**Decision: AVOID.** Do not adopt `{name}` at the audited version "
            f"until the project pins to {clean_ref}. The avoided downside is a "
            f"live compromise on this dependency reaching the build while it is "
            f"active."
        )
    if v == "quarantine":
        return (
            f"**Decision: WAIT.** Adopt only with a condition: pin an "
            f"allowlisted version of `{name}`, supply a maintainer attestation, "
            f"or keep it out of production until it clears."
        )
    if v == "allow":
        r = (report.get("risk_level") or "").lower()
        if r in {"none", "low"}:
            return (
                f"**Decision: ADOPT.** `{name}` is a positive control signal "
                f"and is safe to adopt for the software supply chain."
            )
        return (
            f"**Decision: ADOPT with a watch.** Weight the residual risk on "
            f"`{name}` before you adopt; keep it on the watch list."
        )
    return "**Decision: WATCH.** Manual risk review required."


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
    """One-line ATT&CK attack-path summary for the Control Evidence Memo."""
    kc = _kill_chain_attack(dossier)
    if not kc:
        return None
    techs = ", ".join(kc["technique_ids"])
    return (
        f"**Attack path (MITRE ATT&CK).** {kc['chain']} "
        f"({techs}), mapped from the package's observed capabilities."
    )


def _decepticon_chain_line(incident_id: str, dossier: dict[str, Any]) -> str | None:
    """Surface a Decepticon chain node's recommended action + blast radius.

    When the audited package appears in the Decepticon attack-chain wiki (or
    the curated-threat-chains.json it was seeded from), the Control Evidence
    Memo gains a one-line chain pattern with the observed blast radius and the
    recommended action. Optional enrichment, never the verdict.

    Guarded import, fail-soft: returns None if the wiki is unavailable so the
    demo never breaks. Looks up by package@version first (curated key), then
    falls back to the threat-actor class on the matching chain node.
    """
    try:
        import json as _json

        pkg = dossier.get("package") or {}
        name = pkg.get("name") or incident_id.rsplit("-", 1)[0]
        version = pkg.get("candidate_version") or incident_id.rsplit("-", 1)[-1]
        key = f"{name}@{version}"

        rider: str | None = None
        blast: int | None = None
        chain_name: str | None = None

        # Primary source: the curated JSON the chain nodes were seeded from.
        curated_path = REPO_ROOT / "demo" / "curated-threat-chains.json"
        if curated_path.exists():
            with curated_path.open(encoding="utf-8") as fh:
                curated = _json.load(fh)
            entry = curated.get(key)
            if entry and (entry.get("threat_actor") or "none") != "none":
                rider = entry.get("insurance_rider")
                blast = entry.get("estimated_blast_radius_usd")
                actor = entry.get("threat_actor") or ""
                chain_name = actor.replace("_", "-")

        if rider is None and blast is None:
            return None
        blast_str = f"${blast:,}" if isinstance(blast, int) and blast > 0 else "not quantified"
        rider_str = rider or "manual risk review"
        chain_str = f" ({chain_name})" if chain_name else ""
        return (
            f"**Chain pattern{chain_str}.** Decepticon wiki match: observed "
            f"blast radius {blast_str}; recommended action `{rider_str}`."
        )
    except Exception:
        return None


def _render_underwriting_memo(incident_id: str, dossier: dict[str, Any], report: dict[str, Any]) -> str:
    """Deterministic Control Evidence Memo, framed as an adopt / wait / avoid decision.

    Always renderable without the model. The verdict line is preserved so
    the verdict remains visible and auditable.
    """
    verdict = (report.get("verdict") or "unknown").lower()
    tier = _underwriting_tier(verdict, report.get("risk_level") or "")
    verdict_line = _format_verdict_line(incident_id, report)
    summary = report.get("summary") or ""
    premium = _premium_exclusion_line(incident_id, dossier, report)
    kill_chain = _kill_chain_line(dossier)
    chain_pattern = _decepticon_chain_line(incident_id, dossier)
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
        chain_pattern,
        "" if chain_pattern else None,
        f"_Why:_ {summary}" if summary else "",
        "",
        "**Cited evidence**",
        "",
        findings,
    ]
    return "\n".join(line for line in body if line is not None)


def _render_lookup(incident_id: str, dossier: dict[str, Any], report: dict[str, Any]) -> str:
    """Lookup output is the Control Evidence Memo."""
    return _render_underwriting_memo(incident_id, dossier, report)


def narrate_underwriting(
    incident_id: str,
    dossier: dict[str, Any],
    report: dict[str, Any],
    history: list[dict[str, str]] | None = None,
) -> tuple[str | None, str, str | None]:
    """Ask the fine-tuned model to narrate the PINNED memo in risk-reviewer voice.

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
        "A risk reviewer is assessing this project's dependency with a "
        "supply-chain forecasting tool. The verdict and evidence below are "
        "PINNED by the ModuleWarden gate and are authoritative -- explain and "
        "frame them for the reviewer, do not change the verdict or invent "
        "findings. Frame the call as adopt / wait / avoid. If "
        "mitre_attack_kill_chain is present, narrate it as the attack path "
        "in risk-review terms; cite only those technique ids, do not invent "
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
        "For a risk reviewer, the gate output is a structured, auditable "
        "control signal that a decision record can cite without trusting "
        "the project's self-attestation."
    )


def _render_help() -> str:
    return (
        "I help a risk reviewer reason about npm supply-chain risk on a "
        "project's dependencies. Things I can do:\n\n"
        "- **Look up a package.** Try `postmark-mcp@1.0.16` or "
        "`lodash@4.17.21`.\n"
        "- **Explain the deterministic gate.** Ask `what are the gate "
        "rules?` and I will walk the five rules.\n"
        "- **List incidents I have dossiers for.** Ask `list incidents`.\n"
        "- **Summarize a real supply-chain incident.** Ask about "
        "`postmark`, `Shai-Hulud`, `event-stream`, or `lodash`.\n\n"
        "Drop a package.json or pnpm-lock.yaml into the side panel "
        "(Streamlit UI) for a portfolio-style roll-up across the project."
    )


def _render_live_advisory(pkg: str) -> str:
    """Live GHSA + OSSF check for an arbitrary package (read-only metadata).

    Gated by MW_LIVE_ADVISORIES=1 so the test suite stays offline by default;
    the Streamlit app and CLI enable it. Fail-soft: returns "" on any error so
    the chat never breaks on a network hiccup. Turns the reviewer's "no
    dossier for that package" question into a real, sourced answer.
    """
    if os.environ.get("MW_LIVE_ADVISORIES") != "1":
        return ""
    try:
        from chat import live_advisories

        res = live_advisories.live_check(pkg)
    except Exception:
        return ""
    ghsa = res.get("ghsa", {})
    ossf = res.get("ossf", {})
    lines = [
        f"**Live advisory check for `{pkg}`** "
        f"(GitHub Advisory DB + OSSF malicious-packages, queried just now):"
    ]
    if ghsa.get("available"):
        if ghsa.get("count"):
            sev = ghsa.get("max_severity") or "n/a"
            mal = ghsa.get("malware_count", 0)
            ids = ", ".join(a["ghsa_id"] for a in ghsa.get("advisories", [])[:5] if a.get("ghsa_id"))
            mal_note = f", {mal} flagged malware-type" if mal else ""
            id_note = f" ({ids})" if ids else ""
            lines.append(f"- GHSA: {ghsa['count']} advisory record(s), highest severity {sev}{mal_note}{id_note}.")
        else:
            lines.append("- GHSA: no advisories on record for this package.")
    else:
        lines.append("- GHSA: live check unavailable right now.")
    if ossf.get("available"):
        if ossf.get("malicious"):
            reports = ", ".join(ossf.get("reports", [])[:3])
            lines.append(f"- OSSF malicious-packages: FLAGGED ({len(ossf.get('reports', []))} report(s): {reports}).")
        else:
            lines.append("- OSSF malicious-packages: not flagged.")
    else:
        lines.append("- OSSF: live check unavailable right now.")
    return "\n".join(lines)


def _render_unknown(facts: dict[str, Any]) -> str:
    pkg = facts.get("package")
    ver = facts.get("version")
    if pkg and ver:
        base = (
            f"I do not have a pre-audited dossier for `{pkg}@{ver}` in this "
            f"demo set. In the production pipeline, ModuleWarden would queue "
            f"the audit and return a verdict within seconds. The verdicts I "
            f"can walk in full are:\n\n"
            f"{_render_list()}"
        )
        live = _render_live_advisory(pkg)
        if live:
            return f"{live}\n\n{base}"
        return base
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
        # Control Evidence Memo the sidebar button produces.
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
