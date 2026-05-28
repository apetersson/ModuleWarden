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
    """Wrap outlines.generate.json to reject evidence_refs outside the allowlist."""

    def __init__(self, base_generator: Any, allowed_refs: list[str]) -> None:
        self._generator = base_generator
        self._allowed = set(allowed_refs)

    def __call__(self, prompt: str, max_tokens: int = 1024) -> ConstrainedAuditReport:
        report = self._generator(prompt, max_tokens=max_tokens)
        # Strip any invented refs rather than fail the generation.
        # Honest fallback: cite less, never cite wrong.
        for finding in report.primary_findings:
            finding.evidence_refs = [
                ref for ref in finding.evidence_refs if ref in self._allowed
            ]
        return report


def generate_audit_report(generator: Any, dossier_text: str) -> ConstrainedAuditReport:
    """Convenience wrapper that emits a structurally-valid AuditReport."""
    return generator(dossier_text)


__all__ = [
    "ConstrainedAuditReport",
    "ModelFinding",
    "generate_audit_report",
    "load_constrained_generator",
]
