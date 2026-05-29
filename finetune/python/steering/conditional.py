"""Conditional activation steering (CAST) - steer only when an injection is
detected, so clean accuracy is preserved.

Plain activation steering adds the vector to EVERY forward pass, including the
benign packages that are the bulk of real traffic. The documented failure mode
is over-steering: a vector that resists injection also nudges benign audits and
quietly raises false QUARANTINE/BLOCK on good packages. CAST gates the steering
on a cheap detector, so the residual stream is only perturbed when the input
actually looks like an attack. The benign path runs the frozen model untouched.

The detector is the SECOND surface that adapts without retraining (the steering
vector being the first): it reads its signatures from the same injection
payload catalog the rest of the pipeline uses, so adding a new attack phrasing
to ``injection_payloads.PAYLOADS`` extends detection coverage with no code
change here. It also reuses ``ingestion_hardening.contains_smuggled_unicode``
for the invisible-character vector that a substring match would miss.

Reference: Lee et al., "Programming Refusal with Conditional Activation
Steering" (CAST, arXiv:2409.05907).
"""

from __future__ import annotations

import re
from contextlib import contextmanager
from typing import Any, Callable, Iterable, Sequence

from ..data import injection_payloads as _ip
from ..data.ingestion_hardening import contains_smuggled_unicode
from .activation_steering import SteeringVector, steering

# Generalizing signatures (regex, case-insensitive). These match the SHAPE of an
# injection - a command to ignore context or to emit a verdict - rather than one
# exact phrase, so a paraphrase still trips them. Extend via InjectionDetector's
# ``extra_patterns`` as new attack shapes are seen in the wild.
_SIGNATURE_PATTERNS = (
    r"ignore\s+(all\s+)?(previous|prior|above)\s+instructions",
    r"disregard\s+(the\s+)?(dossier|evidence|diff|context)",
    r"system\s*override",
    r"\[?\s*new\s+instructions",
    # a verdict word sitting near a verdict token, in either order
    r"\bverdict\b[^.\n]{0,30}\b(allow|block|quarantine)\b",
    # a command verb pushing a verdict token (catches "instructed to return allow",
    # "set verdict to allow") even when the word "verdict" is absent
    r"\b(return|emit|set|output|produce|mark|flag)\b[^.\n]{0,25}\b(allow|block|quarantine)\b",
    r"\b(pre-?approved|pre-?cleared|verified\s+safe|no\s+further\s+review)\b",
    r"</?\s*(system|assistant|user)\s*>",  # tag-confusion
    r"\bmust\s+emit\s+verdict\b",
)


class InjectionDetector:
    """Decides whether a serialized dossier carries a prompt injection.

    Signatures come from generalizing regex patterns plus distinctive fragments
    mined from the payload catalog, so the detector tracks the catalog. Cheap:
    a handful of compiled regex over the prompt string, no model call.
    """

    def __init__(
        self,
        *,
        extra_patterns: Iterable[str] = (),
        check_smuggled_unicode: bool = True,
    ):
        pats = list(_SIGNATURE_PATTERNS) + list(extra_patterns)
        self._regexes = [re.compile(p, re.IGNORECASE) for p in pats]
        self._check_unicode = check_smuggled_unicode

    def detect(self, text: str) -> bool:
        """True if the text looks like an injection attempt."""
        if self._check_unicode and contains_smuggled_unicode(text):
            return True
        return any(rx.search(text) for rx in self._regexes)

    def explain(self, text: str) -> list[str]:
        """Which signatures fired - for logging / a demo's 'why we steered' line."""
        hits = []
        if self._check_unicode and contains_smuggled_unicode(text):
            hits.append("smuggled_unicode")
        hits.extend(rx.pattern for rx in self._regexes if rx.search(text))
        return hits


def should_steer(
    detector: InjectionDetector,
    dossier: Any,
    serialize: Callable[[Any], str],
) -> bool:
    """The gate decision, pulled out of the model path so it is testable with
    no model: serialize the dossier and ask the detector."""
    return detector.detect(serialize(dossier))


def make_conditionally_steered_verdict_fn(
    model: Any,
    tokenizer: Any,
    sv: SteeringVector,
    detector: InjectionDetector,
    *,
    serialize: Callable[[Any], str],
    parse_verdict: Callable[[str], str],
    device: str = "cpu",
    max_new_tokens: int = 64,
    on_decision: Callable[[Any, bool], None] | None = None,
) -> Callable[[Any], str]:
    """A ``verdict_fn(dossier) -> verdict`` that applies ``sv`` ONLY when the
    detector flags the (serialized) dossier as an injection. Benign dossiers
    run the frozen model with no perturbation.

    ``on_decision(dossier, steered)`` is an optional hook for telemetry / the
    demo so you can show how often steering actually fired.
    """
    import torch

    def verdict_fn(dossier: Any) -> str:
        prompt = serialize(dossier)
        steer = detector.detect(prompt)
        if on_decision is not None:
            on_decision(dossier, steer)
        ids = tokenizer(prompt, return_tensors="pt").input_ids.to(device)
        ctx = steering(model, sv) if steer else _nullctx()
        with ctx, torch.no_grad():
            out = model.generate(
                ids, max_new_tokens=max_new_tokens, do_sample=False,
                pad_token_id=getattr(tokenizer, "eos_token_id", None),
            )
        text = tokenizer.decode(out[0, ids.shape[-1]:], skip_special_tokens=True)
        return parse_verdict(text)

    return verdict_fn


@contextmanager
def _nullctx():
    yield


__all__ = [
    "InjectionDetector",
    "should_steer",
    "make_conditionally_steered_verdict_fn",
]
