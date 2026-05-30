"""Decepticon inference-client contracts: no fine-tune, no re-abliteration, GGUF-served.

Loads the module by path so the test is independent of sys.path layout.
"""

from __future__ import annotations

import importlib.util
import sys
from pathlib import Path

import pytest

_MC_PATH = Path(__file__).resolve().parents[1] / "decepticon" / "model_client.py"


def _load():
    spec = importlib.util.spec_from_file_location("decepticon_model_client", _MC_PATH)
    mod = importlib.util.module_from_spec(spec)
    assert spec and spec.loader
    # Register before exec: @dataclass under `from __future__ import annotations`
    # resolves types via sys.modules[cls.__module__].
    sys.modules[spec.name] = mod
    spec.loader.exec_module(mod)
    return mod


mc = _load()


def _clear_env(monkeypatch):
    for k in (
        "DECEPTICON_MODEL_ENDPOINT_BASE_URL",
        "DECEPTICON_MODEL_ENDPOINT_API_KEY",
        "DECEPTICON_MODEL_ENDPOINT_MODEL",
        "OPENAI_BASE_URL",
        "OPENAI_API_KEY",
        "OPENAI_MODEL",
    ):
        monkeypatch.delenv(k, raising=False)


def test_requires_abliteration_is_false():
    # Decepticon consumes a pre-abliterated GGUF as-is.
    assert mc.requires_abliteration() is False


def test_module_never_imports_training_or_abliteration():
    # Hard contract: inference only. No fine-tune, no re-abliteration.
    src = _MC_PATH.read_text(encoding="utf-8")
    code_lines = [ln for ln in src.splitlines() if ln.strip().startswith(("import ", "from "))]
    code = "\n".join(code_lines)
    for forbidden in ("abliteration", "abliterate", "import trl", "import peft", "get_peft_model", "sft_lora"):
        assert forbidden not in code, f"Decepticon must not pull in {forbidden!r}"


def test_resolve_none_when_unconfigured(monkeypatch):
    _clear_env(monkeypatch)
    assert mc.resolve_config() is None
    assert mc.is_configured() is False


def test_decepticon_endpoint_wins_and_defaults_to_gguf_model(monkeypatch):
    _clear_env(monkeypatch)
    monkeypatch.setenv("DECEPTICON_MODEL_ENDPOINT_BASE_URL", "http://127.0.0.1:8081/v1/")
    cfg = mc.resolve_config()
    assert cfg is not None
    assert cfg.source == "DECEPTICON_MODEL_ENDPOINT"
    assert cfg.base_url == "http://127.0.0.1:8081/v1"  # trailing slash stripped
    assert cfg.model == "heretic-v2"  # default points at the pre-abliterated GGUF


def test_openai_fallback(monkeypatch):
    _clear_env(monkeypatch)
    monkeypatch.setenv("OPENAI_BASE_URL", "http://localhost:11434/v1")
    cfg = mc.resolve_config()
    assert cfg is not None and cfg.source == "OPENAI"


def test_complete_raises_when_unconfigured(monkeypatch):
    _clear_env(monkeypatch)
    with pytest.raises(mc.ModelEndpointError):
        mc.complete(system_prompt="x", messages=[{"role": "user", "content": "y"}])


def test_narrate_attack_chain_raises_when_unconfigured(monkeypatch):
    # No silent degrade: an unconfigured endpoint surfaces, it does not fake output.
    _clear_env(monkeypatch)
    chain = {"chain": "Initial Access -> Exfiltration", "technique_ids": ["T1195.002", "T1041"], "steps": []}
    with pytest.raises(mc.ModelEndpointError):
        mc.narrate_attack_chain(chain, package="evil-pkg@1.2.3")


def test_narrate_empty_chain_returns_deterministic_without_model(monkeypatch):
    # An empty pinned chain (gate flagged a capability the mapper does not cover) must
    # NOT reach the model, which could invent techniques. It returns a deterministic
    # line even with no endpoint configured, proving it short-circuits before the call.
    _clear_env(monkeypatch)
    out = mc.narrate_attack_chain({"technique_ids": [], "steps": [], "chain": ""}, package="evil-pkg@9.9.9")
    assert "No MITRE ATT&CK techniques are pinned" in out
    assert "evil-pkg@9.9.9" in out
