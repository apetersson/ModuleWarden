"""Bridge to the existing packages/audit-runner PI orchestrator.

The matrix runner's agentic arms (arms 3 and 4 in
``finetune/README.md``) shell out to a Node subprocess that invokes
``packages/audit-runner/dist/orchestrator.js``. That orchestrator runs
PI inside the audit container with custom RPC tools and submits a
structured verdict.

This module is a thin wrapper. It does not pretend to launch the
audit container itself; the operator is responsible for the container
being live and reachable. On a fresh dev box where the runner is not
running, the wrapper degrades to ``status='unavailable'`` so the matrix
runner can still complete the non-agentic arms 1 and 2.
"""

from __future__ import annotations

import json
import logging
import os
import shutil
import subprocess
import time
from pathlib import Path
from typing import Any

logger = logging.getLogger("modulewarden.pi_harness")


def _orchestrator_path(repo_root: Path) -> Path | None:
    """Return the orchestrator entry point if it has been built."""
    candidates = [
        repo_root / "packages" / "audit-runner" / "dist" / "orchestrator.js",
        repo_root / "packages" / "audit-runner" / "src" / "orchestrator.ts",
    ]
    for c in candidates:
        if c.exists():
            return c
    return None


def is_available(repo_root: Path) -> bool:
    """True when the PI harness can be invoked from this machine."""
    if shutil.which("node") is None:
        return False
    return _orchestrator_path(repo_root) is not None


def run_pi_audit(
    *,
    repo_root: Path,
    package_name: str,
    package_version: str,
    workspace_dir: Path,
    seed_report: dict[str, Any] | None = None,
    extra_env: dict[str, str] | None = None,
    timeout_s: float = 600.0,
) -> dict[str, Any]:
    """Invoke the PI audit orchestrator and return its structured result.

    The returned dict has shape::

        {
          "status": "ok" | "error" | "unavailable",
          "mode": "pi" | "tool-only" | "n/a",
          "elapsed_s": float,
          "tool_calls": int | None,
          "raw_output": str,
          "verdict": dict | None,
          "stderr": str,
        }

    ``mode="tool-only"`` flags a degraded orchestrator path where PI was
    unavailable (no MW_MODEL_ENDPOINT_BASE_URL set or RPC bridge down) and
    the orchestrator fell back to file-only inspection. The matrix runner
    uses this flag to annotate arms 3 and 4 distinctly from a real PI run.
    """
    t0 = time.monotonic()
    if not is_available(repo_root):
        return {
            "status": "unavailable",
            "mode": "n/a",
            "elapsed_s": round(time.monotonic() - t0, 3),
            "tool_calls": None,
            "raw_output": "",
            "verdict": None,
            "stderr": "audit-runner orchestrator not built or node not on PATH",
        }
    orch = _orchestrator_path(repo_root)
    assert orch is not None
    if orch.suffix == ".ts":
        return {
            "status": "unavailable",
            "mode": "n/a",
            "elapsed_s": round(time.monotonic() - t0, 3),
            "tool_calls": None,
            "raw_output": "",
            "verdict": None,
            "stderr": (
                "audit-runner not compiled; run pnpm --filter "
                "@modulewarden/audit-runner build before agentic arms."
            ),
        }

    env = os.environ.copy()
    env.update(
        {
            "MW_PACKAGE_NAME": package_name,
            "MW_PACKAGE_VERSION": package_version,
            "MW_WORKSPACE": str(workspace_dir),
        }
    )
    # Forward optional orchestrator gates from the parent env when set. The
    # orchestrator (packages/audit-runner/src/orchestrator.ts after e981833)
    # checks MW_MODEL_ENDPOINT_BASE_URL, MW_RPC_PORT, MW_RPC_TOKEN and
    # silently falls back to the file-only "tool-only" audit path if any are
    # absent. We do not invent defaults here, but pass them through so the
    # operator can opt into the full PI path by exporting them.
    for k in ("MW_MODEL_ENDPOINT_BASE_URL", "MW_RPC_PORT", "MW_RPC_TOKEN", "MW_AUDIT_TIMEOUT_MS"):
        if k in os.environ:
            env[k] = os.environ[k]
    if extra_env:
        env.update(extra_env)
    workspace_dir.mkdir(parents=True, exist_ok=True)
    if seed_report is not None:
        seed_path = workspace_dir / "seed-report.json"
        seed_path.write_text(json.dumps(seed_report, indent=2), encoding="utf-8")
        env["MW_SEED_REPORT"] = str(seed_path)

    try:
        proc = subprocess.run(
            ["node", str(orch)],
            env=env,
            capture_output=True,
            text=True,
            timeout=timeout_s,
            check=False,
        )
    except subprocess.TimeoutExpired as exc:
        return {
            "status": "error",
            "mode": "n/a",
            "elapsed_s": round(time.monotonic() - t0, 3),
            "tool_calls": None,
            "raw_output": exc.stdout or "",
            "verdict": None,
            "stderr": f"orchestrator timeout after {timeout_s}s",
        }

    elapsed = round(time.monotonic() - t0, 3)
    stdout = proc.stdout or ""
    verdict_path = workspace_dir / "output" / "verdict.json"
    verdict: dict[str, Any] | None = None
    tool_calls = None
    if verdict_path.exists():
        try:
            verdict = json.loads(verdict_path.read_text(encoding="utf-8"))
        except json.JSONDecodeError:
            verdict = None
    if verdict is None:
        # Fall back to stdout, which may contain the structured report.
        try:
            decoded = json.loads(stdout)
            if isinstance(decoded, dict):
                verdict = decoded
        except json.JSONDecodeError:
            pass
    if isinstance(verdict, dict):
        tc = verdict.get("tool_calls")
        if isinstance(tc, int):
            tool_calls = tc

    # Detect the orchestrator tool-only fallback path. If
    # MW_MODEL_ENDPOINT_BASE_URL was missing or the RPC bridge failed,
    # orchestrator.ts runs runToolOnlyAudit() and writes a verdict whose
    # riskSummary string carries "tool-only" or "File-only inspection".
    # Matrix-runner downstream uses this flag to distinguish a genuine PI
    # arm-3/4 result from a degraded inspection-only fallback.
    mode = "pi"
    if isinstance(verdict, dict):
        risk_summary = str(verdict.get("riskSummary") or verdict.get("risk_summary") or "").lower()
        if "tool-only" in risk_summary or "file-only inspection" in risk_summary:
            mode = "tool-only"

    return {
        "status": "ok" if proc.returncode == 0 else "error",
        "mode": mode,
        "elapsed_s": elapsed,
        "tool_calls": tool_calls,
        "raw_output": stdout,
        "verdict": verdict,
        "stderr": proc.stderr or "",
    }


__all__ = ["is_available", "run_pi_audit"]
