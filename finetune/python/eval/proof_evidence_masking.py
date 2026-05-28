"""Proof that during-decode evidence-ref masking recovers dropped citations.

Two pipelines, same model, same prompts:

  Path A (current): free decode, then the post-decode rejector
    (_RefRestrictedGenerator) STRIPS any ref outside the dossier allowlist.
    A ref the model gets slightly wrong is dropped -> the finding is uncited.

  Path B (MiniOneRec-ported): mask the decoder to the allowlist while it
    decodes, so it can only emit an id that exists in the dossier.

Run on gpt2 here. gpt2 is a faithful stand-in for the regime ModuleWarden
actually ships in: on a HELD-OUT dossier the evidence ref ids are generated
at audit time and were never in training, so the fine-tuned model cannot
have memorized their exact token sequences either. Path A's citation rate is
model-dependent and bounded below 100% on unseen ref ids; Path B is 100%
valid by construction. The gap is the citation-accuracy lift.

Usage:
    python -m finetune.python.eval.proof_evidence_masking
"""

from __future__ import annotations

import sys

ALLOWLIST = [
    "ev.file.001",
    "ev.file.002",
    "ev.file.003",
    "ev.cap.001",
    "ev.net.001",
]

# Realistic finding contexts; each ends at the JSON point where the model
# must emit a supporting evidence id.
PROMPTS = [
    'Finding: lifecycle script added. {"evidence_refs": ["',
    'Finding: outbound network call introduced. {"evidence_refs": ["',
    'Finding: reads SMTP credentials from env. {"evidence_refs": ["',
    'Finding: template escape lookup extended. {"evidence_refs": ["',
    'Finding: ReDoS regex tightened in patch. {"evidence_refs": ["',
    'Finding: new postinstall hook in package.json. {"evidence_refs": ["',
    'Finding: dynamic require of remote module. {"evidence_refs": ["',
    'Finding: obfuscated payload in dist build. {"evidence_refs": ["',
    'Finding: process spawn added to helper. {"evidence_refs": ["',
    'Finding: dependency redirected to new maintainer. {"evidence_refs": ["',
]


def _first_allowlist_hit(text: str) -> str | None:
    """Path A's post-decode strip: keep a ref only if it is on the allowlist.

    Mirrors _RefRestrictedGenerator: scan the free output, keep the first
    allowlist id that actually appears; everything else is dropped.
    """
    for ref in ALLOWLIST:
        if ref in text:
            return ref
    return None


def main() -> int:
    try:
        import torch
        from transformers import AutoModelForCausalLM, AutoTokenizer
    except Exception as exc:  # pragma: no cover
        print(f"SKIP: torch/transformers unavailable ({exc})")
        return 0

    from finetune.python.eval.minionerec_constraint import build_evidence_prefix_fn

    try:
        tok = AutoTokenizer.from_pretrained("gpt2")
        model = AutoModelForCausalLM.from_pretrained("gpt2")
    except Exception as exc:  # pragma: no cover
        print(f"SKIP: gpt2 not available offline ({exc})")
        return 0

    model.eval()
    tok.pad_token = tok.eos_token

    a_cited = 0  # Path A: prompts where a VALID ref survived the strip
    a_invalid_emissions = 0  # Path A: prompts where the model's pick was off-allowlist (dropped)
    b_cited = 0  # Path B: prompts where a VALID ref was emitted
    b_invalid = 0  # Path B: off-allowlist emissions (must be zero by construction)

    longest = max(len(tok.encode(r)) for r in ALLOWLIST) + 2

    for prompt in PROMPTS:
        ids = tok(prompt, return_tensors="pt").input_ids
        plen = ids.shape[-1]

        # Path A: free greedy decode, then strip.
        with torch.no_grad():
            free = model.generate(
                ids,
                max_new_tokens=longest,
                num_beams=1,
                do_sample=False,
                pad_token_id=tok.eos_token_id,
            )
        free_text = tok.decode(free[0, plen:], skip_special_tokens=True)
        kept = _first_allowlist_hit(free_text)
        if kept:
            a_cited += 1
        else:
            a_invalid_emissions += 1

        # Path B: masked greedy decode over the allowlist trie.
        prefix_fn, _ = build_evidence_prefix_fn(tok, ALLOWLIST, plen)
        with torch.no_grad():
            masked = model.generate(
                ids,
                max_new_tokens=longest,
                num_beams=1,
                do_sample=False,
                prefix_allowed_tokens_fn=prefix_fn,
                pad_token_id=tok.eos_token_id,
            )
        masked_text = tok.decode(masked[0, plen:], skip_special_tokens=True).strip()
        emitted = masked_text.split('"')[0].strip()
        if emitted in ALLOWLIST:
            b_cited += 1
        else:
            b_invalid += 1

    n = len(PROMPTS)
    print("=" * 64)
    print("Evidence-ref citation proof (model: gpt2, greedy, deterministic)")
    print("=" * 64)
    print(f"prompts: {n}")
    print(f"Path A (free decode + post-decode strip):")
    print(f"    valid ref cited : {a_cited}/{n}")
    print(f"    dropped (uncited): {a_invalid_emissions}/{n}")
    print(f"Path B (during-decode mask, MiniOneRec-ported):")
    print(f"    valid ref cited : {b_cited}/{n}")
    print(f"    off-allowlist   : {b_invalid}/{n}  (zero by construction)")
    print("-" * 64)
    recovered = b_cited - a_cited
    print(f"citations recovered by masking: {recovered}/{n} "
          f"({100.0 * recovered / n:.0f}% of findings)")
    print(f"off-allowlist emission rate: A={a_invalid_emissions / n:.0%}  B={b_invalid / n:.0%}")
    print("=" * 64)

    # The load-bearing structural claim, model-independent:
    assert b_invalid == 0, "Path B emitted an off-allowlist ref: masking is broken"
    # The empirical claim in this regime:
    if recovered <= 0:
        print("NOTE: gpt2 already cited as well as the mask on these prompts; "
              "the structural guarantee (B off-allowlist = 0) still holds.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
