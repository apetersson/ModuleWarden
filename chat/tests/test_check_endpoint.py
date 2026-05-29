"""Tests for the rehearsal endpoint check."""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[2]
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

from chat import check_endpoint


@pytest.fixture(autouse=True)
def _clear_endpoint_env(monkeypatch):
    for var in (
        "MW_MODEL_ENDPOINT_BASE_URL",
        "MW_MODEL_ENDPOINT_API_KEY",
        "MW_MODEL_ENDPOINT_MODEL",
        "OPENAI_BASE_URL",
        "OPENAI_API_KEY",
        "OPENAI_MODEL",
    ):
        monkeypatch.delenv(var, raising=False)


def test_deterministic_mode_exits_zero(capsys):
    """No endpoint configured is a valid, demo-safe state -> exit 0."""
    rc = check_endpoint.main()
    assert rc == 0
    out = capsys.readouterr().out
    assert "DETERMINISTIC MODE" in out


def test_unreachable_endpoint_exits_one(monkeypatch, capsys):
    """A configured-but-down endpoint must fail the check (exit 1)."""
    monkeypatch.setenv("MW_MODEL_ENDPOINT_BASE_URL", "http://127.0.0.1:1")
    monkeypatch.setenv("MW_MODEL_ENDPOINT_MODEL", "test")
    rc = check_endpoint.main()
    assert rc == 1
    out = capsys.readouterr().out
    assert "ENDPOINT ERROR" in out
