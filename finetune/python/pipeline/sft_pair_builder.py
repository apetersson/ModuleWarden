"""Pair (AuditDossier, AuditReport) into one ``modulewarden.sft_record.v1`` row.

The system message restates the auditor contract and pulls the
``policy_context.forbidden_output`` list from the dossier so the model
learns the constraints alongside the example. The user message is the
serialized dossier; the assistant message is the serialized report.
"""

from __future__ import annotations

import json
import logging
from typing import Any, Mapping

logger = logging.getLogger("modulewarden.sft_pair_builder")

_VALID_SOURCES = (
    "incident_replay",
    "benign_neighbor",
    "cve_diff",
    "dogfood_dependency",
    "synthetic_teacher",
    "manual_golden",
    "wiki_derived",
)

_VALID_SPLITS = ("train", "validation", "test")

_BASE_SYSTEM_PROMPT = (
    "You are ModuleWarden's package-version code auditor. Given exactly one "
    "AuditDossier JSON object as input, return exactly one AuditReport JSON object "
    "as output. The AuditReport must conform to schema modulewarden.audit_report.v1. "
    "Cite only evidence ids that appear in the dossier's evidence_index. Quarantine "
    "on uncertainty. Do not invent evidence references. Do not claim safety beyond "
    "the exact tarball hash in the dossier's package block."
)


def _system_message(dossier: Mapping[str, Any]) -> str:
    forbidden = (dossier.get("policy_context") or {}).get("forbidden_output") or []
    if not isinstance(forbidden, list):
        forbidden = []
    if not forbidden:
        return _BASE_SYSTEM_PROMPT
    bullet_list = "\n".join(f"- {item}" for item in forbidden if isinstance(item, str))
    return _BASE_SYSTEM_PROMPT + "\n\nAdditional constraints:\n" + bullet_list


def build_sft_record(
    dossier: Mapping[str, Any],
    report: Mapping[str, Any],
    *,
    split: str,
    source: str,
    record_id: str | None = None,
) -> dict[str, Any]:
    """Return a ``modulewarden.sft_record.v1`` dict.

    ``split`` must be one of train / validation / test.
    ``source`` must be one of the controlled values from the SFT schema.
    """
    if split not in _VALID_SPLITS:
        raise ValueError(f"invalid split {split!r}; expected one of {_VALID_SPLITS}")
    if source not in _VALID_SOURCES:
        raise ValueError(f"invalid source {source!r}; expected one of {_VALID_SOURCES}")

    audit_id = dossier.get("audit_id") or report.get("audit_id") or "audit_unknown"
    rec_id = record_id or f"sft_{audit_id}"

    record = {
        "schema_version": "modulewarden.sft_record.v1",
        "record_id": rec_id,
        "split": split,
        "source": source,
        "messages": [
            {"role": "system", "content": _system_message(dossier)},
            {
                "role": "user",
                "content": json.dumps(dossier, indent=2, sort_keys=False),
            },
            {
                "role": "assistant",
                "content": json.dumps(report, indent=2, sort_keys=False),
            },
        ],
    }
    return record


__all__ = ["build_sft_record"]
