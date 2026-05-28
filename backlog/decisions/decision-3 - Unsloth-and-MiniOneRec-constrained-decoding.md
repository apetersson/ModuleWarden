---
id: decision-3
title: Unsloth swap and constrained-decoding library choice
date: 2026-05-28
status: accepted
---

# Decision: outlines tonight, defer Unsloth, do not port MiniOneRec

A teammate proposed two changes for the Saturday training run:

1. Swap Recipe A from the pinned HF+peft+trl cohort to Unsloth (claim:
   2x faster, 70 percent less VRAM)
2. Port MiniOneRec's LogitProcessor + GRPO trainer (claim: guarantees
   100 percent json_validity and 100 percent evidence_citation_accuracy)

Deep-analyst investigation found both estimates were optimistic. The
correct path is a third one: add the `outlines` library tonight at
inference time only, defer Unsloth, do not port MiniOneRec.

## Why not Unsloth tonight

Unsloth's published dep requirements as of Friday 2026-05-28:

| Package | Unsloth requires | Our pinned cohort | Drift |
|---|---|---|---|
| transformers | >=4.51.3 | 4.46.0 | 5 minor versions |
| peft | >=0.18.0 | 0.13.0 | 5 minor versions |
| trl | >=0.18.2, <=0.24.0 | 0.12.0 | 6 minor versions |
| bitsandbytes | >=0.45.5 | 0.44.1 | 1 minor version |

All four pinned dependencies require simultaneous major version bumps.
Our cohort was pinned specifically because of an earlier resolver-skew
bug on vast.ai during the 1.5B smoke run. Bumping all four on Friday
night on a remote paid GPU instance, with no rehearsal smoke for the
new cohort, is exactly the scenario the pinned cohort was built to
prevent.

The 2x speed claim is real and verified, but a 1-2 hour wall-clock win
is not worth a pip-resolver-conflict failure during a paid GPU window.

**Fallback path**: if the Saturday QLoRA run OOMs even after dropping
seq_len from 8192 to 4096, swap to Unsloth at that point. By then we
have a concrete justification.

## Why not MiniOneRec

MiniOneRec's LogitProcessor is coupled to their RQ-VAE-generated item
SID codebook, not a static token set. Adapting it to constrain on
allow/block/quarantine plus evidence_ref allowlisting requires:

- Strip the SID vocabulary logic (their entire ontology)
- Rebuild the token mapping layer for our verdict vocabulary
- Adapt the GRPO reward from rank-aware recommendation scoring to
  binary security classification with citation bonus
- Validate GRPO does not diverge on 50-100 steps from an SFT checkpoint
  with a small dataset (known instability)

Their requirements.txt also conflicts with our pinned cohort on the
same four packages. The 3-4 hour estimate is at least 2x optimistic
and the realistic surface is 8-10 hours.

## Why outlines instead

The outlines library (github.com/outlines-dev/outlines) provides
JSON-schema-constrained decoding via a LogitsProcessor hook that works
with standard HF model.generate(). It:

- Is a single `pip install outlines`
- Has no hard dep bumps against our pinned cohort (only requires torch
  and transformers, both already installed)
- Constructs an FSM over the token vocabulary at generation time and
  masks logits to valid continuations
- Works model-agnostic; the Qwen2.5-Coder-7B tokenizer needs no changes
- Hooks in at inference time, so training procedure is unchanged

Implementation sketch:

```python
import outlines
from pydantic import BaseModel
from typing import Literal

class AuditReport(BaseModel):
    verdict: Literal["allow", "block", "quarantine"]
    confidence: float
    evidence_ref: list[str]

model = outlines.models.transformers("models/mw-qwen25-7b-v1")
generator = outlines.generate.json(model, AuditReport)
```

The `evidence_ref` allowlist is passed at generation time; the FSM
masks any token sequence not matching a known reference.

## Honest caveat for the pitch

outlines gives **structural** guarantee, not semantic. Specifically:

- Cannot emit malformed JSON (verdict will be one of three values; the
  output will always parse)
- Cannot cite an evidence_ref outside the allowlist (the FSM masks it)

But:

- Can still produce wrong verdict (just a valid one)
- Can still cite the wrong evidence_ref for this case (the right format,
  the wrong content)

If the judge asks about evidence_citation_accuracy, the answer is:
"format accuracy is 100 percent by construction via outlines; semantic
accuracy is measured on the test set and we report the raw number."

## Decision

1. **Tonight (30 min)**: Add outlines to `pyproject.toml` optional
   `[inference]` group. Wire it into `finetune/python/eval/matrix_runner.py`
   as an inference-time hook. Add unit test in `finetune/python/tests/`.
2. **Saturday training**: Stay on pinned cohort
   (transformers==4.46.0, peft==0.13.0, trl==0.12.0, accelerate==1.0.1,
   datasets==3.0.2, bitsandbytes==0.44.1). If OOM, drop seq_len from
   8192 to 4096 first.
3. **Saturday eval**: Run arm-1 (raw generate) and arm-2
   (outlines-constrained generate) side by side. Report the format
   delta to judges.
4. **Unsloth fallback**: only swap if Saturday training OOMs both at
   seq_len=8192 and seq_len=4096. Document the dep cohort bump as a
   separate operation.
5. **MiniOneRec port**: rejected for this hackathon. File as Q4 2026
   roadmap reference (the constrained-decoding-with-RL story is a real
   research direction for the v3 product).

## What this protects

- Saturday paid GPU window from a dep-resolver explosion
- Pitch from an over-promised "100 percent json validity learned at
  training time" claim that an actuary would push back on
- Schedule from an 8-10 hour port disguised as a 3-4 hour port

## References

- `finetune/python/training/sft_lora.py` (the entrypoint that would be
  swapped)
- `finetune/python/eval/matrix_runner.py` (where outlines wires in)
- `pyproject.toml` (where the optional `[inference]` dependency group
  lives)
- arXiv 2510.24431 (MiniOneRec paper, for the v3 roadmap reference)
- github.com/outlines-dev/outlines (the chosen library)

## Addendum (2026-05-28, later that night)

The decision above stands: the FULL MiniOneRec port (RQ-VAE SID
codebook adaptation plus the GRPO trainer, the 8-10 hour surface) is
still rejected for this hackathon.

What did ship is much smaller and does not touch any of the rejected
parts. `finetune/python/eval/minionerec_constraint.py` (201 lines,
10 passing tests) ports only two generic pieces: the logits-masking
step and the trie-backed prefix function. The trie is built fresh over
a dossier's evidence-ref allowlist. The RQ-VAE / SID machinery, the GRPO
trainer, and the training-time changes are all intentionally left out.

Why it landed anyway: `constrained_decode.py` already used outlines for
the JSON skeleton, then ran a post-decode rejector that STRIPPED any
invalid evidence_ref. Stripping guarantees zero invented refs, but it
drops the citation entirely when the free-decode emits a near-miss
(for example "ev.file.99" instead of "ev.file.002"), which costs
evidence_citation_accuracy. The trie mask fixes that during decode: the
model never sees the invalid token, so it picks a real ref instead of
dropping one. `constrained_decode.py` imports it lazily, so the outlines
path still works without it.

Net: outlines remains the documented entry point (runbook Step 6,
matrix_runner arm-2). The trie mask is an internal upgrade to that path,
not a competing track. Do not delete `minionerec_constraint.py` reading
the "rejected" line above out of context; `constrained_decode.py`
depends on it.
