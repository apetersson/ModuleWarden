"""4-arm eval matrix per finetune/README.md.

Arms:

1. base Qwen3.6-27B + one-shot prompt (dossier as input)
2. fine-tuned Qwen3.6-27B + same one-shot prompt
3. base Qwen3.6-27B + PI agentic harness via packages/audit-runner
4. fine-tuned Qwen3.6-27B + PI agentic harness seeded with arm-2 report

For each arm, every test-set case is evaluated and 7 metrics are recorded.
Results write to ``finetune/python/eval/results/matrix-{timestamp}.json``.

The model arms (1, 2) are implemented against the HF transformers
``pipeline('text-generation', ...)`` API so this script is fully usable
on a single GPU for the smoke test, even with a 1.5B substitute model.
The agentic arms (3, 4) shell out via ``pi_harness_wrapper`` and fail
early if the orchestrator is not available or not built.

Usage::

    python -m finetune.python.eval.matrix_runner \\
        --sft-records finetune/corpus/sft-records.jsonl \\
        --base-model Qwen/Qwen3.6-27B-Instruct \\
        --finetuned-model models/mw-qwen36-v1 \\
        --arms 1,2 \\
        --max-cases 50 \\
        --output finetune/python/eval/results/
"""

from __future__ import annotations

import argparse
import json
import logging
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable, Mapping

from .metrics import aggregate_arm_metrics, per_case_metrics
from .pi_harness_wrapper import run_pi_audit

logger = logging.getLogger("modulewarden.matrix_runner")

_DEFAULT_MAX_NEW_TOKENS = 1024
_VALID_ARMS = (1, 2, 3, 4)


def _read_test_records(
    sft_records_path: Path,
    *,
    max_cases: int | None,
    split: str = "test",
) -> list[dict[str, Any]]:
    """Read SFT records for the requested split. Returns raw record dicts."""
    out: list[dict[str, Any]] = []
    with sft_records_path.open("r", encoding="utf-8") as fh:
        for line in fh:
            stripped = line.strip()
            if not stripped:
                continue
            try:
                rec = json.loads(stripped)
            except json.JSONDecodeError:
                continue
            if not isinstance(rec, dict):
                continue
            if rec.get("split") != split:
                continue
            out.append(rec)
            if max_cases is not None and len(out) >= max_cases:
                break
    return out


def _extract_dossier_and_report(record: Mapping[str, Any]) -> tuple[dict[str, Any], dict[str, Any]]:
    """Pull dossier and ground-truth report from one SFT record."""
    msgs = record.get("messages") or []
    dossier: dict[str, Any] = {}
    report: dict[str, Any] = {}
    for m in msgs:
        if not isinstance(m, Mapping):
            continue
        role = m.get("role")
        content = m.get("content")
        if not isinstance(content, str):
            continue
        if role == "user" and not dossier:
            try:
                dossier = json.loads(content)
            except json.JSONDecodeError:
                dossier = {}
        elif role == "assistant" and not report:
            try:
                report = json.loads(content)
            except json.JSONDecodeError:
                report = {}
    return dossier, report


def _build_user_prompt(dossier: Mapping[str, Any]) -> str:
    return (
        "Audit this package version. Respond with exactly one JSON object "
        "conforming to modulewarden.audit_report.v1. Cite only evidence ids "
        "from the dossier's evidence_index.\n\n"
        + json.dumps(dossier, indent=2)
    )


def _hf_generate(
    *,
    model_path: str,
    system_prompt: str,
    user_prompt: str,
    max_new_tokens: int,
) -> tuple[str, float]:
    """Run one generation against an HF model. Returns (text, elapsed_s).

    Imports are deferred so the module imports cleanly without torch/HF.
    """
    try:
        import torch  # noqa: F401
        from transformers import AutoModelForCausalLM, AutoTokenizer  # noqa: F401
    except ImportError as exc:
        raise RuntimeError(
            "transformers + torch are required for arms 1 and 2. "
            "pip install -e .[eval]"
        ) from exc

    from transformers import AutoModelForCausalLM, AutoTokenizer

    tok = AutoTokenizer.from_pretrained(model_path, trust_remote_code=True)
    if tok.pad_token is None:
        tok.pad_token = tok.eos_token
    model = AutoModelForCausalLM.from_pretrained(
        model_path,
        torch_dtype="auto",
        device_map="auto",
        trust_remote_code=True,
    )
    model.eval()
    messages = [
        {"role": "system", "content": system_prompt},
        {"role": "user", "content": user_prompt},
    ]
    if hasattr(tok, "apply_chat_template"):
        prompt = tok.apply_chat_template(messages, tokenize=False, add_generation_prompt=True)
    else:
        prompt = f"{system_prompt}\n\n{user_prompt}"

    import torch as _torch

    inputs = tok(prompt, return_tensors="pt").to(model.device)
    t0 = time.monotonic()
    with _torch.no_grad():
        out = model.generate(
            **inputs,
            max_new_tokens=max_new_tokens,
            do_sample=False,
            temperature=0.0,
            pad_token_id=tok.pad_token_id,
        )
    elapsed = time.monotonic() - t0
    text = tok.decode(out[0][inputs["input_ids"].shape[1] :], skip_special_tokens=True)
    return text, elapsed


def _system_prompt_for_arm() -> str:
    return (
        "You are ModuleWarden's package-version code auditor. Given exactly one "
        "AuditDossier JSON object as input, return exactly one AuditReport JSON object "
        "conforming to schema modulewarden.audit_report.v1. Cite only evidence ids "
        "from the dossier's evidence_index. Quarantine on uncertainty."
    )


def _run_arm_oneshot(
    arm: int,
    *,
    model_path: str,
    cases: list[Mapping[str, Any]],
    max_new_tokens: int,
) -> list[dict[str, Any]]:
    """Arms 1 and 2: one-shot model call per case."""
    rows: list[dict[str, Any]] = []
    sys_prompt = _system_prompt_for_arm()
    for record in cases:
        dossier, expected = _extract_dossier_and_report(record)
        user_prompt = _build_user_prompt(dossier)
        try:
            text, elapsed = _hf_generate(
                model_path=model_path,
                system_prompt=sys_prompt,
                user_prompt=user_prompt,
                max_new_tokens=max_new_tokens,
            )
        except Exception as exc:  # noqa: BLE001
            logger.exception("arm %d generation failed for %s: %s", arm, dossier.get("audit_id"), exc)
            rows.append(
                {
                    "audit_id": dossier.get("audit_id"),
                    "arm": arm,
                    "error": str(exc),
                }
            )
            continue
        row = per_case_metrics(
            dossier=dossier,
            expected_report=expected,
            raw_output=text,
            elapsed_s=elapsed,
            tool_calls=0,
            case_type=str(record.get("source") or ""),
        )
        row["arm"] = arm
        row["model"] = model_path
        rows.append(row)
    return rows


def _run_arm_agentic(
    arm: int,
    *,
    repo_root: Path,
    cases: list[Mapping[str, Any]],
    workspace_root: Path,
    seed_reports: dict[str, dict[str, Any]] | None,
    timeout_s: float,
) -> list[dict[str, Any]]:
    """Arms 3 and 4: PI agentic run per case.

    Fails early via :func:`run_pi_audit` if the orchestrator is not available,
    not compiled, or node is not on PATH.
    """
    rows: list[dict[str, Any]] = []
    for record in cases:
        dossier, expected = _extract_dossier_and_report(record)
        audit_id = str(dossier.get("audit_id") or "audit_unknown")
        pkg = (dossier.get("package") or {}).get("name") or "unknown"
        ver = (dossier.get("package") or {}).get("candidate_version") or "0.0.0"
        seed = (seed_reports or {}).get(audit_id) if seed_reports else None
        result = run_pi_audit(
            repo_root=repo_root,
            package_name=str(pkg),
            package_version=str(ver),
            workspace_dir=workspace_root / audit_id,
            seed_report=seed,
            timeout_s=timeout_s,
        )
        row = per_case_metrics(
            dossier=dossier,
            expected_report=expected,
            raw_output=result.get("raw_output") or "",
            elapsed_s=result.get("elapsed_s"),
            tool_calls=result.get("tool_calls"),
            case_type=str(record.get("source") or ""),
        )
        row["arm"] = arm
        row["pi_status"] = result.get("status")
        row["pi_mode"] = result.get("mode")
        rows.append(row)
    return rows


def run_matrix(
    *,
    sft_records: Path,
    base_model: str,
    finetuned_model: str | None,
    arms: Iterable[int],
    max_cases: int | None,
    output_dir: Path,
    workspace_root: Path,
    repo_root: Path,
    max_new_tokens: int = _DEFAULT_MAX_NEW_TOKENS,
    timeout_s: float = 600.0,
) -> dict[str, Any]:
    """Run the selected arms; write matrix-{timestamp}.json; return the summary."""
    arms_list = [a for a in arms if a in _VALID_ARMS]
    cases = _read_test_records(sft_records, max_cases=max_cases)
    logger.info("loaded %d test cases from %s", len(cases), sft_records)

    arm_rows: dict[int, list[dict[str, Any]]] = {}
    seed_reports: dict[str, dict[str, Any]] = {}

    if 1 in arms_list:
        logger.info("arm 1: base model one-shot (%s)", base_model)
        arm_rows[1] = _run_arm_oneshot(
            1, model_path=base_model, cases=cases, max_new_tokens=max_new_tokens
        )

    if 2 in arms_list:
        if finetuned_model is None:
            logger.warning("arm 2 skipped: --finetuned-model not provided")
            arm_rows[2] = []
        else:
            logger.info("arm 2: fine-tuned model one-shot (%s)", finetuned_model)
            arm_rows[2] = _run_arm_oneshot(
                2, model_path=finetuned_model, cases=cases, max_new_tokens=max_new_tokens
            )
        # Build seed reports from arm 2 outputs for arm 4.
        for row in arm_rows.get(2) or []:
            aid = row.get("audit_id")
            if isinstance(aid, str) and row.get("model_verdict"):
                # We do not actually need the parsed JSON here; per_case_metrics
                # already parsed it. Re-serialise the verdict-bearing row for the seed.
                seed_reports[aid] = {
                    "schema_version": "modulewarden.audit_report.v1",
                    "audit_id": aid,
                    "verdict": row.get("model_verdict"),
                    "summary": "Arm-2 model brief (seed for arm 4)",
                }

    if 3 in arms_list:
        logger.info("arm 3: base model + PI agentic harness")
        arm_rows[3] = _run_arm_agentic(
            3,
            repo_root=repo_root,
            cases=cases,
            workspace_root=workspace_root / "arm3",
            seed_reports=None,
            timeout_s=timeout_s,
        )

    if 4 in arms_list:
        logger.info("arm 4: fine-tuned model brief + PI agentic harness")
        arm_rows[4] = _run_arm_agentic(
            4,
            repo_root=repo_root,
            cases=cases,
            workspace_root=workspace_root / "arm4",
            seed_reports=seed_reports or None,
            timeout_s=timeout_s,
        )

    aggregates = {str(arm): aggregate_arm_metrics(arm_rows.get(arm) or []) for arm in arms_list}
    output_dir.mkdir(parents=True, exist_ok=True)
    timestamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    out_path = output_dir / f"matrix-{timestamp}.json"
    summary = {
        "schema_version": "modulewarden.eval_matrix.v1",
        "timestamp": timestamp,
        "sft_records": str(sft_records),
        "base_model": base_model,
        "finetuned_model": finetuned_model,
        "arms_run": arms_list,
        "n_cases": len(cases),
        "max_new_tokens": max_new_tokens,
        "aggregate_metrics": aggregates,
        "per_case": {str(arm): arm_rows.get(arm) or [] for arm in arms_list},
    }
    out_path.write_text(json.dumps(summary, indent=2), encoding="utf-8")
    logger.info("wrote eval matrix to %s", out_path)
    return summary


def _build_arg_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(description="ModuleWarden 4-arm eval matrix runner")
    p.add_argument(
        "--sft-records",
        type=Path,
        default=Path("finetune/corpus/sft-records.jsonl"),
        help="Path to sft_record.v1 JSONL; the test split is selected automatically.",
    )
    p.add_argument(
        "--base-model",
        default="Qwen/Qwen3.6-27B-Instruct",
        help="HF id of the base model.",
    )
    p.add_argument(
        "--finetuned-model",
        default=None,
        help="Path or HF id of the fine-tuned model (required for arms 2 and 4).",
    )
    p.add_argument(
        "--arms",
        default="1,2",
        help="Comma-separated arms to run from {1,2,3,4}. Default 1,2.",
    )
    p.add_argument("--max-cases", type=int, default=None)
    p.add_argument("--max-new-tokens", type=int, default=_DEFAULT_MAX_NEW_TOKENS)
    p.add_argument(
        "--output-dir",
        type=Path,
        default=Path("finetune/python/eval/results"),
    )
    p.add_argument(
        "--workspace-root",
        type=Path,
        default=Path("finetune/python/eval/_workspaces"),
        help="Per-case scratch dirs the PI harness writes into.",
    )
    p.add_argument(
        "--repo-root",
        type=Path,
        default=Path("."),
        help="Path to the ModuleWarden repo root; used to find audit-runner.",
    )
    p.add_argument("--timeout-s", type=float, default=600.0)
    p.add_argument("-v", "--verbose", action="store_true")
    return p


def main(argv: list[str] | None = None) -> int:
    args = _build_arg_parser().parse_args(argv)
    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s %(message)s",
    )
    arms = [int(a.strip()) for a in args.arms.split(",") if a.strip().isdigit()]
    if not args.sft_records.exists():
        logger.error("sft records not found: %s", args.sft_records)
        return 2
    summary = run_matrix(
        sft_records=args.sft_records,
        base_model=args.base_model,
        finetuned_model=args.finetuned_model,
        arms=arms,
        max_cases=args.max_cases,
        output_dir=args.output_dir,
        workspace_root=args.workspace_root,
        repo_root=args.repo_root,
        max_new_tokens=args.max_new_tokens,
        timeout_s=args.timeout_s,
    )
    print(json.dumps({"aggregate_metrics": summary["aggregate_metrics"]}, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
