# ModuleWarden - Team Handover

Status snapshot for Andreas (apetersson). Last updated 2026-05-29 (Zero One Hack Vienna, day 1).

This is the one-page orientation: what we have built, where it stands, how to run it, and what is open before the pitch. Secrets are in `~/keys.txt` only, never in git.

---

## What we have built

ModuleWarden is a self-hosted npm registry proxy that acts as a dependency firewall. A deterministic 5-rule gate is the verdict authority; the LLM only narrates the verdict and can never override it. Verdict pinning is the load-bearing invariant that holds across every component below.

### Gate-is-authority, model-is-narrator

The gate runs 5 deterministic rules: release-age >= 14 days, install-script blocking, SRI checksum, source-match, and allowlist. Whatever the gate decides is final. The model receives the pinned verdict and writes the human-readable explanation around it. If the model hallucinates or gets prompt-injected, the verdict it is describing does not change. This is the single design decision the whole project hangs on.

### Chat: the conversational underwriter (Track 02 centerpiece)

`chat/app.py` is a Streamlit underwriter (plus a CLI) that answers package questions in plain language with the gate verdict pinned. It talks to any OpenAI-compatible endpoint via `MW_MODEL_ENDPOINT_BASE_URL/_API_KEY/_MODEL` or `OPENAI_*`, and falls back to a deterministic Control Evidence Memo when no endpoint is set, so the demo never goes dark. A judge can type any package name and get a grounded answer.

### Three injection-defense layers

All three are measured on one metric: verdict-flip rate / ASR on held-out novel phrasings.

- **Train-time adversarial SFT** (`finetune/python/data/injection_hardening.py`, with the MITRE ATLAS T1606 payload catalog in `injection_payloads.py`). Primary layer. Generalizes to paraphrases the model has not seen.
- **Served-path spotlight + instruction hierarchy** (`finetune/python/serving/prompt_defense.py`). Always on, no residual hooks, ships on the served model under a versioned `PromptDefensePolicy`. Runs on vLLM or llama.cpp.
- **Conditional activation steering** (`finetune/python/steering/conditional.py`, CAST detector-gated, vectors in `registry.py`). HF path. Adapts to new attack families by regenerating a steering vector, no retraining.

The adaptive thesis for UNIQA: the model is fine-tuned once, but layers 2 and 3 update without re-certifying a new model.

### MITRE ATT&CK kill-chain mapper

`finetune/python/decepticon/mapper.py` deterministically maps capability deltas to ATT&CK technique IDs. It is pinned like the verdict, not model-generated, so the kill-chain reads the same every run.

### Live GHSA / OSSF advisory hook

`chat/live_advisories.py` does read-only string lookups against GHSA and OSSF advisories, gated by `MW_LIVE_ADVISORIES=1`. This lets the underwriter answer for any package a judge types, not just the ones we pre-loaded.

### Production packages/ monorepo

`packages/` is a TypeScript monorepo: `api-proxy`, `audit-runner`, `audit-rpc-server`, `cli`, `prisma-client`, `shared`, `web-ui`, and `worker`, with `infra/searxng` for search. This is the registry-proxy plumbing the gate and chat sit on top of.

## Current status and launch plan

The model is real and the numbers are honest. We fine-tuned Qwen2.5-0.5B-Instruct with QLoRA on 386 ATT&CK-augmented GHSA records, producing a ~35MB adapter (local-only, gitignored). The committed metrics in `eval/finetune-metrics.attck.json` and `.test.json` tell the full story:

- Verdict-match: 0 percent base, 46.7 percent fine-tuned on validation, 73.9 percent on test.
- Schema-valid output: 3.3 percent base to 21.7 percent fine-tuned.
- Block-recall: 0 percent. The 0.5B catches 0 of 5 held-out severe cases.

That last number is the one we lead with, not the one we hide. Here is why it is a strength. ModuleWarden's verdict authority is the deterministic 5-rule gate, not the model. The gate catches the severe cases today, with zero LLM in the loop. The 0.5B is the narrator. It explains a verdict the gate already pinned. So a 0 percent block-recall on a 0.5B narrator is a known, bounded gap, not a silent failure. Block-recall is precisely the metric the scale-up targets, and we can show the lift on the same eval harness once the larger model lands.

The scale-up has two paths running in parallel.

Leonardo is the main event. `finetune/python/slurm/train_qwen3.6.slurm` launches a 64x H100 job on the Leonardo supercomputer for Qwen3.6-27B: abliterate, then SFT LoRA under FSDP, then the 4-arm eval. Queue-access credentials arrive 21:30 Vienna time tonight. The moment they land we fill `--account` and `sbatch` it.

vast.ai is the safety net. A 7B QLoRA runs there in parallel so we are not single-threaded on a supercomputer queue we do not control. A vast.ai RTX 3090 smoke run is validating the training pipeline end to end right now, before either real run.

Rehearsal-smoke-first is the discipline that ties it together. `finetune/python/training/rehearsal.py` validates the entire abliterate-SFT-eval pipeline on a 1.5B model before any H100 hours are spent. We do not burn 64 GPUs to discover a config typo.

Everything underneath is green. 69 tests pass (`python -m pytest finetune/python/tests/ -q`). The pitch site at ademczuk.github.io/modulewarden-website carries the injection-defense section and these same fine-tune numbers, stated the same honest way.

## How to run it

All commands run from the repo root. Secrets live in `~/keys.txt` and the `.env` template only - never commit them. Set `GITHUB_TOKEN`, `MW_MODEL_ENDPOINT_*` (or `OPENAI_*`), and the vast.ai key from those sources before running.

Chat demo. Launch the conversational underwriter, then verify the live-model badge lights up.

```bash
streamlit run chat/app.py
python -m chat.check_endpoint
```

If `check_endpoint` reports no endpoint, the chat falls back to the deterministic Control Evidence Memo - the verdict is still pinned, so the demo holds. Set `MW_LIVE_ADVISORIES=1` to enable the live GHSA + OSSF lookups for arbitrary packages.

Build the corpus. Walks `scraped-cases.npm-enriched.jsonl` and writes SFT records. Needs `GITHUB_TOKEN` in the environment (5000/hr PAT).

```bash
python -m finetune.python.pipeline.corpus_walker \
  --scraped-cases finetune/corpus/scraped-cases.npm-enriched.jsonl \
  --output finetune/corpus/sft-records.jsonl -v
```

The enriched corpus lives on the AI:AT Factory Nextcloud at `/ZeroToOne_Data/finetune-data/`. The repo ships `scraped-cases.jsonl` (4.6MB, un-enriched) as the fallback.

Rehearsal smoke. Validates the full training pipeline on a 1.5B model before any real run.

```bash
python -m finetune.python.training.rehearsal \
  --base-model Qwen/Qwen2.5-1.5B-Instruct --quick
```

Leonardo launch. Fill in `--account` in the SLURM script first, then submit. The job runs abliterate, then SFT LoRA FSDP, then the 4-arm eval for Qwen3.6-27B on 64x H100. Queue access opens 21:30 Vienna.

```bash
# edit finetune/python/slurm/train_qwen3.6.slurm -> set #SBATCH --account=<your-project>
sbatch finetune/python/slurm/train_qwen3.6.slurm
```

Tests. 69 should pass.

```bash
python -m pytest finetune/python/tests/ -q
```

Eval. Runs the 4-arm injection-robustness matrix (verdict-flip / ASR / WAVS).

```bash
python -m finetune.python.eval.matrix_runner
```

## Open work and who-does-what (for Andreas)

Day 1, 29 May. Three buckets below. Most training work is parked behind the 21:30 Leonardo credential drop, so demo and security can move in parallel now.

### Training and launch (gated on 21:30 Leonardo creds)

- **TASK-2 - Build corpus** (`corpus_walker` from `scraped-cases.npm-enriched.jsonl`, Nextcloud canonical). Without the enriched corpus, the scale-up trains on the 4.6MB un-enriched fallback and the block-recall number stays at 0.
- **TASK-3 - Rehearsal smoke** (`rehearsal --base-model Qwen2.5-1.5B-Instruct --quick`). Validates the abliterate to SFT to eval pipeline on a small model so the H100 hours are not burned on a broken script.
- **TASK-4 - Fill `--account` + sbatch `train_qwen3.6.slurm`** (after 21:30). The Qwen3.6-27B run is the headline scale-up; block-recall going from 0 percent is the whole pitch payoff.
- **TASK-5 - vast.ai 7B QLoRA safety net** (key in `~/keys.txt`, RTX 3090 smoke already validating). If the Leonardo queue stalls overnight, the 7B is the model we can still show Sunday.

### Demo and UI polish

- **TASK-6 - web-ui recharts underwriter view**. The chart-backed verdict view is what a UNIQA underwriter recognizes as their own workflow.
- **TASK-7 - 60-sec backup demo video**. If the live chat endpoint flakes during the pitch, the recorded run is the fallback that still lands the story.
- **TASK-13 - Seed 20 benign npm packages**. Judges will type real package names; benign seeds keep the gate from looking like it only ever says BLOCK.
- **TASK-16 - Select golden cases**. A curated set of clean PASS and severe BLOCK cases makes the deterministic-gate-vs-narrator split legible in 90 seconds.

### Security hardening (TASK-30.x)

- **Remove model API key from Docker env**. A leaked `MW_MODEL_ENDPOINT_API_KEY` in a container layer is the one finding that turns a security demo into a security incident.
- **Rate limiting**. Stops a curious judge (or a bad actor) from hammering the live-advisory hook and knocking the demo over mid-pitch.
- **Predecessor-diff + escalation heuristic**. Sharpens the 5-rule gate so version-bump attacks and severity jumps surface instead of slipping through as PASS.

### If you only do three things tonight

1. **TASK-3 rehearsal smoke** - prove the training pipeline works before 21:30, so the Leonardo creds drop straight into a launch instead of a debug session.
2. **TASK-30.x remove the model API key from Docker env** - cheapest fix, worst-case blast radius, and it is a Track 02 security project.
3. **TASK-7 record the 60-sec backup video** - insurance against a flaky live demo, and it forces us to rehearse the 90-second story tonight rather than Sunday morning.
