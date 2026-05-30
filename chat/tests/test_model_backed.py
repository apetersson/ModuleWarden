"""Tests for the model-backed risk-review path.

Verifies the centerpiece: the fine-tuned model narrates the verdict, but
the verdict is ALWAYS pinned by the gate/report and the model can never
invent or change it. Covers the three modes: no-endpoint (deterministic),
endpoint-up (model narrates, verdict pinned), endpoint-error (surfaced,
deterministic memo still renders the real verdict).
"""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[2]
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

from chat import agent, model_client


@pytest.fixture(autouse=True)
def _reset_model_client(monkeypatch):
    # Default: no endpoint configured (deterministic mode), and ensure env
    # does not accidentally configure one during the test run.
    for var in (
        "MW_MODEL_ENDPOINT_BASE_URL",
        "MW_MODEL_ENDPOINT_API_KEY",
        "MW_MODEL_ENDPOINT_MODEL",
        "OPENAI_BASE_URL",
        "OPENAI_API_KEY",
        "OPENAI_MODEL",
    ):
        monkeypatch.delenv(var, raising=False)
    yield


def test_no_endpoint_is_deterministic():
    assert model_client.is_configured() is False
    turn = agent.lookup_by_incident_id("postmark-mcp-1.0.16")
    assert turn.route == "router"
    assert turn.evidence["model_backed"] is False
    assert "Control Evidence Memo" in turn.response_md
    assert turn.evidence["verdict"] == "block"


def test_endpoint_resolution_prefers_mw_vars(monkeypatch):
    monkeypatch.setenv("MW_MODEL_ENDPOINT_BASE_URL", "http://x:8000/v1")
    monkeypatch.setenv("MW_MODEL_ENDPOINT_MODEL", "mw-finetune")
    monkeypatch.setenv("OPENAI_API_KEY", "sk-should-be-ignored")
    cfg = model_client.resolve_config()
    assert cfg is not None
    assert cfg.source == "MW_MODEL_ENDPOINT"
    assert cfg.model == "mw-finetune"


def test_model_narrates_but_verdict_stays_pinned(monkeypatch):
    captured = {}

    def fake_complete(*, system_prompt, messages, **kw):
        captured["system"] = system_prompt
        captured["user"] = messages[-1]["content"]
        return "AVOID. Elevated supply-chain exposure; do not adopt yet."

    monkeypatch.setattr(model_client, "is_configured", lambda: True)
    monkeypatch.setattr(model_client, "complete", fake_complete)

    turn = agent.lookup_by_incident_id("postmark-mcp-1.0.16")
    assert turn.route == "llm"
    assert turn.evidence["model_backed"] is True
    # Verdict comes from the report, never the model.
    assert turn.evidence["verdict"] == "block"
    # Model prose leads; pinned memo is retained beneath as the audit trail.
    assert "AVOID. Elevated" in turn.response_md
    assert "Control Evidence Memo" in turn.response_md
    # The model was handed the pinned verdict and told not to change it.
    assert '"verdict": "block"' in captured["user"]
    assert "do not change the verdict" in captured["user"]
    # The risk-review system prompt was actually loaded and sent.
    assert "Risk Review Assistant" in captured["system"]


def test_endpoint_error_is_surfaced_not_silent(monkeypatch):
    def boom(*a, **k):
        raise model_client.ModelEndpointError("connection refused")

    monkeypatch.setattr(model_client, "is_configured", lambda: True)
    monkeypatch.setattr(model_client, "complete", boom)

    turn = agent.lookup_by_incident_id("postmark-mcp-1.0.16")
    assert turn.route == "router"
    assert turn.evidence.get("endpoint_error")
    # Deterministic memo still renders the real verdict.
    assert "AVOID" in turn.response_md
    assert turn.evidence["verdict"] == "block"


def test_complete_raises_when_unconfigured():
    with pytest.raises(model_client.ModelEndpointError):
        model_client.complete(system_prompt="x", messages=[{"role": "user", "content": "y"}])
