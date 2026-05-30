"""OpenAI-compatible inference client for Decepticon (offense / red-team narration).

Decepticon is the OFFENSE side of ModuleWarden. It narrates the deterministic
MITRE ATT&CK kill chain produced by ``mapper.py`` as an attacker's-eye story, so
our own blue-team can test whether detection catches it. It is INFERENCE-ONLY.

Two hard contracts, both testable:

1. NO fine-tune. Decepticon never trains. It does not import trl, peft, or the
   SFT trainer. The auditor model is fine-tuned; Decepticon is not.
2. NO re-abliteration. Offense narration needs an uncensored model and never
   trains, so the correct artifact is a PRE-ABLITERATED GGUF served locally by
   llama.cpp or ollama. The GGUF is already abliterated (heretic-v2, KL-preserving
   MPOA); Decepticon consumes it as-is. This module does not import the
   abliteration module and runs no abliteration step. ``requires_abliteration()``
   returns False by design.

The technique ids in the kill chain stay authoritative (the deterministic mapper
pins them). The model narrates them and may not invent techniques, the same
pinning discipline that protects the audit verdict.

Endpoint resolution (first match wins):

1. DECEPTICON_MODEL_ENDPOINT_BASE_URL / _API_KEY / _MODEL
   (Decepticon's own GGUF server, kept separate from the auditor endpoint)
2. OPENAI_BASE_URL / OPENAI_API_KEY / OPENAI_MODEL
   (generic OpenAI-compatible fallback)

Serve the pre-abliterated GGUF with llama.cpp (no re-abliteration):

    llama-server -m heretic-v2/Qwen3.6-27B-...-Q5_K_M.gguf \
        --host 127.0.0.1 --port 8081 --ctx-size 8192
    export DECEPTICON_MODEL_ENDPOINT_BASE_URL=http://127.0.0.1:8081/v1
    export DECEPTICON_MODEL_ENDPOINT_MODEL=qwen3.6-27b-heretic-v2

or with ollama (Modelfile: ``FROM ./Qwen3.6-27B-...-Q5_K_M.gguf``):

    ollama create heretic-v2 -f Modelfile
    export DECEPTICON_MODEL_ENDPOINT_BASE_URL=http://127.0.0.1:11434/v1
    export DECEPTICON_MODEL_ENDPOINT_MODEL=heretic-v2

stdlib-only (urllib), so the Decepticon package stays torch-free.
"""

from __future__ import annotations

import json
import os
import urllib.error
import urllib.request
from dataclasses import dataclass


class ModelEndpointError(RuntimeError):
    """Raised when a configured Decepticon model endpoint call fails."""


@dataclass(frozen=True)
class EndpointConfig:
    base_url: str
    api_key: str
    model: str
    source: str


def requires_abliteration() -> bool:
    """Decepticon consumes a pre-abliterated GGUF as-is. Never re-abliterates."""
    return False


def resolve_config() -> EndpointConfig | None:
    """Resolve a Decepticon inference endpoint from env, or None if unset."""
    dc_base = os.environ.get("DECEPTICON_MODEL_ENDPOINT_BASE_URL")
    if dc_base:
        return EndpointConfig(
            base_url=dc_base.rstrip("/"),
            api_key=os.environ.get("DECEPTICON_MODEL_ENDPOINT_API_KEY", ""),
            model=os.environ.get("DECEPTICON_MODEL_ENDPOINT_MODEL", "heretic-v2"),
            source="DECEPTICON_MODEL_ENDPOINT",
        )
    oai_base = os.environ.get("OPENAI_BASE_URL")
    if oai_base:
        return EndpointConfig(
            base_url=oai_base.rstrip("/"),
            api_key=os.environ.get("OPENAI_API_KEY", ""),
            model=os.environ.get("OPENAI_MODEL", "gpt-4o-mini"),
            source="OPENAI",
        )
    if os.environ.get("OPENAI_API_KEY"):
        return EndpointConfig(
            base_url="https://api.openai.com/v1",
            api_key=os.environ["OPENAI_API_KEY"],
            model=os.environ.get("OPENAI_MODEL", "gpt-4o-mini"),
            source="OPENAI",
        )
    return None


def is_configured() -> bool:
    """True when a Decepticon endpoint is reachable-by-config (not a liveness probe)."""
    return resolve_config() is not None


_SYSTEM_PROMPT = (
    "You are Decepticon, a red-team supply-chain narrator used for DEFENSIVE "
    "testing inside ModuleWarden. You are given a kill chain whose MITRE ATT&CK "
    "technique ids are already PINNED by a deterministic mapper. Write a concise "
    "attacker's-eye account of how the dependency would be weaponized along that "
    "exact chain, so our blue-team can test detection. Rules: cite only the pinned "
    "technique ids, never invent techniques or capabilities not in the chain, and "
    "do not provide working exploit code. Output is a detection-test narrative, "
    "not an operational payload."
)


def complete(
    *,
    system_prompt: str,
    messages: list[dict[str, str]],
    temperature: float = 0.3,
    max_tokens: int = 700,
    timeout_s: float = 60.0,
) -> str:
    """POST a chat-completion to the configured GGUF server. Never silently degrades."""
    cfg = resolve_config()
    if cfg is None:
        raise ModelEndpointError(
            "no Decepticon endpoint configured: set "
            "DECEPTICON_MODEL_ENDPOINT_BASE_URL (+_API_KEY/_MODEL) to a local "
            "llama.cpp/ollama server hosting the pre-abliterated GGUF, or OPENAI_*"
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
            f"Decepticon endpoint HTTP {exc.code} from {cfg.base_url}: {detail}"
        ) from exc
    except (urllib.error.URLError, TimeoutError, OSError) as exc:
        raise ModelEndpointError(
            f"Decepticon endpoint unreachable at {cfg.base_url}: {exc}"
        ) from exc
    try:
        msg = body["choices"][0]["message"]
    except (KeyError, IndexError, TypeError) as exc:
        raise ModelEndpointError(
            f"Decepticon endpoint returned an unexpected shape: {str(body)[:300]}"
        ) from exc
    content = (msg.get("content") or "").strip()
    if not content:
        # Reasoning models (e.g. the heretic-v2 qwen35 GGUF, whose chat template
        # forces a <think> block) can return an empty `content` with the text in
        # `reasoning_content`. Fall back to it rather than handing back an empty
        # narration. Still raises below if both are empty (no silent degrade).
        content = (msg.get("reasoning_content") or "").strip()
    if not content:
        raise ModelEndpointError(
            f"Decepticon endpoint returned empty content: {str(body)[:300]}"
        )
    return content


def narrate_attack_chain(kill_chain: dict, *, package: str | None = None) -> str:
    """Narrate a PINNED kill chain (from mapper.kill_chain_narrative) for blue-team tests.

    The technique ids are authoritative; the model explains the chain, it does not
    change it. Raises ModelEndpointError if no GGUF endpoint is configured (the
    caller decides whether to fall back to the deterministic chain text).
    """
    technique_ids = kill_chain.get("technique_ids") or []
    if not technique_ids:
        # The gate flagged a capability the deterministic mapper does not cover, so no
        # technique is pinned. Do NOT send an empty chain to the model -- it could
        # invent techniques, breaking the pin-only contract. Return a deterministic
        # line; the gate verdict stands on its own. (Surfaced by red-teaming the gate
        # with Decepticon: an uncovered capability yields an empty chain, and an empty
        # chain handed to the model is the one place "never invent" could fail.)
        suffix = f" for {package}" if package else ""
        return (
            f"No MITRE ATT&CK techniques are pinned{suffix}: the deterministic mapper "
            "found no covered capability in the flagged signals, so there is no kill "
            "chain to narrate. The gate verdict stands without a narrated chain."
        )
    pinned = {
        "package": package,
        "chain": kill_chain.get("chain"),
        "technique_ids": technique_ids,
        "steps": kill_chain.get("steps"),
    }
    user_msg = (
        "Pinned ATT&CK kill chain (authoritative; narrate, do not alter):\n\n"
        + json.dumps(pinned, indent=2, ensure_ascii=False)
    )
    return complete(
        system_prompt=_SYSTEM_PROMPT,
        messages=[{"role": "user", "content": user_msg}],
        # heretic-v2 reasons before it answers (chain-of-thought first, final answer
        # after). The 700-token default is eaten by reasoning and content comes back
        # empty; give the narrative real headroom so it lands in content.
        max_tokens=4000,
    )
