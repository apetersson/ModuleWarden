---
id: decision-4
title: Verifier arm is measured not assumed (Stanford subtraction vs Mavis)
date: '2026-05-29 06:22'
status: accepted
---
## Context

A review of the team's distilled YouTube research surfaced two findings
that pull in opposite directions on whether ModuleWarden's agentic audit
arm should grow an LLM verifier stage:

1. **Mavis verifier pattern** (Minimax Mavis talk): an independent
   verifier agent with a cold-start context (zero producer reasoning
   history) catches errors the producer's own framing hides. Argues FOR
   adding a verifier.
2. **Stanford "orchestration over architecture" talk**: stripped
   harnesses match results at ~14x lower compute, and adding verifier
   passes HURT some benchmarks (cited as about -8.4). Argues AGAINST
   adding scaffolding the model does not need. (Figures are as stated in
   the talk, relayed second-hand; cite as "per the talk", not as a
   verified paper.)

Verified against the current code before acting:

- `packages/audit-runner/src/orchestrator.ts` has NO LLM verifier today.
  The only "verifier" in the system is the deterministic 5-rule policy
  gate that runs in front of the model and is authoritative on FAIL
  rows. That gate is already the cheap, compute-free verifier the
  Stanford talk would endorse.
- `finetune/python/eval/matrix_runner.py` already runs a 4-arm matrix
  (base/finetuned x one-shot/agentic-harness). That matrix is precisely
  an apparatus for measuring whether the heavier agentic path earns its
  latency over one-shot.

So the two talks are not actually in conflict for us: one says "measure
before you add scaffolding", the other says "a cold-start verifier is
the scaffolding worth measuring". ModuleWarden already has the referee.

## Decision

Do NOT add a blind LLM verifier to the agentic audit arm on faith.

- The deterministic gate stays the primary verifier. It is authoritative
  on FAIL rows, costs no tokens, and cannot be prompt-injected (proven by
  `demo/tests/test_injection_robustness.py`).
- If a cold-start LLM verifier is added, it ships as a MEASURED fifth arm
  in `matrix_runner.py`, not as an assumed improvement. Keep it only if
  the matrix shows it beats arm-2 (fine-tuned one-shot) on malicious
  catch rate without inflating the false-quarantine rate, and only if the
  added latency/token cost is justified by that delta.
- Filed as a backlog task with that gating condition, deferred until a
  Saturday SFT checkpoint exists to measure against.

## Consequences

- Strengthens the pitch answer to "why the agentic harness?": the honest
  answer is "we measure it; we do not assume it helps, because the
  published evidence is that verifiers can hurt." That is a stronger
  position in front of UNIQA judges than asserting the agentic arm is
  better.
- No code change this weekend. The deterministic-gate-in-front design is
  validated, not altered.
- If arm-5 is later measured and loses, that is a publishable negative
  result, not a failure: it confirms the cheap deterministic gate plus a
  fine-tuned one-shot model is the right operating point.

## Other video-research findings (not decisions, logged for completeness)

- **Bumblebee** (Perplexity scanner): the marketing site advertises a
  Bumblebee pairing but there is zero Bumblebee code in the repo. It is
  an install-inventory tool (what is on a machine), not a version-diff
  auditor (what changed), and is macOS/Linux only. Recommend softening
  the website copy to "designed to pair with" rather than wiring a Go
  binary into `audit-runner` this weekend. Tracked separately; the
  website is a different repo.
- **Eval ledger** (per-arm wall-time/token logging): already present in
  `finetune/python/eval/metrics.py` (runtime p50/p95/total per arm). Only
  per-arm token count is missing; minor enhancement, not filed.
- **Graph-RAG / RAG-inverted for evidence assembly**: misapplied to
  ModuleWarden. `dossier_builder.py` is a structural builder over the
  version-diff (regex capability detection), not a retrieval system.
  There is no retrieval step to improve. Dropped.
- Workflow-tool, agent-OS, Archon, Connectors, aliasweb, Dealmatrix
  videos: dev-harness or unrelated domains; no product application.
