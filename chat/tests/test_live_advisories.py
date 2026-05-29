"""Tests for live GHSA + OSSF advisory lookups (mocked, fully offline)."""

from __future__ import annotations

import sys
import urllib.error
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[2]
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

from chat import live_advisories


def test_check_ghsa_parses_advisories(monkeypatch):
    fake = [
        {"ghsa_id": "GHSA-aaaa", "summary": "code injection", "severity": "high", "type": "reviewed"},
        {"ghsa_id": "GHSA-bbbb", "summary": "malware", "severity": "critical", "type": "malware"},
    ]
    monkeypatch.setattr(live_advisories, "_get_json", lambda url, timeout: fake)
    res = live_advisories.check_ghsa("evil-pkg")
    assert res["available"] is True
    assert res["count"] == 2
    assert res["malware_count"] == 1
    assert res["max_severity"] == "critical"


def test_check_ghsa_fail_soft(monkeypatch):
    def boom(url, timeout):
        raise urllib.error.URLError("no network")

    monkeypatch.setattr(live_advisories, "_get_json", boom)
    res = live_advisories.check_ghsa("whatever")
    assert res["available"] is False
    assert "error" in res


def test_ossf_flagged_when_reports_present(monkeypatch):
    monkeypatch.setattr(
        live_advisories, "_get_json",
        lambda url, timeout: [{"name": "MAL-2025-46974.json"}, {"name": "README.md"}],
    )
    res = live_advisories.check_ossf_malicious("debug")
    assert res["available"] is True
    assert res["malicious"] is True
    assert res["reports"] == ["MAL-2025-46974.json"]


def test_ossf_not_flagged_on_404(monkeypatch):
    def not_found(url, timeout):
        raise urllib.error.HTTPError(url, 404, "Not Found", {}, None)

    monkeypatch.setattr(live_advisories, "_get_json", not_found)
    res = live_advisories.check_ossf_malicious("totally-clean-pkg")
    assert res["available"] is True
    assert res["malicious"] is False


def test_render_unknown_includes_live_when_enabled(monkeypatch):
    """When MW_LIVE_ADVISORIES=1, the unknown-package reply leads with live data."""
    monkeypatch.setenv("MW_LIVE_ADVISORIES", "1")
    monkeypatch.setattr(
        live_advisories, "_get_json",
        lambda url, timeout: (
            [{"ghsa_id": "GHSA-zzzz", "summary": "x", "severity": "critical", "type": "malware"}]
            if "advisories" in url else []
        ),
    )
    from chat.agent import handle_query

    md = handle_query("audit some-rando-pkg@1.0.0").response_md
    assert "Live advisory check" in md
    assert "GHSA-zzzz" in md


def test_render_unknown_offline_by_default(monkeypatch):
    """Without the env flag, no live call is made and no live line appears."""
    monkeypatch.delenv("MW_LIVE_ADVISORIES", raising=False)
    from chat.agent import handle_query

    md = handle_query("audit another-rando-pkg@2.0.0").response_md
    assert "Live advisory check" not in md
    assert "do not have a pre-audited dossier" in md
