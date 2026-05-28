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
    assert "do not have an audit dossier" in turn.response_md
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


def test_underwriting_implication_per_verdict():
    block_turn = handle_query("postmark-mcp@1.0.16")
    assert "supply-chain section" in block_turn.response_md.lower() or "control-class credit" in block_turn.response_md.lower()
    allow_turn = handle_query("lodash@4.17.21")
    assert "control-class credit" in allow_turn.response_md.lower() or "clean control signal" in allow_turn.response_md.lower()


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
