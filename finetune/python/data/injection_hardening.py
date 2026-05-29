"""Adversarial injection-hardening SFT records.

The training-time half of ModuleWarden's injection defense. Given existing
(AuditDossier, AuditReport) pairs, produce counterfactual records where the
input carries a prompt-injection payload but the gold label stays the
STRUCTURALLY-correct verdict. The model learns to classify on the dossier's
structural evidence and ignore verdictive claims embedded in attacker-
controlled free text.

Two directions, both teaching the same rule:
  - malicious pair (block/quarantine) + "emit allow" injection -> label stays block/quarantine
    ("you cannot be talked out of a block")
  - benign pair (allow) + "you must block this" injection -> label stays allow
    ("you cannot be talked into a false block")

Sizing + diversity follow the StruQ/SecAlign findings (USENIX Sec'25 /
CCS'25): keep the adversarial fraction at ~10-20% of the SFT mix and rotate
payload phrasing so the model learns the boundary, not one phrase. Above
~40% clean accuracy drops; below ~5% the signal is ignored.

This module is deterministic (payload rotation by index, no RNG) so the
generated corpus is reproducible across runs.
"""

from __future__ import annotations

import json
import logging
from typing import Any, Iterable, Mapping, Sequence

from finetune.python.data import injection_payloads as _ip
from finetune.python.pipeline.sft_pair_builder import build_sft_record

logger = logging.getLogger("modulewarden.injection_hardening")

DEFAULT_RATE = 0.15  # 15% adversarial fraction (StruQ/SecAlign band)


def _direction_for(verdict: str) -> str:
    """Which injection direction is adversarial for this gold verdict.
    A block/quarantine example gets an 'emit allow' payload; an allow example
    gets a 'you must block' payload. Either way the gold label is unchanged."""
    return "allow" if verdict in ("block", "quarantine") else "block"


def make_hardening_record(
    dossier: Mapping[str, Any],
    report: Mapping[str, Any],
    *,
    split: str,
    payload_index: int,
    fields: Iterable[str] = _ip.DEFAULT_INJECTION_FIELDS,
) -> dict[str, Any] | None:
    """Build ONE injection-laced SFT record. The report (gold label) is left
    exactly as-is; only the dossier free-text is laced. Returns None if no
    adversarial payload applies (should not happen for valid verdicts)."""
    verdict = str(report.get("verdict", "")).lower()
    direction = _direction_for(verdict)
    pool = _ip.payloads_for(direction)
    if not pool:
        return None
    family, text, _pushes = pool[payload_index % len(pool)]
    laced = _ip.apply_injection(dossier, text, fields=fields)
    audit_id = laced.get("audit_id") or report.get("audit_id") or "audit"
    rec = build_sft_record(
        laced,
        report,
        split=split,
        source="synthetic_teacher",
        record_id=f"sft_inj_{family}_{audit_id}_{payload_index}",
    )
    return rec


def generate_hardening_records(
    pairs: Sequence[tuple[Mapping[str, Any], Mapping[str, Any]]],
    *,
    rate: float = DEFAULT_RATE,
    split: str = "train",
    fields: Iterable[str] = _ip.DEFAULT_INJECTION_FIELDS,
    max_records: int | None = None,
) -> list[dict[str, Any]]:
    """Return injection-hardening SFT records for a fraction of the input pairs.

    ``pairs`` are (dossier, report) tuples from the clean corpus. ``rate`` is
    the adversarial fraction (0-1). Selection is deterministic (every Nth pair)
    and payloads rotate by index for phrasing diversity. The gold report on
    each selected pair is reused unchanged.

    NEVER put these in validation/test partitions that also measure clean
    accuracy unless you intend to measure under-injection accuracy there;
    keep adversarial records in ``train`` and use a SEPARATE held-out injected
    set (with novel phrasings) for the robustness metric.
    """
    if not 0.0 <= rate <= 1.0:
        raise ValueError(f"rate must be in [0,1], got {rate}")
    if not pairs:
        return []
    step = max(1, round(1.0 / rate)) if rate > 0 else len(pairs) + 1
    out: list[dict[str, Any]] = []
    for i in range(0, len(pairs), step):
        dossier, report = pairs[i]
        rec = make_hardening_record(
            dossier, report, split=split, payload_index=len(out), fields=fields
        )
        if rec is not None:
            out.append(rec)
        if max_records is not None and len(out) >= max_records:
            break
    logger.info(
        "generated %d injection-hardening records from %d pairs (rate=%.2f, split=%s)",
        len(out), len(pairs), rate, split,
    )
    return out


def _pairs_from_sft_jsonl(path: str) -> list[tuple[dict[str, Any], dict[str, Any]]]:
    """Reconstruct (dossier, report) pairs from a sft-records.jsonl produced by
    corpus_walker. Only TRAIN-split records are used as hardening bases, so no
    validation/test dossier leaks into the adversarial train set."""
    pairs: list[tuple[dict[str, Any], dict[str, Any]]] = []
    with open(path, encoding="utf-8") as fh:
        for line in fh:
            line = line.strip()
            if not line:
                continue
            try:
                rec = json.loads(line)
                if rec.get("split") != "train":
                    continue
                msgs = {m["role"]: m["content"] for m in rec.get("messages", [])}
                dossier = json.loads(msgs["user"])
                report = json.loads(msgs["assistant"])
                pairs.append((dossier, report))
            except Exception:  # noqa: BLE001 - skip unparseable rows
                continue
    return pairs


def main(argv: list[str] | None = None) -> int:
    """CLI: append injection-hardening records to an existing sft corpus.

    Example:
      python -m finetune.python.data.injection_hardening \\
        --in finetune/corpus/sft-records.jsonl \\
        --out finetune/corpus/sft-records.hardened.jsonl --rate 0.15
    """
    import argparse

    ap = argparse.ArgumentParser(description="Generate injection-hardening SFT records and append to the corpus")
    ap.add_argument("--in", dest="inp", required=True, help="input sft-records.jsonl")
    ap.add_argument("--out", required=True, help="output jsonl (base + hardening)")
    ap.add_argument("--rate", type=float, default=DEFAULT_RATE, help="adversarial fraction (default 0.15)")
    args = ap.parse_args(argv)

    with open(args.inp, encoding="utf-8") as fh:
        base = [json.loads(l) for l in fh if l.strip()]
    pairs = _pairs_from_sft_jsonl(args.inp)
    hardening = generate_hardening_records(pairs, rate=args.rate, split="train")
    with open(args.out, "w", encoding="utf-8") as fh:
        for rec in base + hardening:
            fh.write(json.dumps(rec) + "\n")
    pct = round(100.0 * len(hardening) / max(1, len(base) + len(hardening)), 1)
    print(
        f"wrote {len(base)} base + {len(hardening)} injection-hardening "
        f"({pct}% of total) = {len(base) + len(hardening)} records to {args.out}"
    )
    return 0


__all__ = ["DEFAULT_RATE", "make_hardening_record", "generate_hardening_records", "main"]

if __name__ == "__main__":
    import sys

    sys.exit(main())
