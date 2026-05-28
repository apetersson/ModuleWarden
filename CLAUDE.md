# CLAUDE.md

ModuleWarden is a private agentic version-diff gate for npm. The repo ships
three composable surfaces: a self-hosted npm registry proxy plus per-job
Docker audit (production gate), a Python SFT pipeline aligned to
`audit_dossier.v1` and `audit_report.v1` schemas (fine-tune), and a
conversational underwriter assistant in Streamlit plus CLI (front-end).

Built for Zero-One Hack Vienna 2026, UNIQA Track 02 (Insurance). 36 hours
on Leonardo supercomputer (64x A100 per booking, 6 nodes, ~4 TB VRAM).
Submission requires a real trained model plus live demo. Three identity
surfaces (gate, model, chat) are intentionally separated; none of them
lies about the others.

## Commit and discipline rules

- Conventional commits. Body 3-4 lines max. No co-author trailer, no
  footer. Frequent commits at every positive-progress point.
- Commit body should let a competent LLM re-author the change from the
  previous state. If it cannot, split the commit.
- No fallbacks, no data migrations, no legacy paths. Green-field repo.
- `.ralph/` is goal-setting scratch. Ignore for code review.
- All Backlog task edits go through the `backlog` CLI (`backlog task
  edit --plain ...`). Never edit `backlog/tasks/*.md` files directly.
  Full Backlog.md CLI reference: `backlog --help` and
  https://github.com/MrLesk/Backlog.md.

## Project map (where things live)

| Surface | What it does | Where |
|---|---|---|
| Production gate | npm registry proxy plus per-job Docker audit. Approves / quarantines / blocks each install. | `packages/api-proxy/`, `packages/worker/`, `packages/audit-runner/`, `docker-compose.yml` |
| Fine-tune pipeline | Python SFT pipeline + 4-arm eval matrix. Aligned to canonical schemas. | `finetune/python/` |
| Conversational front-end | Underwriter assistant (Streamlit UI + headless CLI). Deterministic router by default. | `chat/` |
| Admin dashboard | React 19 + Vite 6 SPA. Includes Underwriter view route for the UNIQA-track pitch. | `packages/web-ui/` |
| Live-pitch demo | Offline incident replay. No Docker, no network, no LLM. | `demo/run_incident_replay.py` |
| Schema contracts | Canonical audit dossier + report shapes. Schema-first. | `finetune/contracts/` |
| Pitch + economics | UNIQA underwriter pitch, anchored citations, slide deck, video script, runbook, preflight, Q&A, track reframes. | `finetune/python/pitch/` |
| Hackathon log | Narrative of what landed in the build window. | `docs/hackathon-build-log.md` |
| Training notes | Two recipe options, FSDP/LoRA gotchas, eval baselines. | `finetune/python/HACKATHON_NOTES.md` |

## Active state

- **Offline live demo ready.** Three incident fixtures: `postmark-mcp-1.0.16`
  (BLOCK, the centerpiece), `postmark-mcp-1.0.12` (ALLOW, last clean
  release of same package), `lodash-4.17.21` (ALLOW, popular baseline).
  All three are dossier+report pairs validated against the canonical
  schemas.
- **Chat front-end shipped.** Deterministic router (`chat/agent.py`),
  Streamlit UI (`chat/app.py`), headless CLI (`chat/cli.py`). System
  prompt at `chat/prompts/system.md`. Reads same fixtures as the demo.
- **Admin dashboard shipped.** Six routes: Dashboard, Queue, Prompts,
  Campaigns, Evaluation, Underwriter. React 19 + Vite 6 + recharts.
- **Real-hardware smoke OK.** Qwen2.5-Coder-1.5B-Instruct QLoRA on a
  single A100, 20 steps on a 5-pair dataset, loss 5.36 to 0.73. Held-out
  generation on `react@18.2.0` returned syntactically valid
  `audit_report.v1`-shaped JSON. Evidence at
  `finetune/python/eval/smoke_results/vast_smoke_38255250.json`.
- **Scraped GHSA corpus committed.** 2305 cases at
  `finetune/corpus/scraped-cases.jsonl`. Saturday morning corpus_walker
  run produces sft-records.jsonl.
- **Pinned dep cohort identified.** `transformers==4.46.0`,
  `peft==0.13.0`, `trl==0.12.0`, `accelerate==1.0.1`, `datasets==3.0.2`,
  `bitsandbytes==0.44.1`. Strict-pin and use this for the Leonardo run.
- **Pre-abliterated checkpoint chosen.** `huihui-ai/Huihui-Qwen3.6-27B-abliterated`
  saves 30-90 minutes of in-repo abliteration. Apache 2.0, BF16
  safetensors.

## Operational commands

### Live demo (offline, no Docker, no API keys)

```bash
python -m demo.run_incident_replay --list
python -m demo.run_incident_replay --incident postmark-mcp-1.0.16
python -m demo.run_incident_replay --incident postmark-mcp-1.0.12
python -m demo.run_incident_replay --incident lodash-4.17.21
```

Output: colored 5-rule policy table, cited model report, developer-safe
summary, security-admin summary, Control Evidence Memo to
`demo/outputs/<id>__YYYY-MM-DD.md`.

### Conversational assistant

```bash
# Headless CLI
python -m chat.cli --list-incidents
python -m chat.cli "look up postmark-mcp@1.0.16"
python -m chat.cli "what are the gate rules?"
python -m chat.cli --interactive

# Streamlit UI (the live-demo target)
pip install -r chat/requirements.txt
streamlit run chat/app.py    # http://localhost:8501
```

Optional LLM path via `OPENAI_API_KEY`. Router never lets the LLM invent
verdicts; dossier and report are pre-loaded before the chat call.

### Admin dashboard (with Underwriter view)

```bash
cd packages/web-ui
pnpm install   # if not already done at repo root
pnpm dev       # http://localhost:5173
```

Six routes: Dashboard, Queue, Prompts, Campaigns, Evaluation, Underwriter.
The Underwriter route is the UNIQA-track pitch surface; 5 panels showing
portfolio summary, correlated exposure, incident replays, pricing delta,
and a real-loss anchor.

### Tests (pre-pitch checklist)

```bash
pytest finetune/python/tests/   # schema conformance + attack catalog
pytest demo/tests/              # incident-replay alignment with deck
pytest chat/tests/              # router intent + verdict rendering
pnpm -r test                    # TypeScript packages
```

### Production stack (Docker)

```bash
cp .env.example .env
docker compose up -d            # postgres + verdaccio + api-proxy + worker + web-ui
modulewarden preflight pnpm-lock.yaml
modulewarden status
```

Then point npm/pnpm at `http://localhost:8080/` (`MW_API_PORT`).

### Build / lint / typecheck

```bash
pnpm install
pnpm -r build
pnpm -r typecheck
pnpm -r lint
pnpm -r test
```

### Saturday training pipeline

```bash
# 1. Generate SFT records (45 min, no GPU)
python finetune/python/pipeline/corpus_walker.py \
  --scraped-cases finetune/corpus/scraped-cases.jsonl \
  --output finetune/corpus/sft-records.jsonl \
  --manifest finetune/corpus/walker-manifest.json \
  --concurrency 4 --max-cases 600 --verbose

# 2. Rehearsal smoke (10 min)
python -m finetune.python.training.rehearsal \
  --base-model Qwen/Qwen2.5-Coder-1.5B-Instruct \
  --sft-jsonl finetune/corpus/sft-records.jsonl --quick

# 3a. Leonardo primary run (fill ACCOUNT first)
sbatch finetune/python/slurm/train_qwen3.6.slurm

# 3b. vast.ai safety-net run (Recipe A, 1x A100, 2-4h)
# See HACKATHON_NOTES.md for the exact sft_lora.py invocation
```

### Adding a new demo incident

1. Author `demo/incidents/<id>.dossier.json` matching
   `modulewarden.audit_dossier.v1` (see
   `finetune/contracts/audit-dossier.schema.json`).
2. Author the paired `demo/incidents/<id>.report.json` matching
   `modulewarden.audit_report.v1`.
3. The CLI auto-discovers via `--list`.

## Training pipeline

Two recipes documented in `finetune/python/HACKATHON_NOTES.md`:

- **Option A (vast.ai safety net, 1x A100, 2-4h, USD 5-10).**
  `Qwen2.5-Coder-7B-Instruct` + QLoRA 4-bit NF4, r=64 alpha=128
  dropout=0.05, all-linear, seq_len=8192, effective batch 128,
  LR 2e-4 cosine, 3 epochs.
- **Option B (Leonardo primary, 64x A100 FSDP1, 6-12h).**
  `huihui-ai/Huihui-Qwen3.6-27B-abliterated` + bf16 LoRA (NOT QLoRA for
  Qwen3.6), r=16-32 alpha=2*r dropout=0.0, all-linear, seq_len=4096,
  per-device 2 grad-accum 4 (global 512 on 64x).

Critical gotchas (from `HACKATHON_NOTES.md`):

- FSDP2 + Qwen3 hits `KeyError: lm_head.weight` (axolotl #3056). Use
  FSDP1.
- `target_modules="all-linear"`. Qwen3.6's hybrid Gated DeltaNet has
  different projection names than `q_proj`/`v_proj`; the standard 7-name
  list misses the DeltaNet layers entirely.
- bf16 only. fp16 overflows on Qwen3.6 architectures.
- `gradient_checkpointing_kwargs={"use_reentrant": False}` or FSDP
  breaks.
- Qwen3.6 emits `<think>...</think>` blocks. For classification add
  `/no_think` to user prompts or set `enable_thinking=False`.
- Unsloth seq_len > 65536 = gradient explosion. Use standard
  HF/axolotl/trl instead.

Eval framework: SecLens-R 4-arm matrix
(`finetune/python/eval/matrix_runner.py`). Primary metrics for
underwriting (`finetune/python/eval/metrics.py`): `malicious_catch_rate`,
`false_quarantine_block_rate`, `json_validity`,
`evidence_citation_accuracy`, `missed_suspicious`, runtime,
`tool_call_count`. Pre-flight before any Leonardo run:
`python -m finetune.python.training.rehearsal` on a 1.5B model in 30 min.

Floor baselines: GPT-4 zero-shot 97% F1 on npm malware
(arXiv:2403.12196), fine-tuned DeepSeek-Coder-6.7B 87% accuracy (same
paper), taint-flow-augmented F1=0.915 (arXiv:2510.20739). A 27B
fine-tuned model should sit between 87% and 97%; below 87% means
something is wrong with the data or hyperparams.

## Schema contracts (load-bearing, read before touching audits)

- `finetune/contracts/audit-dossier.schema.json` is the model input
  (deterministic evidence prepared by ModuleWarden).
- `finetune/contracts/audit-report.schema.json` is the model output
  (verdict, confidence, risk_level, primary_findings, summaries).
- Every finding must cite an `evidence_ref` that exists in the dossier.
  Invented refs lose accuracy points in eval. Stale refs do not.
- Both schemas carry a `schema_version` stamp. The chat assistant uses
  this to guarantee a verdict is real rather than invented.

## Verdict semantics (production gate)

- **ALLOW.** Exact package version hash approved. Any other hash for the
  same version string is NOT approved. Tarball promoted from upstream
  npm to Verdaccio.
- **BLOCK.** Blocked by security policy. npm clients see a clear error.
  Only security-admin override (`MW_AUTH_ADMIN_TOKENS`) can change.
- **QUARANTINE.** Suspicious but not confirmed malicious. Not served.
  Human review recommended. Security-admin override available.

Cold-start packages (no predecessor) receive conservative full-package
review. Missing or ambiguous evidence routes to QUARANTINE.

## Three-layer audit architecture (pitch frame)

1. **Deterministic 5-rule gate** handles roughly 80 percent of decisions.
   Release-age, lifecycle-script triage, SRI checksum, source-match,
   allowlist. Free, fast, no LLM involved.
2. **MW fine-tuned 27B model** in per-job Docker container with
   run-scoped RPC tokens and prompt secrecy guaranteed. Primary verdict
   for the remaining 20 percent.
3. **DeepSeek V3 hosted** as the second-opinion model on QUARANTINE-band
   decisions only (about 5 percent of total). Captured in supersedes
   pointer if disagreement; routes to admin override workflow.

This is the reinsurance pattern: primary writes the policy, secondary
provides the second opinion on borderline cases. UNIQA's cyber product
team recognizes the shape immediately.

## Insider AI-assisted threat surface (pitch frame)

Most npm supply chain security stops the external attacker. ModuleWarden
also gates the install when:

- A developer asked an LLM (Copilot, Cursor, Claude Code, Codex CLI) for
  a CSV parser and the LLM suggested a malicious package
- A contractor merged a dependency PR without security review
- Internal CI auto-bumped a transitive dependency without checkpoint

Verizon DBIR 2024 puts 74 percent of breaches on the human element.
UNIQA's existing underwriting questionnaire has 11 sections and none
ask about this vector. ModuleWarden is the twelfth section.

## Anti-goals (do not pitch, do not build)

- Not generic package sovereignty or "replace npm".
- Not auditing every package in the registry like a human reviewer.
- Not preventing novel zero-days in benign packages.
- Not catching malicious *authors* on first publish. Only version
  updates to packages already in the dependency graph.
- Not an autonomous LLM agent that runs tools at the live demo. The
  router is deterministic by design so the demo is reproducible.
- Not SaaS-locked. Optional LLM path is OpenAI-compatible env vars;
  vLLM or Ollama also work.
- Not a UNIQA-specific UI skin yet. Visual treatment is neutral so the
  Friday case reveal can drive final styling without rework.
- Not a claim of beating GPT-4 on the open-source baseline yet. The
  floor baselines are the bar; a real Leonardo run produces the actual
  number.

## Canonical references

- `README.md`: threat model, architecture diagram, getting-started.
- `docs/architecture.md`: v1 implementation contract, threat
  classification (Class A primary, B/C non-target), prompt secrecy model.
- `docs/hackathon-build-log.md`: build-window narrative, what ships,
  intentional non-scope, pre-pitch checklist.
- `finetune/python/HACKATHON_NOTES.md`: two recipes, FSDP/LoRA gotchas,
  eval framework, floor baselines, Pantheon council reference.
- `finetune/python/pitch/`: 9-doc pitch package: slide-deck, video-script,
  demo-runbook, preflight-checklist, q-and-a-prep, track-reframes,
  underwriter-economics, insurance-economics-slides, README.
- `CLAUDE.md` (this file): operational brief for CLI agents.
- `AGENTS.md`: pointer to this file.
