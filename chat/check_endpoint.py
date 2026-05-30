"""One-command rehearsal check: will the live-model badge be green on stage?

Resolves the configured model endpoint and does a tiny real completion so
you know BEFORE you walk on whether the chat will narrate with a live model
or fall back to the deterministic memo. Both states are valid; this just
tells you which one you are in and surfaces a misconfigured endpoint loudly.

Exit codes:
  0  deterministic mode (no endpoint) OR endpoint is live and responded
  1  an endpoint IS configured but it errored - fix before rehearsal

Usage:
    python -m chat.check_endpoint
"""

from __future__ import annotations

import time

from chat import model_client


def main() -> int:
    cfg = model_client.resolve_config()
    if cfg is None:
        print("DETERMINISTIC MODE - no model endpoint configured.")
        print("  The chat renders the exact Control Evidence Memo (real verdict,")
        print("  tier, decision, evidence). This is demo-safe and offline.")
        print("  To enable live narration, set MW_MODEL_ENDPOINT_BASE_URL")
        print("  (+ _API_KEY / _MODEL) or OPENAI_*. See chat/SERVE_LOCAL.md.")
        return 0

    print("ENDPOINT CONFIGURED")
    print(f"  source   {cfg.source}")
    print(f"  base_url {cfg.base_url}")
    print(f"  model    {cfg.model}")
    print("  probing with a one-token completion ...")

    started = time.monotonic()
    try:
        reply = model_client.complete(
            system_prompt="You are a health probe. Reply with the single word OK.",
            messages=[{"role": "user", "content": "Reply with OK."}],
            temperature=0.0,
            max_tokens=8,
            timeout_s=20,
        )
    except model_client.ModelEndpointError as exc:
        elapsed = time.monotonic() - started
        print(f"  ENDPOINT ERROR after {elapsed:.1f}s: {exc}")
        print("  The chat will surface this and fall back to the deterministic memo,")
        print("  but the live badge will NOT be green. Fix the endpoint before stage.")
        return 1

    elapsed = time.monotonic() - started
    snippet = (reply or "").strip().replace("\n", " ")[:80]
    print(f"  LIVE in {elapsed:.1f}s - model replied: {snippet!r}")
    print("  The live-model badge will be GREEN. The verdict stays pinned; the")
    print("  model only narrates it.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
