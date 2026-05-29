"""Tests for B5 secret redaction (redact_secrets).

All synthetic credentials: structurally valid shapes, no real keys. Verifies
each pattern fires, the KIND label survives, ordinary source is left alone,
and the function is idempotent and total (never raises).
"""

from __future__ import annotations

import pytest

from finetune.python.data.ingestion_hardening import redact_secrets


def test_aws_access_key_redacted():
    text = "config: AKIAIOSFODNN7EXAMPLE is the key"
    out = redact_secrets(text)
    assert "AKIAIOSFODNN7EXAMPLE" not in out
    assert "[REDACTED:AWS_ACCESS_KEY]" in out


def test_github_token_redacted():
    token = "ghp_" + "a" * 36
    out = redact_secrets(f"export GH_TOKEN={token}")
    assert token not in out
    assert "[REDACTED:GITHUB_TOKEN]" in out


@pytest.mark.parametrize("prefix", ["ghp_", "gho_", "ghs_", "ghu_"])
def test_all_github_token_prefixes(prefix):
    token = prefix + "b" * 36
    out = redact_secrets(token)
    assert "[REDACTED:GITHUB_TOKEN]" == out


def test_anthropic_key_redacted_with_specific_kind():
    key = "sk-ant-api03-" + "X" * 40
    out = redact_secrets(f"ANTHROPIC_API_KEY={key}")
    assert key not in out
    # Anthropic must keep its specific KIND, not fall through to OPENAI_KEY.
    assert "[REDACTED:ANTHROPIC_KEY]" in out
    assert "OPENAI_KEY" not in out


def test_openai_key_redacted():
    key = "sk-" + "T3BlbkFJ" * 4  # 32 base62 chars after sk-
    out = redact_secrets(f"openai key: {key}")
    assert key not in out
    assert "[REDACTED:OPENAI_KEY]" in out


def test_jwt_redacted():
    jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTYifQ.dumm_sig_segment-AB"
    out = redact_secrets(f"Authorization: Bearer {jwt}")
    assert jwt not in out
    assert "[REDACTED:JWT]" in out


def test_pem_private_key_block_redacted():
    pem = (
        "-----BEGIN RSA PRIVATE KEY-----\n"
        "MIIBOgIBAAJBAKj34GkxFhD90vcNLYLInFEX6Ppy1tPf9Cnzj4p4WGeKLs1Pt8Q\n"
        "uKUpRKfFLfRYC9AIKjbJTWit+CqvjV2x2zE=\n"
        "-----END RSA PRIVATE KEY-----"
    )
    out = redact_secrets(f"key file:\n{pem}\nend")
    assert "MIIBOgIBAAJBAKj" not in out
    assert "[REDACTED:PEM_PRIVATE_KEY]" in out
    # Surrounding text preserved.
    assert out.startswith("key file:")
    assert out.endswith("end")


def test_multiple_secrets_in_one_blob():
    text = (
        "AWS=AKIAIOSFODNN7EXAMPLE "
        "GH=ghp_" + "c" * 36 + " "
        "OAI=sk-" + "Z" * 24
    )
    out = redact_secrets(text)
    assert "[REDACTED:AWS_ACCESS_KEY]" in out
    assert "[REDACTED:GITHUB_TOKEN]" in out
    assert "[REDACTED:OPENAI_KEY]" in out
    assert "AKIA" not in out


def test_ordinary_source_untouched():
    # Realistic package source that must NOT trip the high-precision patterns.
    src = (
        "import { createHash } from 'crypto';\n"
        "const skipList = ['node_modules'];  // sk-ish but too short\n"
        "function ghpHelper() { return 42; }\n"
        "const AKIA = 'not-a-key';\n"  # AKIA without 16 trailing alnum
    )
    assert redact_secrets(src) == src


def test_idempotent():
    token = "ghp_" + "d" * 36
    once = redact_secrets(f"token {token}")
    twice = redact_secrets(once)
    assert once == twice
    assert "[REDACTED:GITHUB_TOKEN]" in twice


def test_never_raises_on_non_string():
    assert redact_secrets(None) is None
    assert redact_secrets(123) == 123
    assert redact_secrets(["a"]) == ["a"]


def test_empty_string():
    assert redact_secrets("") == ""
