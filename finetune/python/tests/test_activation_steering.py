"""Mechanism tests for activation steering, on gpt2 (CPU).

Proves the hooks, vector computation, application, and reversibility work
end-to-end on a real causal LM. The same code runs on the fine-tuned Qwen
checkpoint; only the layer index and coefficient need tuning there (and the
clean-accuracy guardrail via eval/injection_robustness).
"""

from __future__ import annotations

import pytest

from finetune.python.steering.activation_steering import (
    SteeringVector,
    _resolve_layers,
    compute_steering_vector,
    steering,
)
from finetune.python.steering.contrastive_prompts import (
    injection_resist_pairs,
    pairs_from_dossiers,
)

_LAYER = 4


@pytest.fixture(scope="module")
def gpt2():
    torch = pytest.importorskip("torch")
    tf = pytest.importorskip("transformers")
    try:
        tok = tf.AutoTokenizer.from_pretrained("gpt2")
        model = tf.AutoModelForCausalLM.from_pretrained("gpt2")
    except Exception:  # pragma: no cover
        pytest.skip("gpt2 not available offline")
    model.eval()
    return torch, model, tok


def test_resolve_layers_finds_gpt2_blocks(gpt2):
    _torch, model, _tok = gpt2
    layers = _resolve_layers(model)
    assert len(layers) >= 6  # gpt2 has 12 blocks


def test_compute_vector_shape_and_unit_norm(gpt2):
    _torch, model, tok = gpt2
    pos, neg = injection_resist_pairs()
    sv = compute_steering_vector(model, tok, pos, neg, layer=_LAYER)
    assert sv.hidden_size == 768  # gpt2 n_embd
    assert sv.vector.shape == (768,)
    assert abs(float(sv.vector.norm()) - 1.0) < 1e-4  # normalized
    assert float(sv.vector.abs().sum()) > 0  # non-trivial direction


def test_steering_changes_logits_and_is_reversible(gpt2):
    torch, model, tok = gpt2
    pos, neg = injection_resist_pairs()
    sv = compute_steering_vector(model, tok, pos, neg, layer=_LAYER)
    sv.coefficient = 10.0
    ids = tok("The audit verdict for this package is", return_tensors="pt").input_ids

    def next_logits():
        with torch.no_grad():
            return model(ids).logits[0, -1, :].clone()

    baseline = next_logits()
    with steering(model, sv):
        steered = next_logits()
    restored = next_logits()

    # steering moved the distribution
    assert not torch.allclose(baseline, steered, atol=1e-3)
    # and removing the hook restored it exactly (reversible, no weight mutation)
    assert torch.allclose(baseline, restored, atol=1e-6)


def test_pairs_from_dossiers_injects_into_negative():
    dossier = {
        "schema_version": "modulewarden.audit_dossier.v1",
        "audit_id": "a1",
        "diff_summary": "patch",
        "capability_deltas": [{"capability": "lifecycle_script", "added": True, "summary": "postinstall"}],
        "release_context": "rel",
    }
    pos, neg = pairs_from_dossiers([dossier])
    assert len(pos) == 1 and len(neg) == 1
    assert "allow" in neg[0].lower()  # negative carries the injection
    assert "authoritative" in neg[0].lower()
