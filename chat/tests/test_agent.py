"""Tests for the deterministic underwriter-assistant agent.

The router has no LLM dependency and is the path used during the live
demo, so it must be stable across runs.
"""

from __future__ import annotations

import subprocess
import sys
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[2]
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

from chat.agent import (
    _detect_intent,
    _list_incidents,
    handle_query,
    lookup_by_incident_id,
)


def test_help_intent_detected():
    intent, _ = _detect_intent("help")
    assert intent == "help"
    intent, _ = _detect_intent("what can you do")
    assert intent == "help"


def test_list_intent_detected():
    intent, _ = _detect_intent("list incidents")
    assert intent == "list"
    intent, _ = _detect_intent("what packages do you have")
    assert intent == "list"


def test_gate_intent_detected():
    intent, _ = _detect_intent("what are the gate rules")
    assert intent == "gate"
    intent, _ = _detect_intent("explain the policy gate")
    assert intent == "gate"


def test_package_at_version_parsed():
    intent, facts = _detect_intent("look up postmark-mcp@1.0.16")
    assert intent == "lookup"
    assert facts["package"] == "postmark-mcp"
    assert facts["version"] == "1.0.16"
    assert facts["incident_id"] == "postmark-mcp-1.0.16"


def test_package_at_version_without_fixture_is_lookup_unknown():
    intent, facts = _detect_intent("audit acme-fake-pkg@9.9.9")
    assert intent == "lookup_unknown"
    assert facts["package"] == "acme-fake-pkg"
    assert facts["version"] == "9.9.9"


def test_handle_query_postmark_block():
    turn = handle_query("look up postmark-mcp@1.0.16")
    assert "BLOCK" in turn.response_md
    assert "critical" in turn.response_md
    assert turn.evidence["intent"] == "lookup"
    assert turn.evidence["verdict"] == "block"


def test_handle_query_lodash_allow():
    turn = handle_query("audit lodash@4.17.21")
    assert "ALLOW" in turn.response_md
    assert turn.evidence["verdict"] == "allow"


def test_handle_query_unknown_package():
    turn = handle_query("audit acme-fake-pkg@9.9.9")
    assert "do not have a pre-audited dossier" in turn.response_md
    assert turn.evidence["intent"] == "lookup_unknown"


def test_handle_query_list():
    turn = handle_query("list incidents")
    assert "postmark-mcp-1.0.16" in turn.response_md
    assert turn.evidence["intent"] == "list"


def test_handle_query_gate():
    turn = handle_query("what are the gate rules?")
    assert "release-age" in turn.response_md
    assert "install-scripts" in turn.response_md
    assert "source-match" in turn.response_md
    assert "SRI checksum" in turn.response_md
    assert "allowlist" in turn.response_md


def test_handle_query_freeform_offers_help():
    turn = handle_query("hi there")
    assert "help" in turn.response_md.lower()


def test_underwriting_memo_per_verdict():
    """Lookup output is the Control Evidence Memo with tier + premium/exclusion."""
    block_turn = handle_query("postmark-mcp@1.0.16")
    md = block_turn.response_md
    assert "Control Evidence Memo" in md
    assert "Risk tier" in md
    assert "DECLINE" in md
    assert "Premium / exclusion" in md
    allow_turn = handle_query("lodash@4.17.21")
    assert "ACCEPT" in allow_turn.response_md
    assert "credit" in allow_turn.response_md.lower()


def test_block_memo_includes_attack_kill_chain():
    """The compromised release memo cites the MITRE ATT&CK kill chain."""
    md = handle_query("postmark-mcp@1.0.16").response_md
    assert "MITRE ATT&CK" in md
    assert "T1195.002" in md  # supply-chain compromise leads
    assert "T1041" in md  # exfiltration closes the chain


def test_clean_release_has_no_kill_chain():
    """A clean release with no capability_deltas shows no attack-path line."""
    md = handle_query("lodash@4.17.21").response_md
    assert "MITRE ATT&CK" not in md


def test_cli_single_message():
    proc = subprocess.run(
        [sys.executable, "-m", "chat.cli", "look up postmark-mcp@1.0.16"],
        cwd=REPO_ROOT,
        capture_output=True,
        text=True,
        timeout=15,
    )
    assert proc.returncode == 0, proc.stderr
    assert "BLOCK" in proc.stdout
    assert "postmark-mcp" in proc.stdout


def test_cli_list_incidents():
    proc = subprocess.run(
        [sys.executable, "-m", "chat.cli", "--list-incidents"],
        cwd=REPO_ROOT,
        capture_output=True,
        text=True,
        timeout=15,
    )
    assert proc.returncode == 0
    for incident in _list_incidents():
        assert incident in proc.stdout


# ---------------------------------------------------------------------------
# Regression tests for the routing bugs fixed in fix/post-merge-sweep
# ---------------------------------------------------------------------------


def test_bare_incident_id_routes_to_lookup():
    """`lodash-4.17.21` typed directly should be a lookup, not lookup_unknown.

    Before the fix, only `package@version` matched; an incident id with one
    hyphen in the package name (lodash-4.17.21) would not parse as a
    pkg@ver and would fall through to lookup_unknown.
    """
    for incident in _list_incidents():
        intent, facts = _detect_intent(incident)
        assert intent == "lookup", (
            f"bare incident id {incident!r} should route to lookup, got {intent}"
        )
        assert facts["incident_id"] == incident


def test_streamlit_sidebar_lookup_returns_real_verdict():
    """lookup_by_incident_id is the direct UI shortcut; must produce a real verdict.

    Catches the original sidebar bug where the button reconstructed
    `lodash-4.17.21@4.17.21` and got `lookup_unknown` back.
    """
    turn = lookup_by_incident_id("lodash-4.17.21")
    assert "ALLOW" in turn.response_md
    assert turn.evidence["intent"] == "lookup"
    assert turn.evidence["verdict"] == "allow"

    turn = lookup_by_incident_id("postmark-mcp-1.0.16")
    assert "BLOCK" in turn.response_md
    assert turn.evidence["verdict"] == "block"


def test_explicit_version_in_message_wins_over_lex_order():
    """`verdict for postmark-mcp v1.0.16` returned 1.0.12 before the fix.

    The incident loop matched both postmark-mcp incidents on the family
    name and returned the first one in sorted order (1.0.12). With the
    fix, the explicit version mention in the message picks 1.0.16.
    """
    intent, facts = _detect_intent("verdict for postmark-mcp v1.0.16")
    assert intent == "lookup"
    assert facts["incident_id"] == "postmark-mcp-1.0.16"

    intent, facts = _detect_intent("audit postmark-mcp 1.0.12 please")
    assert intent == "lookup"
    assert facts["incident_id"] == "postmark-mcp-1.0.12"


def test_ambiguous_family_name_disambiguates_rather_than_lex_first():
    """`tell me about postmark-mcp` without a version no longer silently picks 1.0.12."""
    intent, facts = _detect_intent("tell me about postmark-mcp")
    assert intent == "disambiguate"
    cands = facts.get("candidates") or []
    assert "postmark-mcp-1.0.12" in cands
    assert "postmark-mcp-1.0.16" in cands


def test_disambiguate_response_lists_candidates():
    """The disambiguate intent rendering walks the candidates."""
    turn = handle_query("is postmark-mcp safe")
    assert turn.evidence["intent"] == "disambiguate"
    assert "postmark-mcp-1.0.12" in turn.response_md
    assert "postmark-mcp-1.0.16" in turn.response_md


def test_single_match_family_does_not_disambiguate():
    """`what about lodash` should auto-pick the only lodash incident."""
    intent, facts = _detect_intent("what about lodash")
    assert intent == "lookup"
    assert facts["incident_id"] == "lodash-4.17.21"
