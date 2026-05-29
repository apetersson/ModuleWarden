"""Augment SFT training targets with a MITRE ATT&CK kill-chain narrative.

For each SFT record (dossier -> report), this computes the deterministic
ATT&CK kill chain from the dossier's capability_deltas and injects it into
the TARGET report as a `kill_chain_narrative` field. After fine-tuning on the
augmented data, the model learns to EMIT the kill chain alongside the verdict
- so the kill chain becomes a real model output, not a post-hoc lookup. The
deterministic mapper remains the authoritative grounding (the same source of
truth used at inference), which is exactly the verdict-pinning discipline
applied to the technique ids.

Safety: reads and writes JSON text only. No package code is executed, no
tarball is fetched, no Decepticon process runs. The kill chain is derived
from the static capability signals the dossier already carries.

Usage:
    python -m finetune.python.pipeline.decepticon_augmentor \
        --in finetune/corpus/sft-records.jsonl \
        --out finetune/corpus/sft-records.attck.jsonl
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any

REPO_ROOT = Path(__file__).resolve().parents[3]
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

from finetune.python.decepticon.mapper import kill_chain_narrative

DEFAULT_IN = REPO_ROOT / "finetune" / "corpus" / "sft-records.jsonl"
DEFAULT_OUT = REPO_ROOT / "finetune" / "corpus" / "sft-records.attck.jsonl"


def _insert_kill_chain_early(report: dict[str, Any], kc: dict[str, Any]) -> dict[str, Any]:
    """Insert kill_chain_narrative early in the report, right after risk_level
    (else after verdict, else first).

    Appending it last buried it ~76% through a long report (~1100 tokens in),
    past the eval/serving generation budget, so the model never reached it and
    kill_chain_emitted scored 0%. Placing it near the top lets the model emit
    verdict + attack path in the first ~120 tokens. JSON object keys are
    unordered, so this does not change the audit_report schema, only the
    emission reachability of the chain.
    """
    anchor = "risk_level" if "risk_level" in report else ("verdict" if "verdict" in report else None)
    if anchor is None:
        return {"kill_chain_narrative": kc, **report}
    out: dict[str, Any] = {}
    for key, value in report.items():
        out[key] = value
        if key == anchor:
            out["kill_chain_narrative"] = kc
    return out


def augment_record(rec: dict[str, Any]) -> tuple[dict[str, Any], bool]:
    """Return (augmented_record, changed). changed=False when no chain applies."""
    msgs = rec.get("messages") or []
    if len(msgs) < 3:
        return rec, False
    # messages: [system, user(dossier), assistant(report)]
    try:
        dossier = json.loads(msgs[1]["content"])
    except Exception:
        return rec, False
    kc = kill_chain_narrative(dossier.get("capability_deltas") or [])
    if kc["depth"] == 0:
        return rec, False  # no capabilities -> no chain, leave target honest
    try:
        report = json.loads(msgs[-1]["content"])
    except Exception:
        return rec, False
    if not isinstance(report, dict):
        return rec, False
    report = _insert_kill_chain_early(report, kc)
    new_msgs = list(msgs)
    new_msgs[-1] = {**msgs[-1], "content": json.dumps(report, ensure_ascii=False)}
    new_rec = {**rec, "messages": new_msgs}
    return new_rec, True


def augment_jsonl(in_path: Path, out_path: Path) -> dict[str, int]:
    total = 0
    augmented = 0
    with in_path.open(encoding="utf-8") as fh, out_path.open("w", encoding="utf-8") as out:
        for line in fh:
            line = line.strip()
            if not line:
                continue
            rec = json.loads(line)
            total += 1
            new_rec, changed = augment_record(rec)
            if changed:
                augmented += 1
            out.write(json.dumps(new_rec, ensure_ascii=False) + "\n")
    return {"total": total, "augmented": augmented, "unchanged": total - augmented}


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Augment SFT targets with ATT&CK kill chains")
    parser.add_argument("--in", dest="in_path", default=str(DEFAULT_IN))
    parser.add_argument("--out", dest="out_path", default=str(DEFAULT_OUT))
    args = parser.parse_args(argv)

    in_path = Path(args.in_path)
    out_path = Path(args.out_path)
    if not in_path.exists():
        raise SystemExit(f"input not found: {in_path}")
    stats = augment_jsonl(in_path, out_path)
    print(
        f"augmented {stats['augmented']}/{stats['total']} records "
        f"({stats['unchanged']} had no capabilities, left honest) -> {out_path}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
