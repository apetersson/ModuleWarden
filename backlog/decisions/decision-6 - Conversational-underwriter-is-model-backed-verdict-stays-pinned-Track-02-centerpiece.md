---
id: decision-6
title: >-
  Conversational underwriter is model-backed; verdict stays pinned (Track 02
  centerpiece)
date: '2026-05-29 09:05'
status: accepted
---
## Context

A "what are we missing to win" pass (workflow mw-win-gap: 3 recon agents +
3 judge personas + synthesis, grounded on the live hackathon page)
converged unanimously on one loss condition.

Track 02 (UNIQA) is "conversational AI and model integration across UNIQA
digital insurance products," and the org rewards "a small model fine-tuned
on real data with a live demo." But the headline conversational surface,
`chat/`, was a deterministic router that read JSON fixtures and NEVER
called the fine-tuned model. The docstring even described an LLM-augmented
mode gated on OPENAI_API_KEY that did not exist in code (SYSTEM_PROMPT_PATH
was loaded by nobody). So the one place the trained model should speak on
stage was the one place it was absent. A judge who realized the chat never
touches the trained weights would discount the whole "real model" claim.

## Decision

Wire the conversational assistant to the fine-tuned model, and reframe its
output as an underwriting Control Evidence Memo, while keeping the verdict
deterministically pinned.

- `chat/model_client.py` (new): OpenAI-compatible chat-completions client,
  stdlib-only (keeps `chat/` torch-free). Reuses the gate contract
  (`MW_MODEL_ENDPOINT_BASE_URL/_API_KEY/_MODEL`) or `OPENAI_*`. The weights
  are reached by pointing the base URL at whatever serves them (local
  vLLM, the Leonardo checkpoint, any OpenAI-compatible host). NOT the
  synthesis-suggested `_hf_generate` against a local checkpoint, because
  that checkpoint does not exist on this box (the A100 smoke ran on a
  destroyed vast.ai instance) and an endpoint client is what the
  Leonardo-served model will expose anyway.
- `chat/agent.py`: `_render_underwriting_memo` (deterministic 3-field card:
  risk tier, premium/exclusion, cited evidence) + `narrate_underwriting`
  (calls the model with the system prompt + the PINNED verdict, instructs
  it to explain not decide). `handle_query` lookup and the sidebar both
  route through `lookup_by_incident_id`, so typed queries, the CLI, and the
  UI are all model-backed identically.
- `chat/prompts/system.md`: rewritten to the underwriter 3-field output
  contract and the one-rule-that-cannot-break (verdict is pinned; explain,
  do not change it). Now actually loaded and sent.
- `chat/app.py`: title-bar badge shows live-model vs deterministic mode so
  the live-weights moment is visible on stage; evidence panel surfaces
  `model_backed` / `endpoint_error`.

## The invariant

The verdict is ALWAYS sourced from the deterministic gate + audit report,
never from the model. Tests assert it: with a mocked endpoint returning
arbitrary prose, `evidence["verdict"]` still equals the report verdict,
the model is handed `"verdict": "block"` with "do not change the verdict",
and the pinned memo is retained beneath the model prose as the audit
trail. Satisfies the three-identity-surfaces rule (gate / model / chat
never lie about each other).

## Consequences

- The live demo now shows the fine-tuned model speaking insurance, on
  stage, over a pinned verdict. Collapses both losing conditions at once:
  proves the model is real (beats a RAG chatbot) and that it speaks
  insurance, not AppSec (satisfies "align to partner domain").
- Demo-safe: with no endpoint, the deterministic memo (real verdict, tier,
  exclusion, evidence) still renders, so the demo works offline. An
  endpoint error is surfaced in the evidence panel, not silently hidden,
  and the deterministic memo still shows the real verdict. This is not a
  verdict fallback (the verdict was never the model job); only the optional
  narration is skipped.
- For the live pitch: set MW_MODEL_ENDPOINT_BASE_URL to the vLLM-served
  Leonardo checkpoint and the chat narrates with the real fine-tune.
- Tests: chat suite 20 -> 25; full finetune+demo+chat sweep green (81).

## Not done (scope discipline, per the synthesis)

No RAG over policy PDFs, no premium-calculation engine (qualitative
loading/exclusion only), no new training run, no new incident fixtures, no
change to the production TS gate. One package, one memo, live weights.
