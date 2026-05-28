"""Evidence-ref constrained decoding, ported from MiniOneRec.

Adapted from AkaliKong/MiniOneRec (`LogitProcessor.py`,
`ConstrainedLogitsProcessor`), Apache-2.0. MiniOneRec masks generation to a
trie of three-level RQ-VAE semantic IDs so a recommender can only emit a
valid item code. Here the trie is built over a dossier's evidence-ref
allowlist (for example "ev.file.001"), so an audit finding can only cite an
evidence id that exists in the dossier evidence_index.

Why this matters for ModuleWarden
----------------------------------
`constrained_decode.py` already uses `outlines` for the JSON skeleton, then
runs a post-decode rejector (`_RefRestrictedGenerator`) that STRIPS any
evidence_ref outside the allowlist. Stripping guarantees zero invented refs,
but it does so by silently dropping the citation: a finding that should cite
ev.file.002 but whose free-decode emitted "ev.file.99" ends up uncited. That
costs evidence_citation_accuracy, a load-bearing eval metric.

Masking during decode fixes that. The model never sees the invalid token, so
it picks a real ref from the allowlist instead of dropping an invented one.
That lifts citation accuracy rather than only guaranteeing no invented refs.

What is and is not ported
-------------------------
MiniOneRec's processor is coupled to the RQ-VAE SID codebook (its
`prefix_index = 3` is the SID depth). ModuleWarden has no SID codebook, so
only two things are ported: the generic logits-masking step, and the
trie-backed prefix function. The trie is built fresh over evidence ids. The
RQ-VAE / SID machinery is intentionally left out. This is the lightweight
evidence-ref-only path, not the full RQ-VAE port (see backlog decision-3).

The trie + prefix function are pure-Python and unit-testable without torch.
The logits processor imports torch lazily so this module stays importable in
pure-schema test runs, matching the lazy-`outlines` pattern in
constrained_decode.py.
"""

from __future__ import annotations

import logging
from typing import Callable, Iterable, Sequence

logger = logging.getLogger("modulewarden.minionerec_constraint")


class EvidenceRefTrie:
    """Prefix trie over tokenized evidence-ref id strings.

    `next_allowed(generated_ids)` returns the token ids that may legally
    follow the tokens generated so far within a single ref span:

    - off-path prefix  -> [] (no valid continuation; caller forces EOS,
      matching MiniOneRec semantics)
    - mid-ref prefix   -> the child token ids in the trie
    - completed ref    -> {eos_token_id} (plus any child ids when this ref
      is also a strict prefix of a longer allowed ref)

    The trie is tiny: evidence ids share long prefixes ("ev.file.001",
    "ev.file.002") so a dossier's whole allowlist collapses to a few nodes.
    """

    def __init__(
        self,
        tokenized_refs: Sequence[Sequence[int]],
        eos_token_id: int,
    ) -> None:
        self.eos_token_id = eos_token_id
        self._root: dict[int, dict] = {}
        self._terminals: set[tuple[int, ...]] = set()
        for toks in tokenized_refs:
            toks = tuple(toks)
            if not toks:
                continue
            node = self._root
            for t in toks:
                node = node.setdefault(t, {})
            self._terminals.add(toks)

    def _walk(self, gen: Sequence[int]) -> dict | None:
        node = self._root
        for t in gen:
            nxt = node.get(t)
            if nxt is None:
                return None
            node = nxt
        return node

    def next_allowed(self, generated_ids: Sequence[int]) -> list[int]:
        gen = tuple(generated_ids)
        node = self._walk(gen)
        if node is None:
            # off-path: the model strayed off every allowed ref
            return []
        children = list(node.keys())
        if gen in self._terminals:
            # a full ref is complete: EOS is legal, and so is continuing
            # into any longer ref that has this one as a strict prefix
            return children + [self.eos_token_id]
        return children


def build_evidence_prefix_fn(
    tokenizer,
    allowed_refs: Iterable[str],
    prompt_length: int,
) -> tuple[Callable[[int, Sequence[int]], list[int]], EvidenceRefTrie]:
    """Build an HF-compatible prefix_allowed_tokens_fn over the ref allowlist.

    `prompt_length` is the number of prompt tokens. HF passes the full
    running sequence to `prefix_allowed_tokens_fn(batch_id, input_ids)`, so
    the function matches the trie against the generated suffix only
    (input_ids[prompt_length:]). Use with a single (un-left-padded) prompt;
    HF wraps the returned fn in PrefixConstrainedLogitsProcessor itself.

    Returns (prefix_allowed_tokens_fn, trie). The trie is returned so tests
    and callers can inspect it.
    """
    eos = tokenizer.eos_token_id
    if eos is None:
        raise ValueError("tokenizer has no eos_token_id; set one before constraining")

    tokenized: list[list[int]] = []
    for ref in sorted(set(allowed_refs)):
        ids = tokenizer.encode(ref, add_special_tokens=False)
        if ids:
            tokenized.append(ids)
    if not tokenized:
        raise ValueError("allowed_refs produced no tokens; nothing to constrain")

    trie = EvidenceRefTrie(tokenized, eos_token_id=eos)

    def prefix_allowed_tokens_fn(batch_id: int, input_ids) -> list[int]:
        seq = input_ids.tolist() if hasattr(input_ids, "tolist") else list(input_ids)
        generated = seq[prompt_length:]
        allowed = trie.next_allowed(generated)
        # Returning [] would mask the whole vocab to -inf and NaN the
        # softmax. Force EOS instead, which both ends the ref cleanly and
        # mirrors MiniOneRec's "no valid token -> emit EOS" guard.
        return allowed if allowed else [eos]

    return prefix_allowed_tokens_fn, trie


def make_evidence_logits_processor(
    prefix_allowed_tokens_fn: Callable[[int, Sequence[int]], list[int]],
    *,
    num_beams: int = 1,
    eos_token_id: int | None = None,
):
    """Return a LogitsProcessorList masking to the evidence-ref allowlist.

    This is the explicit-processor form, faithful to MiniOneRec's
    `ConstrainedLogitsProcessor`: at each step it sets every logit to -inf
    except the prefix-allowed token ids. Prefer passing
    `prefix_allowed_tokens_fn=` straight to `model.generate(...)` for the
    common case; this form exists for callers that build an explicit
    LogitsProcessorList (for example to compose with a TemperatureWarper) or
    want beam-search parity with MiniOneRec.

    torch + transformers are imported lazily so the trie above stays
    importable without them.
    """
    import torch
    from transformers import LogitsProcessor, LogitsProcessorList

    class _EvidenceConstrainedLogitsProcessor(LogitsProcessor):
        # Ported from MiniOneRec ConstrainedLogitsProcessor (Apache-2.0).
        # The original tracked the ref prefix with a step counter and a
        # tail slice; this delegates prefix resolution to the HF-style
        # prefix_allowed_tokens_fn instead, which slices relative to the
        # prompt and is robust to the counter drifting.
        def __init__(self, fn, beams, eos):
            self._fn = fn
            self._beams = beams
            self._eos = eos

        def __call__(self, input_ids, scores):
            scores = torch.nn.functional.log_softmax(scores, dim=-1)
            mask = torch.full_like(scores, float("-inf"))
            view = input_ids.view(-1, self._beams, input_ids.shape[-1])
            for batch_id, beam_sent in enumerate(view):
                for beam_id, sent in enumerate(beam_sent):
                    allowed = self._fn(batch_id, sent)
                    row = batch_id * self._beams + beam_id
                    if not allowed:
                        if self._eos is not None:
                            mask[row, self._eos] = 0
                        continue
                    mask[row, allowed] = 0
            return scores + mask

    return LogitsProcessorList(
        [_EvidenceConstrainedLogitsProcessor(prefix_allowed_tokens_fn, num_beams, eos_token_id)]
    )


__all__ = [
    "EvidenceRefTrie",
    "build_evidence_prefix_fn",
    "make_evidence_logits_processor",
]
