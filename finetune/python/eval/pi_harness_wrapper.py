"""Bridge to the existing packages/audit-runner PI orchestrator.

The matrix runner's agentic arms (arms 3 and 4 in
``finetune/README.md``) shell out to a Node subprocess that invokes
``packages/audit-runner/dist/orchestrator.js``. That orchestrator runs
PI inside the audit container with custom RPC tools and submits a
structured verdict.

This module fails early if the orchestrator binary is not found or not
built. The caller is responsible for ensuring the orchestrator is
compiled and available before invoking this module.
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

    Returns
    -------
    dict with keys:
        status : "ok" | "error"
        mode : "pi"
        elapsed_s : float
        tool_calls : int | None
        raw_output : str
        verdict : dict | None
        stderr : str

    Raises
    ------
    RuntimeError
        If the orchestrator binary is not found, not compiled, or node is
        not on PATH. The caller must ensure preconditions are met before
        invoking this function.
    """
    t0 = time.monotonic()
    if not is_available(repo_root):
        raise RuntimeError(
            "PI audit orchestrator is not available. Either:\n"
            f"  1. The audit-runner package is not built at {repo_root / 'packages' / 'audit-runner'}\n"
            "     Run: pnpm --filter @modulewarden/audit-runner build\n"
            "  2. Node.js is not on PATH. Install Node.js 20+ and ensure it is reachable."
        )
    orch = _orchestrator_path(repo_root)
    assert orch is not None
    if orch.suffix == ".ts":
        raise RuntimeError(
            "audit-runner orchestrator is not compiled. "
            "Run: pnpm --filter @modulewarden/audit-runner build"
        )

    env = os.environ.copy()
    env.update(
        {
            "MW_PACKAGE_NAME": package_name,
            "MW_PACKAGE_VERSION": package_version,
            "MW_WORKSPACE": str(workspace_dir),
        }
    )
    # Forward optional orchestrator env vars from the parent environment.
    # The operator is responsible for setting these before running.
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
        raise RuntimeError(
            f"PI audit orchestrator timed out after {timeout_s}s "
            f"for {package_name}@{package_version}. "
            "Increase MW_AUDIT_TIMEOUT_MS or check the orchestrator health."
        ) from exc

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

    return {
        "status": "ok" if proc.returncode == 0 else "error",
        "mode": "pi",
        "elapsed_s": elapsed,
        "tool_calls": tool_calls,
        "raw_output": stdout,
        "verdict": verdict,
        "stderr": proc.stderr or "",
    }


__all__ = ["is_available", "run_pi_audit"]
