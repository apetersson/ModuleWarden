"""Refusal-direction orthogonalization (abliteration).

Removes the "I cannot help with security analysis" cascade behavior from a
base instruction-tuned model so the resulting weights answer npm
supply-chain audit prompts directly rather than hedging.

Reference
---------
Arditi, Obeso, Syed, Paleka, Rimsky, Gurnee, Nanda. "Refusal in Language
Models Is Mediated by a Single Direction." arXiv:2406.11717 (2024).
https://arxiv.org/abs/2406.11717

The packaged implementation by Failspy (``llama3-8B-abliterated`` and the
``abliterator`` notebook) is the canonical reference for the technique.
https://github.com/FailSpy/abliterator

Method (in three steps)
-----------------------
1. Capture the last-token residual-stream activation at one decoder layer
   for a set of harmful prompts and a set of harmless prompts.
2. The refusal direction is the unit vector pointing from the mean harmless
   activation to the mean harmful activation. This is the dimension along
   which the model encodes "I should refuse this".
3. Orthogonalize the MLP ``down_proj`` and attention ``o_proj`` weight
   matrices at every decoder layer against that direction. The model can
   no longer write anything into the residual stream along the refusal
   axis, so refusal cascades stop firing.

The technique is weights-only: no fine-tune, no extra parameters, no
inference-time hook. The output is a standard HF model directory.
"""

from __future__ import annotations

import argparse
import json
import logging
from pathlib import Path
from typing import Any, Iterable, Sequence

logger = logging.getLogger("modulewarden.abliteration")

# Default candidate layers when --find-best-layer is on. The strongest
# refusal signal sits roughly two-thirds of the way through most decoder
# stacks; we search a window around there.
DEFAULT_CANDIDATE_FRACTIONS = (0.55, 0.62, 0.69, 0.76, 0.83)


def _require_torch() -> Any:
    try:
        import torch
    except ImportError as exc:
        raise RuntimeError(
            "torch is required for abliteration; pip install torch transformers"
        ) from exc
    return torch


def _require_transformers() -> Any:
    try:
        import transformers
    except ImportError as exc:
        raise RuntimeError(
            "transformers is required for abliteration"
        ) from exc
    return transformers


def load_prompt_pair(harmful_path: Path, harmless_path: Path) -> tuple[list[str], list[str]]:
    """Load the two prompt lists from JSON files (a flat list of strings)."""
    harmful = json.loads(Path(harmful_path).read_text(encoding="utf-8"))
    harmless = json.loads(Path(harmless_path).read_text(encoding="utf-8"))
    if not isinstance(harmful, list) or not isinstance(harmless, list):
        raise ValueError("prompt files must contain a flat JSON list of strings")
    return [str(p) for p in harmful], [str(p) for p in harmless]


def _resolve_layer(model: Any, layer_idx: int) -> Any:
    """Return the decoder block at ``layer_idx`` for common architectures.

    Works for Llama / GLM / DeepSeek / Qwen style stacks where the decoder
    layers live at ``model.model.layers`` or ``model.transformer.h``.
    """
    if hasattr(model, "model") and hasattr(model.model, "layers"):
        return model.model.layers[layer_idx]
    if hasattr(model, "transformer") and hasattr(model.transformer, "h"):
        return model.transformer.h[layer_idx]
    if hasattr(model, "gpt_neox") and hasattr(model.gpt_neox, "layers"):
        return model.gpt_neox.layers[layer_idx]
    raise RuntimeError(
        f"unsupported architecture for layer resolution: {type(model).__name__}"
    )


def _iter_decoder_layers(model: Any) -> Iterable[Any]:
    if hasattr(model, "model") and hasattr(model.model, "layers"):
        yield from model.model.layers
        return
    if hasattr(model, "transformer") and hasattr(model.transformer, "h"):
        yield from model.transformer.h
        return
    if hasattr(model, "gpt_neox") and hasattr(model.gpt_neox, "layers"):
        yield from model.gpt_neox.layers
        return
    raise RuntimeError(
        f"unsupported architecture for layer iteration: {type(model).__name__}"
    )


def _last_token_hidden(model: Any, tokenizer: Any, prompts: Sequence[str], layer_idx: int) -> Any:
    """Run a forward pass over ``prompts`` and return last-token hiddens.

    Returns a tensor of shape ``[len(prompts), hidden_size]`` taken at the
    specified decoder layer's output (post-layernorm residual stream).
    """
    torch = _require_torch()
    captured: list[Any] = []

    target = _resolve_layer(model, layer_idx)

    def _hook(_module: Any, _inputs: Any, output: Any) -> None:
        hidden = output[0] if isinstance(output, tuple) else output
        captured.append(hidden[:, -1, :].detach().to("cpu", dtype=torch.float32))

    handle = target.register_forward_hook(_hook)
    try:
        model.eval()
        with torch.no_grad():
            for prompt in prompts:
                inputs = tokenizer(prompt, return_tensors="pt").to(model.device)
                model(**inputs)
    finally:
        handle.remove()

    return torch.cat(captured, dim=0)


def compute_refusal_direction(
    model: Any,
    tokenizer: Any,
    harmful_prompts: Sequence[str],
    harmless_prompts: Sequence[str],
    layer_idx: int = -1,
) -> Any:
    """Compute the unit-norm refusal direction at ``layer_idx``.

    The direction is ``mean(hidden(harmful)) - mean(hidden(harmless))``
    normalized to unit length, computed in fp32 for numeric stability.
    """
    torch = _require_torch()
    if layer_idx < 0:
        # resolve negative index against the layer count
        layers = list(_iter_decoder_layers(model))
        layer_idx = len(layers) + layer_idx

    logger.info(
        "capturing activations at layer %d over %d harmful / %d harmless prompts",
        layer_idx,
        len(harmful_prompts),
        len(harmless_prompts),
    )
    harmful_h = _last_token_hidden(model, tokenizer, harmful_prompts, layer_idx)
    harmless_h = _last_token_hidden(model, tokenizer, harmless_prompts, layer_idx)
    diff = harmful_h.mean(dim=0) - harmless_h.mean(dim=0)
    direction = diff / (torch.linalg.vector_norm(diff) + 1e-8)
    logger.info("refusal direction norm (pre-normalize): %.4f", float(diff.norm()))
    return direction


def find_best_refusal_layer(
    model: Any,
    tokenizer: Any,
    harmful_prompts: Sequence[str],
    harmless_prompts: Sequence[str],
    candidate_layers: Sequence[int] | None = None,
) -> tuple[int, Any]:
    """Pick the layer with the strongest refusal signal.

    Signal strength is the L2 norm of the un-normalized mean-difference
    vector at that layer; larger means the two prompt populations are
    further apart in that layer's residual stream.
    """
    torch = _require_torch()
    layers = list(_iter_decoder_layers(model))
    n_layers = len(layers)

    if candidate_layers is None:
        candidate_layers = [int(n_layers * f) for f in DEFAULT_CANDIDATE_FRACTIONS]
        candidate_layers = sorted({max(0, min(n_layers - 1, l)) for l in candidate_layers})

    best_layer = candidate_layers[0]
    best_norm = -1.0
    best_direction: Any = None
    for layer_idx in candidate_layers:
        layer_idx = layer_idx if layer_idx >= 0 else n_layers + layer_idx
        harmful_h = _last_token_hidden(model, tokenizer, harmful_prompts, layer_idx)
        harmless_h = _last_token_hidden(model, tokenizer, harmless_prompts, layer_idx)
        diff = harmful_h.mean(dim=0) - harmless_h.mean(dim=0)
        norm = float(torch.linalg.vector_norm(diff))
        logger.info("layer %d refusal signal norm: %.4f", layer_idx, norm)
        if norm > best_norm:
            best_norm = norm
            best_layer = layer_idx
            best_direction = diff / (torch.linalg.vector_norm(diff) + 1e-8)
    logger.info("best refusal layer: %d (norm=%.4f)", best_layer, best_norm)
    return best_layer, best_direction


def _orthogonalize_weight(weight: Any, direction: Any) -> Any:
    """Project ``weight`` onto the null-space of ``direction``.

    For a weight matrix ``W`` and unit vector ``r``, the orthogonal
    projection is ``W - r r^T W`` when ``r`` lies in the output space of
    ``W``. We handle both orientations by checking which dimension of
    ``W`` matches the direction.
    """
    torch = _require_torch()
    direction = direction.to(dtype=weight.dtype, device=weight.device)
    if weight.shape[0] == direction.shape[0]:
        # W shape (out, in), direction lives in `out`
        proj = torch.outer(direction, direction)
        return weight - proj @ weight
    if weight.shape[1] == direction.shape[0]:
        # W shape (out, in), direction lives in `in`
        proj = torch.outer(direction, direction)
        return weight - weight @ proj
    raise ValueError(
        f"direction shape {tuple(direction.shape)} matches no axis of weight {tuple(weight.shape)}"
    )


def apply_orthogonalization(
    model: Any,
    direction: Any,
    layers: Sequence[int] | None = None,
) -> None:
    """Project every layer's down_proj and o_proj against ``direction``.

    Mutates the model in place. If ``layers`` is None, applies to all
    decoder layers (the standard recipe). Pass a smaller list only for
    debugging or partial-ablation experiments.
    """
    all_layers = list(_iter_decoder_layers(model))
    indices = list(range(len(all_layers))) if layers is None else list(layers)
    touched = 0
    for idx in indices:
        layer = all_layers[idx]
        # MLP down projection (Llama / GLM / DeepSeek style)
        mlp = getattr(layer, "mlp", None)
        if mlp is not None:
            for attr in ("down_proj", "c_proj", "dense_4h_to_h"):
                proj = getattr(mlp, attr, None)
                if proj is not None and hasattr(proj, "weight"):
                    proj.weight.data = _orthogonalize_weight(proj.weight.data, direction)
                    touched += 1
                    break
        # Attention output projection
        attn = getattr(layer, "self_attn", None) or getattr(layer, "attention", None) or getattr(layer, "attn", None)
        if attn is not None:
            for attr in ("o_proj", "out_proj", "dense", "c_proj"):
                proj = getattr(attn, attr, None)
                if proj is not None and hasattr(proj, "weight"):
                    proj.weight.data = _orthogonalize_weight(proj.weight.data, direction)
                    touched += 1
                    break
    logger.info(
        "orthogonalized %d weight matrices across %d layers", touched, len(indices)
    )


def save_abliterated_model(model: Any, tokenizer: Any, out_dir: Path) -> None:
    """Standard HF save_pretrained pattern, plus a marker file."""
    out_dir = Path(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    model.save_pretrained(out_dir, safe_serialization=True)
    tokenizer.save_pretrained(out_dir)
    (out_dir / "ABLITERATED.json").write_text(
        json.dumps(
            {
                "technique": "refusal-direction orthogonalization",
                "reference": "arXiv:2406.11717 (Arditi et al. 2024)",
                "implementation": "finetune.python.training.abliteration",
                "target": "MLP down_proj + attention o_proj at every decoder layer",
            },
            indent=2,
        ),
        encoding="utf-8",
    )
    logger.info("saved abliterated model to %s", out_dir)


def abliterate(
    base_model: str,
    out_dir: Path,
    harmful_prompts: Sequence[str],
    harmless_prompts: Sequence[str],
    layer_idx: int | None = None,
    dtype: str = "bfloat16",
    device_map: str = "auto",
) -> None:
    """End-to-end entry point used by the CLI."""
    torch = _require_torch()
    transformers = _require_transformers()
    AutoModelForCausalLM = transformers.AutoModelForCausalLM
    AutoTokenizer = transformers.AutoTokenizer

    dtype_map = {
        "bfloat16": torch.bfloat16,
        "float16": torch.float16,
        "float32": torch.float32,
    }
    torch_dtype = dtype_map.get(dtype, torch.bfloat16)

    logger.info("loading base model %s (dtype=%s)", base_model, dtype)
    tokenizer = AutoTokenizer.from_pretrained(base_model, trust_remote_code=True)
    if tokenizer.pad_token is None:
        tokenizer.pad_token = tokenizer.eos_token
    model = AutoModelForCausalLM.from_pretrained(
        base_model,
        torch_dtype=torch_dtype,
        device_map=device_map,
        trust_remote_code=True,
    )

    if layer_idx is None:
        chosen_layer, direction = find_best_refusal_layer(
            model, tokenizer, harmful_prompts, harmless_prompts
        )
    else:
        chosen_layer = layer_idx
        direction = compute_refusal_direction(
            model, tokenizer, harmful_prompts, harmless_prompts, layer_idx
        )

    logger.info("applying orthogonalization (chosen layer=%d)", chosen_layer)
    apply_orthogonalization(model, direction)
    save_abliterated_model(model, tokenizer, out_dir)


def _build_arg_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="ModuleWarden refusal-direction orthogonalization"
    )
    parser.add_argument("--base-model", required=True, help="HF model id or local path")
    parser.add_argument("--output", required=True, type=Path, help="Output directory")
    parser.add_argument(
        "--harmful-prompts",
        type=Path,
        default=Path(__file__).parent / "harmful_prompts.json",
    )
    parser.add_argument(
        "--harmless-prompts",
        type=Path,
        default=Path(__file__).parent / "harmless_prompts.json",
    )
    parser.add_argument(
        "--layer",
        type=int,
        default=None,
        help="Specific layer index; default auto-picks via signal norm.",
    )
    parser.add_argument("--dtype", default="bfloat16", choices=["bfloat16", "float16", "float32"])
    parser.add_argument("--device-map", default="auto")
    parser.add_argument("-v", "--verbose", action="store_true")
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    args = _build_arg_parser().parse_args(argv)
    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s %(message)s",
    )
    harmful, harmless = load_prompt_pair(args.harmful_prompts, args.harmless_prompts)
    abliterate(
        base_model=args.base_model,
        out_dir=args.output,
        harmful_prompts=harmful,
        harmless_prompts=harmless,
        layer_idx=args.layer,
        dtype=args.dtype,
        device_map=args.device_map,
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
