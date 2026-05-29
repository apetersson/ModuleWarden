"""Ingestion-time injection defenses: normalize + spotlight untrusted text.

Two independent, composable layers applied to the free-text fields of an
AuditDossier BEFORE the auditing model sees them:

1. normalize_field: strips invisible-unicode smuggling (the U+E0000-E007F
   tag block, zero-width chars, variation selectors) and NFC-normalizes.
   This eliminates the ascii-smuggling injection vector at preprocessing,
   which is cheaper and more reliable than training the model to spot it
   (Keysight 2025; arXiv:2603.00164).

2. datamark_field: Microsoft "spotlighting" datamarking (arXiv:2403.14720).
   Interleaves a marker through the whitespace of untrusted text so the
   model treats it as data, not instructions. Reduces injection
   attack-success-rate from >50% to <3% in the paper, with no measured
   utility loss. This is the inference-time prompt layer that composes
   with the training-time adversarial hardening in injection_hardening.py.

Defense in depth: normalize at ingestion + datamark in the prompt +
adversarial SFT data + the verdict-authoritative deterministic gate.
"""

from __future__ import annotations

import copy
import re
import unicodedata
from typing import Any, Iterable, Mapping

# U+E0000-E007F unicode tag block (invisible ASCII smuggling), zero-width
# chars, BOM, soft hyphen, and variation selectors.
_TAG_BLOCK = re.compile(r"[\U000E0000-\U000E007F]")
_ZERO_WIDTH = re.compile(r"[​‌‍﻿­]")
_VARIATION = re.compile(r"[︀-️\U000E0100-\U000E01EF]")

_FREETEXT_FIELDS = (
    "release_context",
    "diff_summary",
    "dependency_changes",
    "capability_deltas",
    "dynamic_observations",
    "evidence_index",
)


def normalize_field(text: str) -> str:
    """Strip invisible-unicode smuggling and NFC-normalize one string."""
    if not isinstance(text, str):
        return text
    text = _TAG_BLOCK.sub("", text)
    text = _ZERO_WIDTH.sub("", text)
    text = _VARIATION.sub("", text)
    return unicodedata.normalize("NFC", text)


def datamark_field(text: str, marker: str = "▁") -> str:
    """Spotlighting datamark: replace runs of whitespace with a marker so the
    model reads the field as data. Default marker is the SentencePiece space
    glyph (lower-one-eighth-block), which Qwen tokenizes as a single visible
    data token. Pass marker='^' for a plain-ASCII variant."""
    if not isinstance(text, str):
        return text
    return re.sub(r"\s+", marker, text.strip())


def _walk_normalize(value: Any) -> Any:
    if isinstance(value, str):
        return normalize_field(value)
    if isinstance(value, list):
        return [_walk_normalize(v) for v in value]
    if isinstance(value, dict):
        return {k: _walk_normalize(v) for k, v in value.items()}
    return value


def normalize_dossier(dossier: Mapping[str, Any]) -> dict[str, Any]:
    """Return a copy of the dossier with every free-text leaf normalized.

    Apply this at dossier-build time so an attacker's invisible-unicode
    payload is gone before tokenization. Structural fields (booleans,
    hashes, numbers) pass through untouched.
    """
    out = copy.deepcopy(dict(dossier))
    for field in _FREETEXT_FIELDS:
        if field in out:
            out[field] = _walk_normalize(out[field])
    return out


def contains_smuggled_unicode(text: str) -> bool:
    """True if the string carries any invisible-unicode smuggling. Useful as a
    cheap ingestion-time detector / telemetry signal."""
    if not isinstance(text, str):
        return False
    return bool(_TAG_BLOCK.search(text) or _ZERO_WIDTH.search(text) or _VARIATION.search(text))


# --- B5 secret redaction (BitGN-PAC reference, MIT; arXiv fit note 07 sec 2.2) ---
#
# Post-read redaction layer. The audit runner reads tarball source, READMEs and
# changelogs that may carry real credentials from the package repo. Strip known
# secret shapes BEFORE the text re-enters the auditing LLM context, so a leaked
# token never lands in the audit log. High-precision patterns only: every regex
# anchors on a vendor-specific prefix or structural marker to keep the
# false-positive rate near zero on ordinary package source.
#
# Each tuple is (KIND, pattern). KIND is emitted in the replacement token so the
# audit signal "a credential was present here" survives the redaction.
_SECRET_PATTERNS: tuple[tuple[str, re.Pattern[str]], ...] = (
    # PEM private-key blocks (RSA, EC, OPENSSH, generic). Match the whole block
    # including the BEGIN/END armor, across newlines.
    (
        "PEM_PRIVATE_KEY",
        re.compile(
            r"-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY-----.*?-----END (?:[A-Z0-9 ]+ )?PRIVATE KEY-----",
            re.DOTALL,
        ),
    ),
    # Anthropic API keys: sk-ant-... (prefix is vendor-specific).
    ("ANTHROPIC_KEY", re.compile(r"sk-ant-[A-Za-z0-9_-]{20,}")),
    # AWS access key id: AKIA + 16 uppercase-alnum.
    ("AWS_ACCESS_KEY", re.compile(r"\bAKIA[0-9A-Z]{16}\b")),
    # GitHub tokens: ghp_/gho_/ghs_/ghu_ + 36 chars.
    ("GITHUB_TOKEN", re.compile(r"\bgh[posu]_[A-Za-z0-9]{36}\b")),
    # JWT: three base64url segments, header begins eyJ and so does the payload.
    ("JWT", re.compile(r"\beyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+")),
    # OpenAI-style keys: sk- followed by >=20 base62 chars. Checked AFTER the
    # Anthropic pattern so sk-ant-... keeps its specific KIND label.
    ("OPENAI_KEY", re.compile(r"\bsk-[A-Za-z0-9]{20,}\b")),
)


def redact_secrets(text: str) -> str:
    """Replace high-confidence secret tokens in `text` with `[REDACTED:KIND]`.

    Covers AWS access keys, GitHub tokens, Anthropic and OpenAI credentials,
    JWTs, and PEM private-key blocks. Each pattern anchors on a vendor prefix or
    structural marker, so it does not maul ordinary package source.

    Idempotent: a second pass over already-redacted text is a no-op because the
    replacement token contains none of the secret shapes. Never raises; a
    non-string input is returned unchanged.
    """
    if not isinstance(text, str):
        return text
    for kind, pattern in _SECRET_PATTERNS:
        text = pattern.sub(f"[REDACTED:{kind}]", text)
    return text


__all__ = [
    "normalize_field",
    "datamark_field",
    "normalize_dossier",
    "contains_smuggled_unicode",
    "redact_secrets",
]
