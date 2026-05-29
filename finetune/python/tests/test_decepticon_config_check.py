"""Decepticon HPC config preflight: ready offline, fails on an unreachable endpoint."""

from __future__ import annotations

from finetune.python.decepticon import config_check

_ENDPOINT_ENV = (
    "DECEPTICON_MODEL_ENDPOINT_BASE_URL",
    "DECEPTICON_MODEL_ENDPOINT_API_KEY",
    "DECEPTICON_MODEL_ENDPOINT_MODEL",
    "OPENAI_BASE_URL",
    "OPENAI_API_KEY",
    "OPENAI_MODEL",
)


def test_ready_offline(monkeypatch):
    for k in _ENDPOINT_ENV:
        monkeypatch.delenv(k, raising=False)
    report = config_check.run_checks()
    assert report["ready"] is True
    names = {r["check"] for r in report["results"]}
    assert {"imports", "adversary_offline", "hard_negative_records", "model_endpoint"} <= names
    # offline: no hard failures, endpoint is a WARN not a FAIL
    assert not any(r["status"] == "FAIL" for r in report["results"])
    ep = next(r for r in report["results"] if r["check"] == "model_endpoint")
    assert ep["status"] == "WARN"


def test_fails_on_unreachable_endpoint(monkeypatch):
    for k in _ENDPOINT_ENV:
        monkeypatch.delenv(k, raising=False)
    # a port nothing is listening on -> connection refused -> FAIL
    monkeypatch.setenv("DECEPTICON_MODEL_ENDPOINT_BASE_URL", "http://127.0.0.1:59997/v1")
    report = config_check.run_checks()
    ep = next(r for r in report["results"] if r["check"] == "model_endpoint")
    assert ep["status"] == "FAIL"
    assert report["ready"] is False
