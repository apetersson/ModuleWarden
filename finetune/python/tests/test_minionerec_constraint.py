"""Tests for the MiniOneRec-ported evidence-ref constrained decoding.

The trie + prefix function are exercised with hand-built token id lists so
the core logic runs without torch or a tokenizer. Two further tests cover
the real tokenizer path (gpt2, skipped if unavailable) and the torch logits
processor masking (skipped if torch is unavailable).
"""

from __future__ import annotations

import pytest

from finetune.python.eval.minionerec_constraint import (
    EvidenceRefTrie,
    build_evidence_prefix_fn,
    make_evidence_logits_processor,
)

EOS = 99


def _trie() -> EvidenceRefTrie:
    # "ev.file.001" -> [1,2,3], "ev.file.002" -> [1,2,4], "ev.cap.001" -> [1,5,6]
    return EvidenceRefTrie([[1, 2, 3], [1, 2, 4], [1, 5, 6]], eos_token_id=EOS)


def test_root_allows_only_shared_first_token():
    trie = _trie()
    assert trie.next_allowed([]) == [1]


def test_branch_point_returns_both_children():
    trie = _trie()
    # after [1] the refs branch into the .file (2) and .cap (5) subtrees
    assert sorted(trie.next_allowed([1])) == [2, 5]
    # after [1,2] the two .file refs branch into 001 (3) and 002 (4)
    assert sorted(trie.next_allowed([1, 2])) == [3, 4]


def test_completed_ref_allows_eos():
    trie = _trie()
    # [1,2,3] is a full ref with no children -> only EOS may follow
    assert trie.next_allowed([1, 2, 3]) == [EOS]
    assert trie.next_allowed([1, 5, 6]) == [EOS]


def test_off_path_prefix_returns_empty():
    trie = _trie()
    # 9 is not a child of the [1,2] node
    assert trie.next_allowed([1, 2, 9]) == []
    # 7 is not a root child at all
    assert trie.next_allowed([7]) == []


def test_strict_prefix_ref_allows_eos_and_continuation():
    # "ev" -> [1] is itself a valid ref AND a strict prefix of "evx" -> [1,2]
    trie = EvidenceRefTrie([[1], [1, 2]], eos_token_id=EOS)
    allowed = trie.next_allowed([1])
    assert 2 in allowed  # can continue into the longer ref
    assert EOS in allowed  # can also terminate the short ref


class _FakeTokenizer:
    """Minimal tokenizer: each evidence id maps to a fixed id list."""

    eos_token_id = EOS

    _table = {
        "ev.file.001": [1, 2, 3],
        "ev.file.002": [1, 2, 4],
        "ev.cap.001": [1, 5, 6],
    }

    def encode(self, text, add_special_tokens=False):  # noqa: ARG002
        return list(self._table[text])


def test_prefix_fn_slices_generated_suffix_after_prompt():
    tok = _FakeTokenizer()
    fn, trie = build_evidence_prefix_fn(
        tok, ["ev.file.001", "ev.file.002", "ev.cap.001"], prompt_length=2
    )
    # input_ids = 2 prompt tokens (ignored) + generated suffix
    assert fn(0, [77, 88]) == [1]  # nothing generated yet -> root child
    assert sorted(fn(0, [77, 88, 1])) == [2, 5]
    assert fn(0, [77, 88, 1, 2, 3]) == [EOS]  # completed ref


def test_prefix_fn_forces_eos_when_off_path():
    tok = _FakeTokenizer()
    fn, _ = build_evidence_prefix_fn(tok, ["ev.file.001"], prompt_length=1)
    # generated suffix [1, 9] is off every allowed ref -> [] internally,
    # surfaced as [eos] so the softmax never collapses to all -inf
    assert fn(0, [77, 1, 9]) == [EOS]


def test_empty_allowlist_rejected():
    tok = _FakeTokenizer()
    with pytest.raises(ValueError):
        build_evidence_prefix_fn(tok, [], prompt_length=0)


def test_real_tokenizer_path():
    tok = pytest.importorskip("transformers").AutoTokenizer
    try:
        tokenizer = tok.from_pretrained("gpt2")
    except Exception:  # pragma: no cover - network/cache miss
        pytest.skip("gpt2 tokenizer not available offline")
    refs = ["ev.file.001", "ev.cap.001", "ev.net.001"]
    fn, trie = build_evidence_prefix_fn(tokenizer, refs, prompt_length=0)
    # the first generated token must be a legal opener for at least one ref
    first_allowed = fn(0, [])
    assert len(first_allowed) >= 1
    # a full ref's token sequence must be walkable and end at EOS
    ids = tokenizer.encode("ev.file.001", add_special_tokens=False)
    assert trie.next_allowed(ids) == [tokenizer.eos_token_id] or \
        tokenizer.eos_token_id in trie.next_allowed(ids)


def test_logits_processor_masks_to_allowed_set():
    torch = pytest.importorskip("torch")

    # deterministic hand-built prefix fn: prompt_length = 1
    def fn(batch_id, input_ids):  # noqa: ARG001
        seq = input_ids.tolist() if hasattr(input_ids, "tolist") else list(input_ids)
        generated = seq[1:]
        if generated == []:
            return [10, 11]
        if generated == [10]:
            return [12]
        return []  # off-path -> processor forces eos

    processors = make_evidence_logits_processor(fn, num_beams=1, eos_token_id=EOS)
    proc = processors[0]
    vocab = 100

    # step 0: nothing generated -> {10, 11} finite, all else -inf
    scores = torch.zeros(1, vocab)
    out = proc(torch.tensor([[5]]), scores.clone())
    assert torch.isfinite(out[0, 10]) and torch.isfinite(out[0, 11])
    assert out[0, 12] == float("-inf")
    assert out[0, 5] == float("-inf")

    # step 1: generated [10] -> only {12} finite
    out = proc(torch.tensor([[5, 10]]), scores.clone())
    assert torch.isfinite(out[0, 12])
    assert out[0, 10] == float("-inf")

    # step 2: off-path -> EOS forced, nothing else finite
    out = proc(torch.tensor([[5, 10, 12]]), scores.clone())
    assert torch.isfinite(out[0, EOS])
    assert out[0, 12] == float("-inf")
