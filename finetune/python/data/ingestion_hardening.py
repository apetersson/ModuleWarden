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


__all__ = [
    "normalize_field",
    "datamark_field",
    "normalize_dossier",
    "contains_smuggled_unicode",
]
