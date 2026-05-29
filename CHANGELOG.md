# ModuleWarden Changelog

## 2026-05-29 (Saturday - injection hardening + activation steering)

Audit-LLM injection defense, defense in depth with the deterministic gate.

### Security / model hardening

- Ingestion normalize at `data/ingestion_hardening.py`, wired into
  `corpus_walker`: strips invisible-unicode smuggling (U+E0000-E007F tag
  block, zero-width, variation selectors) from untrusted package free-text
  before tokenization. Always on. Spotlighting datamark helper included.
- Adversarial injection-hardening SFT generator at
  `data/injection_hardening.py` (payload catalog `data/injection_payloads.py`):
  counterfactual records carry a T1606 injection but keep the structural gold
  verdict. CLI appends to the corpus at a 10 to 20 percent rate (StruQ/SecAlign).
- Injection-robustness metric at `eval/injection_robustness.py`: verdict-flip
  rate, ASR, and severity-weighted WAVS. Measured, not assumed (decision-4).
- Activation-steering harness at `steering/` (`activation_steering.py`,
  `contrastive_prompts.py`): computes a security-skeptical steering vector and
  adds it to the residual stream at inference (arXiv:2308.10248). Architecture-
  agnostic, gpt2-tested; point at the Qwen checkpoint and gate on the
  robustness metric. Run on the HF inference path, not vLLM.

### Tests

- `tests/test_injection_hardening.py` (9) and `tests/test_activation_steering.py`
  (4) added; full finetune suite green.

### Decisions

- Steering resources triaged: gemini-cli model-steering and ExploitBench
  skipped as off-domain; SIMS (arXiv:2507.08967) noted as the advanced
  steering variant for future work. See backlog TASK-33.

## 2026-05-28 (Friday — Zero-One Hack Vienna pitch prep)

What landed in the Friday-night build window before the Saturday
training run and Sunday 13:30 pitch. Listed in reverse-chronological
order so the newest material is at the top.

### Infrastructure and tooling

- Saturday quick-start one-pager at `finetune/SATURDAY_QUICKSTART.md`
  with six numbered steps, vast.ai market survey, and verification
  after each command
- Cross-platform Python seeder at
  `finetune/python/data/benign-packages/seed.py` (works on Windows
  git-bash where the curl-based bash version drops output silently)
- Nextcloud sync helper at `finetune/scripts/nextcloud-sync.sh`
  (ls / pull / push subcommands; reads `.env` so secrets never leak
  into git)
- GitHub PAT and Nextcloud credential template in `.env.example`
- Pinned dep cohort enforced (transformers 4.46.0 + peft 0.13.0 +
  trl 0.12.0 + accelerate 1.0.1 + datasets 3.0.2 + bitsandbytes 0.44.1)
- aiohttp dependency declared in `finetune/python/pyproject.toml`
  (was used by vast_smoke.py but missing from the install set)
- outlines + pydantic added as `[inference]` optional dep group
- Recipe A vast.ai launch runbook at
  `finetune/python/RECIPE_A_LAUNCH.md`

### Data

- 8510 GHSA cases scraped with the new GitHub PAT (rate limit lifted
  from 60 to 5000 per hour); uploaded to Nextcloud at
  `scraped-cases-overnight.jsonl`
- 4212 enriched cases pre-staged at
  `scraped-cases.npm-enriched.jsonl`
- 20 benign npm packages bundled and pushed to Nextcloud as
  `benign-packages-seed.tar.gz` (unblocks the 26-pattern synthetic
  attack injector)
- Partial SFT records at `sft-records-partial.jsonl` for smoke testing
  (the full walker run is in flight)

### Pitch

- Three new pitch angles integrated into `slide-deck.md`: insider
  AI-assisted threat surface (Verizon DBIR 74 percent), three-layer
  architecture (deterministic gate + MW fine-tuned 27B in Docker +
  DeepSeek V3 second opinion on QUARANTINE band), structured pilot
  asks (6-8 week pilot, product-design partnership, outcome funding)
- Underwriter view scaffolded in `packages/web-ui/src/underwriter/`
  with six panels (PortfolioSummary, CorrelatedExposure,
  IncidentReplays, PricingDelta, RealLossAnchor, InsiderRiskPanel)
  and a 50-row Austrian SME mock portfolio
- Q10a entry on Decepticon (PurpleAILAB) for the offense-vs-defense
  judge question
- Saturday-runbook + preflight + video-script + Q&A + track-reframes
  ported from apiary

### Architecture decisions

- decision-1: Hybrid pipeline. Python corpus_walker.py for Saturday's
  critical path; Andreas's MJS architecture from
  `finetune/high-level-plan.md` becomes the Q3 post-hackathon target.
  Andreas owns `validate-audit-report.mjs` Step 4 as a parallel
  low-risk track.
- decision-2: ExploitBench eval target rejected. V8 exploit-payload
  benchmark requires multi-turn agentic Docker loops, not single-turn
  JSON classification.
- decision-3: outlines library adopted for inference-time JSON-schema
  constrained decoding. Unsloth swap deferred (current pinned cohort
  conflicts with Unsloth's 4-6 minor version dep bumps). MiniOneRec
  port rejected (LogitProcessor is RQ-VAE coupled, port is 2x the
  3-4h estimate).

### Adversarial review fixes

10 silent-failure modes caught by Friday-night deep-analyst review,
all patched and merged:

1. CLAUDE.md pointed at stale `scraped-cases.jsonl` (2305 cases)
   instead of the new `scraped-cases-overnight.jsonl` (8510 cases)
2. Walker command crashed on relative imports as `python file.py`;
   changed to `python -m`
3. `seed.sh` silently skipped all 20 packages if npm not on PATH;
   added preflight checks and curl error handling
4. sample-bad-deps Docker test referenced non-existent `mw-gate`
   alias; changed to real service `api-proxy`
5. sample-bad-deps network name `modulewarden_default` did not exist
   under typical project name; pinned `COMPOSE_PROJECT_NAME` in env
6. Recipe A vast.ai launch was undocumented; wrote
   RECIPE_A_LAUNCH.md
7. recharts missing from pnpm-lock.yaml (Andreas's bd1e085 fixed)
8. HF_HOME unset on local rehearsal could fill home partition
9. Git pull behavior on gitignored overnight scrape documented
10. sample-bad-deps offline isolation vs live-stack requirement now
    bold-called-out in `FINETUNE-DATA-PLAN.md`

### Saturday-morning prisma generate gotcha

Caught by regression check at 21:35: `pnpm -r build` fails with
`TS2305: Module '@prisma/client' has no exported member 'ModelProfile'`
if `prisma generate` has not run since the last `pnpm install`. There
is no postinstall hook. The fix is one extra step:
`pnpm install && pnpm generate && pnpm -r build`. Now documented in
SATURDAY_QUICKSTART.md pre-flight section.

### Saturday-morning VITE_MW_API_BASE_URL gotcha

Second build landmine, found at 23:50 on re-check. web-ui now treats
`VITE_MW_API_BASE_URL` as a required build-time invariant (task-29
fail-early). A bare `pnpm -r build` aborts with "VITE_MW_API_BASE_URL is
required". Set it inline:
`VITE_MW_API_BASE_URL=http://localhost:8080 pnpm -r build`. Docker
Compose sets it automatically, so this only bites a bare local build.

### Test status (re-verified Saturday 00:05)

- Python: 76/76 pass (finetune + demo + chat)
- TypeScript: 6 of the 9 workspace packages build clean once
  `VITE_MW_API_BASE_URL` is set: shared, audit-runner, prisma-client,
  audit-rpc-server, web-ui, cli. `worker` and `api-proxy` are
  mid-refactor (logger-service extraction and a Prisma decision-key
  change) and do not compile yet. Neither is on the demo or fine-tune
  path, so this does not block Saturday. api-proxy fails only because
  its build script chains to worker.
- Offline demo: `python -m demo.run_incident_replay --incident
  postmark-mcp-1.0.16` returns BLOCK, risk_level critical, four evidence
  refs, and writes a Control Evidence Memo to `demo/outputs/`. All three
  incidents (lodash, postmark 1.0.12, postmark 1.0.16) replay exit 0.
  Note: the older `finetune.python.demo.offline_demo` path is gone; the
  demo now lives in the top-level `demo/` package.
- Fixed a build-blocker on main: `audit-rpc-server` called the shared
  `extractCapabilities` / `CapabilityFinding` (Andreas's ARCH-03 work)
  without importing them. Added the missing import.

### Andreas parallel-track

- Pruned AGENTS.md to CLAUDE.md canonical (5ad78bb)
- Added dockerized E2E validation with `cors-anywhere@0.4.4` test
  case (6216d75 + 013e441)
- TASK-28: remove file-only audit fallback from agentic audits

### What remains for Saturday

| Time | Action | Owner |
|---|---|---|
| 08:00 | git pull + pnpm install + pnpm generate + `VITE_MW_API_BASE_URL=http://localhost:8080 pnpm -r build` (worker/api-proxy still red, off-path) | Both |
| 08:15 | Pull data from Nextcloud (3 files) | Andrew |
| 08:30 | Run benign-packages seed | Andrew |
| 09:00 | Run walker if partial Nextcloud cache is insufficient | Andrew |
| 09:15 | Rehearsal smoke on Qwen2.5-1.5B | Andrew |
| 09:30 | Launch vast.ai Recipe A 7B QLoRA | Andrew |
| 09:30 | Submit Leonardo SLURM (once project ID arrives) | Andreas |
| 12:00 | Eval matrix arm-1 vs arm-2 | Andrew |
| 14:00 | Add arm-3 outlines constrained-decode arm if budget allows | Andrew |
| 17:00 | Pitch rehearsal | Both |
| 20:00 | Record 60-second backup video | Andrew |
| 22:00 | Sleep | Both |

### Budget

- vast.ai: 33.63 USD (8.63 USD original + 25 USD topup Friday night)
- Estimated Saturday spend: 11-15 USD for Recipe A + eval, leaves
  18+ USD buffer
