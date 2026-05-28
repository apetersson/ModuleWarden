"""Constrained-decoding wrapper for the SecLens-R eval matrix.

Wired into matrix_runner.py as a post-training inference path that
guarantees:
- The model output parses as JSON
- The verdict field is one of {allow, block, quarantine}
- Every cited evidence_ref exists in the dossier's evidence_index

This is a STRUCTURAL guarantee, not a semantic one. The model can still
produce the wrong verdict, just a valid one. See backlog/decisions/
decision-3 for the full discussion.

Usage:

    from finetune.python.eval.constrained_decode import (
        load_constrained_generator,
        generate_audit_report,
    )

    generator = load_constrained_generator(
        model_path="models/mw-qwen25-7b-v1",
        allowed_evidence_refs=["ev.file.001", "ev.cap.001", "ev.net.001"],
    )
    report = generate_audit_report(generator, dossier_text)
"""

from __future__ import annotations

import logging
from typing import Any, Iterable, Literal

from pydantic import BaseModel, Field

logger = logging.getLogger("modulewarden.constrained_decode")


class ModelFinding(BaseModel):
    """A primary_findings entry in an audit_report.v1."""

    title: str = Field(..., min_length=4, max_length=200)
    severity: Literal["low", "medium", "high", "critical"]
    rationale: str = Field(..., min_length=8, max_length=2000)
    evidence_refs: list[str] = Field(default_factory=list)


class ConstrainedAuditReport(BaseModel):
    """A subset of audit_report.v1 enforced at decoding time.

    Validates verdict, confidence, risk_level, and that every cited
    evidence ref is in the dossier-supplied allowlist. The schema
    sidesteps fields whose freedom we want to preserve (developer-safe
    summary, security-admin summary, agent-check recommendations).
    """

    schema_version: Literal["modulewarden.audit_report.v1"] = "modulewarden.audit_report.v1"
    verdict: Literal["allow", "block", "quarantine"]
    confidence: Literal["low", "medium", "high"]
    risk_level: Literal["none", "low", "medium", "high", "critical"]
    summary: str = Field(..., min_length=8, max_length=600)
    primary_findings: list[ModelFinding] = Field(default_factory=list)
    developer_safe_summary: str = Field(..., min_length=8, max_length=600)
    security_admin_summary: str = Field(..., min_length=8, max_length=600)


def load_constrained_generator(
    model_path: str,
    allowed_evidence_refs: Iterable[str],
) -> Any:
    """Load a Qwen2.5-Coder checkpoint and wrap it for JSON-constrained generation.

    Lazily imports outlines so this module is importable without the
    `inference` optional dep installed (e.g. during pure-schema unit
    tests).
    """
    import outlines

    refs = sorted(set(allowed_evidence_refs))
    logger.info(
        "loading constrained generator from %s with %d allowed refs",
        model_path,
        len(refs),
    )

    model = outlines.models.transformers(model_path)

    # The Pydantic schema enforces verdict + confidence + risk_level
    # closedness at decode time. The ref allowlist is enforced by
    # post-decode validation below; outlines does not yet let us mask
    # arbitrary list-element string content at the FSM layer, but a
    # post-decode rejector is sufficient for guaranteeing zero
    # invented refs in the eval output.
    generator = outlines.generate.json(model, ConstrainedAuditReport)
    return _RefRestrictedGenerator(generator, allowed_refs=refs)


class _RefRestrictedGenerator:
    """Wrap outlines.generate.json to reject evidence_refs outside the allowlist.

    This is the post-decode rejector: it strips an off-allowlist ref after
    the model has already spent it, so an invented ref turns into a dropped
    (uncited) finding. ``dropped_ref_count`` records how often that happens
    so the eval can see the cost instead of the drop being silent.

    The during-decode alternative is
    :mod:`finetune.python.eval.minionerec_constraint`
    (ported from MiniOneRec): it masks the model to the allowlist while it
    decodes, so the model picks a real ref instead of dropping an invented
    one, which lifts evidence_citation_accuracy rather than only guaranteeing
    zero invented refs.
    """

    def __init__(self, base_generator: Any, allowed_refs: list[str]) -> None:
        self._generator = base_generator
        self._allowed = set(allowed_refs)
        self.dropped_ref_count = 0

    def __call__(self, prompt: str, max_tokens: int = 1024) -> ConstrainedAuditReport:
        report = self._generator(prompt, max_tokens=max_tokens)
        # Strip any invented refs rather than fail the generation:
        # cite less, never cite wrong. A drop is a measurable miss, not a
        # silent one - count and log it so the during-decode path's gain is
        # observable in the eval matrix.
        for finding in report.primary_findings:
            kept = [ref for ref in finding.evidence_refs if ref in self._allowed]
            dropped = len(finding.evidence_refs) - len(kept)
            if dropped:
                self.dropped_ref_count += dropped
                logger.warning(
                    "dropped %d off-allowlist evidence_ref(s) from finding %r; "
                    "consider the during-decode path in minionerec_constraint",
                    dropped,
                    finding.title,
                )
            finding.evidence_refs = kept
        return report


def generate_audit_report(generator: Any, dossier_text: str) -> ConstrainedAuditReport:
    """Convenience wrapper that emits a structurally-valid AuditReport."""
    return generator(dossier_text)


def select_supporting_refs(
    model: Any,
    tokenizer: Any,
    finding_prompt: str,
    allowed_evidence_refs: Iterable[str],
    *,
    max_refs: int = 4,
    device: str = "cuda",
) -> list[str]:
    """During-decode evidence-ref selection (MiniOneRec-ported path).

    The post-decode :class:`_RefRestrictedGenerator` strips invented refs
    after the fact. This instead masks the model to the dossier's evidence
    allowlist while it decodes, so it can only emit ids that exist in the
    dossier. Use it to fill ``primary_findings[*].evidence_refs`` after the
    outlines pass has produced the JSON skeleton.

    Needs a loaded HF causal-LM ``model`` and its ``tokenizer`` (same
    requirement as :func:`load_constrained_generator`). The trie and the
    logits processor come from
    :mod:`finetune.python.eval.minionerec_constraint`.

    Returns the selected evidence ref ids in decode order, de-duplicated and
    capped at ``max_refs``.
    """
    import torch

    from finetune.python.eval.minionerec_constraint import (
        build_evidence_prefix_fn,
        make_evidence_logits_processor,
    )

    refs = sorted(set(allowed_evidence_refs))
    if not refs:
        return []

    prompt_ids = tokenizer(finding_prompt, return_tensors="pt").input_ids.to(device)
    prompt_length = prompt_ids.shape[-1]
    prefix_fn, _trie = build_evidence_prefix_fn(tokenizer, refs, prompt_length)

    selected: list[str] = []
    for _ in range(max_refs):
        processors = make_evidence_logits_processor(
            prefix_fn, num_beams=1, eos_token_id=tokenizer.eos_token_id
        )
        with torch.no_grad():
            out = model.generate(
                prompt_ids,
                logits_processor=processors,
                max_new_tokens=max(len(tokenizer.encode(r)) for r in refs) + 2,
                num_beams=1,
                do_sample=False,
                pad_token_id=tokenizer.eos_token_id,
            )
        decoded = tokenizer.decode(
            out[0, prompt_length:], skip_special_tokens=True
        ).strip()
        if not decoded or decoded not in refs or decoded in selected:
            break
        selected.append(decoded)
    return selected


__all__ = [
    "ConstrainedAuditReport",
    "ModelFinding",
    "generate_audit_report",
    "load_constrained_generator",
    "select_supporting_refs",
]
