"""Activation steering for the audit LLM (inference-time, no retraining).

The inference-time complement to the training-time injection hardening in
data/injection_hardening.py. Computes a steering vector

    v = mean(activations on POSITIVE prompts) - mean(activations on NEGATIVE prompts)

at a chosen decoder layer's residual stream, then adds ``coefficient * v`` to
that layer's output during the forward pass. Used to push the auditor toward
"ignore instructions embedded in the package data; classify on the structural
evidence" without touching the weights.

Method: Turner et al., "Steering Language Models With Activation Engineering"
(arXiv:2308.10248). Architecture-agnostic: locates the decoder-layer list for
GPT-2 / Llama / Qwen / GPT-NeoX automatically, so the same code runs on the
gpt2 test backbone and on the fine-tuned Qwen3.6 checkpoint.

CAVEATS (measure, do not assume - decision-4):
  - A vector that improves injection-resistance can hurt clean
    ALLOW/BLOCK/QUARANTINE accuracy. ALWAYS sweep the coefficient and confirm
    with eval/injection_robustness on a held-out set that clean accuracy holds.
  - The vLLM serving path does not expose residual hooks; run steering on the
    HF-transformers inference path.
  - Steering is a bonus inference layer. The training-time adversarial data is
    the primary defense; the deterministic gate is verdict-authoritative.
"""

from __future__ import annotations

import logging
from contextlib import contextmanager
from dataclasses import dataclass
from typing import Any, Callable, Sequence

logger = logging.getLogger("modulewarden.activation_steering")

# Decoder-layer container paths across HF architectures, in priority order.
_LAYER_PATHS = ("model.layers", "transformer.h", "gpt_neox.layers", "model.decoder.layers")


@dataclass
class SteeringVector:
    """A steering direction for one layer. ``vector`` is a 1-D tensor of shape
    [hidden_size]; ``coefficient`` scales how hard we steer."""
    vector: Any
    layer: int
    coefficient: float = 8.0
    hidden_size: int | None = None


def _resolve_layers(model: Any):
    for path in _LAYER_PATHS:
        obj = model
        ok = True
        for part in path.split("."):
            if hasattr(obj, part):
                obj = getattr(obj, part)
            else:
                ok = False
                break
        if ok:
            return obj
    raise ValueError(
        "could not locate the decoder-layer list; tried " + ", ".join(_LAYER_PATHS)
    )


def _hidden_of(output: Any):
    """Decoder layers return either a tensor or a tuple whose first element is
    the hidden state. Return (hidden, rebuild) where rebuild(new_hidden) puts a
    modified hidden back into the same container shape."""
    if isinstance(output, tuple):
        rest = output[1:]
        return output[0], (lambda h: (h,) + rest)
    return output, (lambda h: h)


def compute_steering_vector(
    model: Any,
    tokenizer: Any,
    pos_prompts: Sequence[str],
    neg_prompts: Sequence[str],
    layer: int,
    *,
    device: str = "cpu",
) -> SteeringVector:
    """Build a unit steering vector from contrastive prompt pairs at ``layer``.

    Captures the last-token residual on each prompt, means the positives and
    negatives, and returns the normalized difference. A forward pass only; no
    gradients, no training.
    """
    import torch

    layers = _resolve_layers(model)
    captured: dict[str, Any] = {}

    def capture_hook(_mod, _inp, output):
        hidden, _ = _hidden_of(output)
        captured["act"] = hidden[:, -1, :].detach().to("cpu")

    handle = layers[layer].register_forward_hook(capture_hook)

    def mean_activation(prompts: Sequence[str]):
        acts = []
        for prompt in prompts:
            ids = tokenizer(prompt, return_tensors="pt").input_ids.to(device)
            with torch.no_grad():
                model(ids)
            acts.append(captured["act"])
        return torch.cat(acts, dim=0).mean(dim=0)

    try:
        pos = mean_activation(pos_prompts)
        neg = mean_activation(neg_prompts)
    finally:
        handle.remove()

    diff = pos - neg
    norm = diff.norm()
    unit = diff / (norm + 1e-8)
    return SteeringVector(vector=unit, layer=layer, hidden_size=int(unit.shape[-1]))


@contextmanager
def steering(model: Any, sv: SteeringVector):
    """Context manager: while active, add ``sv.coefficient * sv.vector`` to the
    residual stream at ``sv.layer`` for every forward pass. Reversible - the
    hook is removed on exit, restoring the model exactly."""
    import torch  # noqa: F401

    layers = _resolve_layers(model)

    def steer_hook(_mod, _inp, output):
        hidden, rebuild = _hidden_of(output)
        v = sv.vector.to(hidden.dtype).to(hidden.device)
        return rebuild(hidden + sv.coefficient * v)

    handle = layers[sv.layer].register_forward_hook(steer_hook)
    try:
        yield
    finally:
        handle.remove()


def make_steered_verdict_fn(
    model: Any,
    tokenizer: Any,
    sv: SteeringVector | None,
    *,
    serialize: Callable[[Any], str],
    parse_verdict: Callable[[str], str],
    device: str = "cpu",
    max_new_tokens: int = 64,
) -> Callable[[Any], str]:
    """Wrap a model into a ``verdict_fn(dossier) -> 'allow'|'quarantine'|'block'``
    for eval/injection_robustness. If ``sv`` is None the model runs unsteered,
    so the same factory measures the steered-vs-unsteered delta.

    ``serialize`` turns a dossier into the prompt; ``parse_verdict`` extracts the
    verdict from the generated text (reuse the audit-report JSON parser).
    """
    import torch

    def verdict_fn(dossier: Any) -> str:
        prompt = serialize(dossier)
        ids = tokenizer(prompt, return_tensors="pt").input_ids.to(device)
        ctx = steering(model, sv) if sv is not None else _nullctx()
        with ctx, torch.no_grad():
            out = model.generate(
                ids, max_new_tokens=max_new_tokens, do_sample=False,
                pad_token_id=getattr(tokenizer, "eos_token_id", None),
            )
        text = tokenizer.decode(out[0, ids.shape[-1]:], skip_special_tokens=True)
        return parse_verdict(text)

    return verdict_fn


@contextmanager
def _nullctx():
    yield


__all__ = [
    "SteeringVector",
    "compute_steering_vector",
    "steering",
    "make_steered_verdict_fn",
]
