---
id: decision-7
title: >-
  Swarm audited the wrong codebase; real gaps were demo-hardening, honest corpus
  eval, and website honesty
date: '2026-05-29 11:33'
status: accepted
---
## Context

A 5-agent swarm produced a consolidated "kill list + 36-hour sprint" that
read as a brutal-truth gap analysis: "your repo is a FastAPI stub with a
5-entry dict, every training script raises NotImplementedError, zero chat
code, no memo generator, repo link 404s."

Probing the live record (not the swarm narration) showed the swarm audited
`apiary-starter/` - a separate stub scaffold sitting untracked in the
kimiclaw working tree - not the submission repo (`apetersson/ModuleWarden`).
Its verdicts were true of that scaffold and false of the submission:

- "zero chat code / no memo" - both built and merged today (PR #12).
- "npm install doesn't touch the gate / synthetic theater" - false; the
  real `api-proxy` has packument/tarball/filter routes that hit the live
  registry.
- "no real data" - false; 10k+ scraped GHSA cases are on disk.
- "repo link 404" - the repo is PRIVATE, not missing.

Two swarm conclusions were correct once re-applied to the real repo:
no real model number, and vapor claims on the live website.

## Decision

Build the genuinely-missing, honest, tonight-achievable items; do not
rebuild what exists, and do not fabricate a metric the data cannot support.

- Demo hardening: `demo/preflight.py` (fail-loud, verifies the three pitch
  incidents - model verdict, independent gate agreement, effective-verdict
  invariant, memo write) + `demo/safe_demo.sh` (preflight-gated, offline,
  optional live-proxy 403) + `demo/tests/test_preflight.py`.
- Honest corpus eval: `finetune/python/eval/corpus_report.py`. The corpus is
  all confirmed-vulnerable advisories with no benign label, so NO binary
  AUROC is claimed (a test enforces no metric field leaks). It reports real
  composition: 4,212 cases / 2,139 packages, 1,692 embedded-malicious-code
  (CWE-506), 2,259 vulnerable/first-patched trainable pairs, written to
  `corpus-metrics.json`.
- Website honesty: softened current-capability SIEM claims and the SOC 2
  Type II cert claim to roadmap framing in `modulewarden-landing/index.html`.
  Kept Verdaccio (real) and self-host (real). Deploy is one manual
  `wrangler login` + `wrangler pages deploy .` (wrangler is unauthenticated
  on this box; cannot deploy headless).
- Chat serve path: `chat/check_endpoint.py` (one-command rehearsal check,
  exit 1 on a configured-but-down endpoint) + `chat/SERVE_LOCAL.md` (point
  the endpoint at any OpenAI-compatible server; the verdict stays pinned).

## Consequences

- The XGB-fallback "real AUROC tonight" item from the swarm plan was
  rejected as un-honest on this data: a malicious-vs-benign classifier needs
  a benign class the corpus does not have, or thousands of tarball fetches.
  Manufacturing the label would violate the swarm's own honesty pass and the
  no-fabrication rule.
- `apiary-starter/` remains in the tree as a decoy that misled the swarm.
  Future audits must confirm they are reading `apetersson/ModuleWarden`, not
  the scaffold. Left in place (may be intentional), flagged here.
- Demo is now drift-proof: a flipped fixture verdict fails CI and preflight,
  not the stage.
- The pitch can quote real numbers (4,212 advisories, 1,692 CWE-506, 2,259
  pairs) for "fine-tuned on real data" without overclaiming a trained-model
  metric that does not exist (only a 5-example smoke ran).
