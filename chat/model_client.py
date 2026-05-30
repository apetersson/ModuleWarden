"""OpenAI-compatible chat-completion client for the risk review assistant.

The conversational assistant pins the verdict deterministically (the gate
plus the audit report are the source of truth) and then, when a model
endpoint is configured, asks the fine-tuned model to narrate that pinned
result in risk-review language. The model never sources the verdict; it
only explains the pinned decision.

Endpoint resolution (first match wins), so the chat reuses the exact
contract the production gate already uses:

1. MW_MODEL_ENDPOINT_BASE_URL / MW_MODEL_ENDPOINT_API_KEY / MW_MODEL_ENDPOINT_MODEL
   (same vars the api-proxy + worker + audit-runner read)
2. OPENAI_BASE_URL / OPENAI_API_KEY / OPENAI_MODEL
   (generic OpenAI-compatible fallback the module docstring promised)

This is stdlib-only (urllib) so the chat package stays torch-free and
runs anywhere Streamlit runs. The fine-tuned weights are reached by
pointing the base URL at whatever serves them: a local vLLM, the
Leonardo-served checkpoint, or any OpenAI-compatible host.

Per the repo no-fallback rule: when the assistant is asked to run in
model-backed mode and the endpoint errors, this raises. It does NOT
silently degrade. The caller decides whether to surface the error or
fall through to the deterministic memo (which is always available and
does not need the model).
"""

from __future__ import annotations

import json
import os
import urllib.error
import urllib.request
from dataclasses import dataclass


class ModelEndpointError(RuntimeError):
    """Raised when a configured model endpoint call fails."""


@dataclass(frozen=True)
class EndpointConfig:
    base_url: str
    api_key: str
    model: str
    source: str  # which env-var family resolved it, for the evidence panel


def resolve_config() -> EndpointConfig | None:
    """Resolve an endpoint from env, or None if none is configured."""
    mw_base = os.environ.get("MW_MODEL_ENDPOINT_BASE_URL")
    if mw_base:
        return EndpointConfig(
            base_url=mw_base.rstrip("/"),
            api_key=os.environ.get("MW_MODEL_ENDPOINT_API_KEY", ""),
            model=os.environ.get("MW_MODEL_ENDPOINT_MODEL", "modulewarden-finetune"),
            source="MW_MODEL_ENDPOINT",
        )
    oai_base = os.environ.get("OPENAI_BASE_URL")
    if oai_base:
        return EndpointConfig(
            base_url=oai_base.rstrip("/"),
            api_key=os.environ.get("OPENAI_API_KEY", ""),
            model=os.environ.get("OPENAI_MODEL", "gpt-4o-mini"),
            source="OPENAI",
        )
    # OPENAI_API_KEY with no base URL implies the public OpenAI endpoint.
    if os.environ.get("OPENAI_API_KEY"):
        return EndpointConfig(
            base_url="https://api.openai.com/v1",
            api_key=os.environ["OPENAI_API_KEY"],
            model=os.environ.get("OPENAI_MODEL", "gpt-4o-mini"),
            source="OPENAI",
        )
    return None


def is_configured() -> bool:
    """True when a model endpoint is reachable-by-config (not a liveness probe)."""
    return resolve_config() is not None


def complete(
    *,
    system_prompt: str,
    messages: list[dict[str, str]],
    temperature: float = 0.2,
    max_tokens: int = 700,
    timeout_s: float = 60.0,
) -> str:
    """Call the configured chat-completions endpoint and return the text.

    Raises ModelEndpointError if no endpoint is configured or the call
    fails. The caller is responsible for deciding fallback behavior; this
    function never silently returns a degraded result.
    """
    cfg = resolve_config()
    if cfg is None:
        raise ModelEndpointError(
            "no model endpoint configured: set MW_MODEL_ENDPOINT_BASE_URL "
            "(+_API_KEY/_MODEL) or OPENAI_API_KEY"
        )

    payload = {
        "model": cfg.model,
        "messages": [{"role": "system", "content": system_prompt}, *messages],
        "temperature": temperature,
        "max_tokens": max_tokens,
        "stream": False,
    }
    req = urllib.request.Request(
        f"{cfg.base_url}/chat/completions",
        data=json.dumps(payload).encode("utf-8"),
        headers={
            "Content-Type": "application/json",
            "Authorization": f"Bearer {cfg.api_key}" if cfg.api_key else "",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout_s) as resp:
            body = json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", "replace")[:400]
        raise ModelEndpointError(
            f"model endpoint HTTP {exc.code} from {cfg.base_url}: {detail}"
        ) from exc
    except (urllib.error.URLError, TimeoutError, OSError) as exc:
        raise ModelEndpointError(
            f"model endpoint unreachable at {cfg.base_url}: {exc}"
        ) from exc

    try:
        return body["choices"][0]["message"]["content"]
    except (KeyError, IndexError, TypeError) as exc:
        raise ModelEndpointError(
            f"model endpoint returned an unexpected shape: {str(body)[:300]}"
        ) from exc
