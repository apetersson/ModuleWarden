# Forecast Track Fit Analysis: Decepticon x ModuleWarden
## Zero-One Hack Vienna 2026 - Sybilion FORECAST track "probabilistic forecasting and the agent layer that acts on it"

**Document scope:** How Decepticon integration maximises Forecast-track fit.
**What this is not:** A build plan (see TRACK02-DESIGN.md) or architecture spec (see decepticon-modulewarden-integration.md).

**Product one-liner:** ModuleWarden uses the Sybilion forecast to rank a team's dependencies by forecasted growth and blast-radius trajectory, so a security team reviews the ones climbing toward critical first, while they are still small enough to vet. The forecast does not detect danger and does not output an attack-vector probability; the deterministic 5-rule DELTA-gate is the detector, and an agent acts on the verdict at submission time. The threat model is internal: the lazy submitter who pulls a typo-squat without checking, and the disgruntled submitter who pulls a poisoned bump on purpose.

**Primary fit (Sybilion / FORECAST):** the forecast ranks the team's dependencies by trajectory so the review queue starts with the rising-critical ones; the deterministic 5-rule DELTA-gate is the verdict authority and the detector; the model narrates the gate's evidence. Two honest findings anchor this. First, a static classifier on the COLD package floors at AUROC 0.54 on this corpus (GHSA pairs, benign = first-patched release); the signal is in the DELTA the gate diffs, not the cold package, which is exactly why gate-detects-and-model-narrates is the right architecture, not a hedge. Second, we backtested whether the forecast can detect a dying or dangerous package directly: it cannot, the band and slope do not separate the declining set, and we concede that with the data.

**Secondary reframe (downstream application):** the conversational underwriter + Control Evidence Memo is the agent layer that acts on the forecast. It is a downstream consumer of the forecast, not the primary track entry. UNIQA-style underwriting language is retained as one way the agent acts; it is no longer the headline.

---

## Local Context

### What exists today in chat/

The underwriter assistant (`chat/agent.py`, `chat/app.py`, `chat/model_client.py`) is a
working, model-backed conversational interface. Key facts grounded in the code:

- **Two-path architecture.** A deterministic router always runs first; the LLM
  narrates the pinned verdict, never overrides it. The verdict comes from
  `audit_report.v1` (`allow` / `quarantine` / `block`). This is real, tested code.

- **Control Evidence Memo is fully rendered today.** `_render_underwriting_memo()`
  produces risk tier, premium/exclusion line, and cited evidence from the dossier +
  report pair. No model needed for this output.

- **Model integration hook is live.** `chat/model_client.py` resolves an
  OpenAI-compatible endpoint from env vars (`MW_MODEL_ENDPOINT_*` or `OPENAI_API_KEY`).
  When configured, `narrate_underwriting()` calls the endpoint with the pinned verdict
  JSON and the system prompt from `chat/prompts/system.md`. The UI badge shows
  `model-backed` vs `deterministic` mode.

- **System prompt is underwriting-native.** `chat/prompts/system.md` frames the
  model as a UNIQA cyber-policy underwriter, instructs it to translate technical
  findings into loss-path / premium-loading / control-credit language, and hard-bans
  it from changing the pinned verdict.

- **Three live incident dossiers.** `postmark-mcp@1.0.16` (block, critical), 
  `postmark-mcp@1.0.12` (likely allow/quarantine), `lodash@4.17.21`. The
  `postmark-mcp@1.0.16` dossier is the demo anchor: install-time exfil, credential
  harvesting, BCC injection - a complete compromised-maintainer scenario.

- **Fine-tune pipeline exists.** `finetune/python/` contains SFT pair builder,
  CodeBERT LoRA training, and a 26-pattern attack catalog via
  `finetune/python/data/patterns/injector.py`. Training is small QLoRA, not done yet.
  This is the "real trained model" the track requires.

### What Decepticon brings (verified from GitHub)

- Autonomous red-team platform, pip SDK (`pip install decepticon`).
- 16 kill-chain specialist agents: Orchestration, Recon, Exploitation,
  Post-Exploitation, Vulnerability Research, plus domain specialists (AD, Cloud,
  Smart Contracts, Analyst, etc.).
- Engagement discipline: generates RoE, ConOps, OPPLAN, MITRE ATT&CK mapping
  before executing anything.
- Two-network Docker isolation (`decepticon-net` management / `sandbox-net` ops).
- Persistent tmux sessions with interactive tool support (msfconsole, evil-winrm).
- Neo4j knowledge graph (dual-homed) for attack chain persistence.
- Tier-based LLM routing (eco / max / test profiles) across Anthropic, OpenAI,
  Google, DeepSeek, local Ollama.
- No native risk-quantification or insurance features. That gap is ours to fill.

### Existing integration references (already designed)

`finetune/python/data/patterns/injector.py` uses the 26-pattern attack catalog -
this is the synthetic training data that links Decepticon's offense to the LoRA
training. The `TRACK02-DESIGN.md` and `decepticon-modulewarden-integration.md`
files in the kimiclaw tree define three conversation flows and the full sandbox
architecture. This analysis grounds those designs against the actual chat/ codebase.

---

## External Findings

### Sybilion FORECAST bar: "probabilistic forecasting and the agent layer that acts on it"

The judging signal is two-part:
1. **Probabilistic forecast**: a real forecast that returns quantile bands over a
   future demand trajectory, not a binary stamp. Here, the Sybilion forecast over a
   dependency's monthly adoption demand, ranked so the rising-critical dependencies
   sort to the top of the review queue. The forecast must be honest about its own
   limits, and ours is: it separates rising from fading packages, but it does not
   detect a dying or dangerous package directly, and we show the backtest that says so.
2. **An agent that acts on the forecast**: the forecast has to drive a decision at
   submission time, not just sit on a dashboard. The forecast sets the review order;
   the gate detects the known-bad; ModuleWarden's agent blocks the install, writes the
   memo, and narrates the verdict.

The forecast suite exists in code: `eval/forecast_calibration.py` (band and backtest
checks on this corpus), `serving/dependency_forecast.py` (the trajectory ranker), and
`serving/acting_agent.py` (the agent that acts on the gate verdict at submission time).

The honest cold-package floor is load-bearing on the detection side, not a weakness to
bury. A static classifier on the COLD package scores AUROC 0.54 on this corpus. That is
near-random. It is the empirical reason the gate detects on the DELTA between a version
and its predecessor, and the reason the deterministic gate, not the model, holds verdict
authority.

### Secondary: UNIQA underwriting as a downstream application

The conversational underwriter is no longer the primary track entry. It is one way
the agent layer acts on the forecast: it translates a forecasted DELTA risk into
loss-path and premium-loading language a cyber-policy underwriter recognizes. The
substance stays; the framing demotes it from headline to application.

### Why multi-agent framing satisfies "model integration" honestly

Decepticon's 16 specialist agents each carry a distinct system prompt, tool set,
and model tier. Running them as an orchestrated swarm is model integration in the
architectural sense: the product routes a single underwriter query through multiple
specialist model roles (Recon then Exploitation then Analyst), each contributing a
structured output that the next stage consumes. This is a real architecture claim,
not a marketing one, and it is demonstrated by the Decepticon SDK.

The QLoRA fine-tune on the 26-pattern attack catalog is the narrator that explains
the forecast. It does not hold verdict authority. The honest fine-tune numbers
(verdict-match 0 to 46.7 percent on validation, 73.9 percent on test, block-recall
0 percent on the 0.5B) are stated as-is. The gate catches the severe cases; the
model narrates them.

### Insurance framing for kill-chain narratives

MITRE ATT&CK kill-chain outputs translate cleanly into underwriting language via
three mappings that already exist in agent.py:

| ATT&CK Finding | Underwriting Translation | Code anchor |
|---|---|---|
| T1195.001 (Supply Chain Compromise) | Active loss path on the insured's dependency surface | `_underwriting_implication()` for `block` verdict |
| T1552.001 (Credentials in Env Vars) | Credential exfil = data breach exposure, BI loading | `primary_findings` in report.v1 |
| T1041 (Exfil over C2) | Triggers ransomware / data breach policy conditions | `_premium_exclusion_line()` reasoning |

The `postmark-mcp@1.0.16` dossier already covers all three. The kill-chain
narrative from Decepticon's Analyst agent slots directly into the `prose` return
value of `narrate_underwriting()` - the LLM path that leads the response ahead
of the deterministic memo.

---

## Analysis

### The single best conversational flow for the Forecast track

**The "kill-chain underwriting query" flow.**

> Underwriter types: "What is my exposure if my client installs postmark-mcp@1.0.16?"

Step-by-step against the existing code:

1. `handle_query()` in `agent.py` detects intent = `lookup`, incident_id = `postmark-mcp-1.0.16`.
2. `lookup_by_incident_id()` loads the existing dossier + report pair (real files, live today).
3. `narrate_underwriting()` sends the pinned verdict JSON to the model endpoint.
4. **NEW (Decepticon layer):** Before or alongside step 3, the system calls the
   Decepticon Analyst agent with the dossier's `capability_deltas` and
   `dynamic_observations` as context. The Analyst returns a structured kill-chain
   narrative: T1195.001 -> T1552.001 -> T1041, with procedure descriptions.
5. The kill-chain narrative is injected into the `user_msg` in `narrate_underwriting()`
   alongside the pinned verdict, so the fine-tuned model narrates BOTH the verdict
   AND the kill-chain in underwriter voice.
6. The response leads with the Decepticon-generated kill-chain narrative, followed
   by the deterministic Control Evidence Memo (always present, verdict pinned).

**What the underwriter sees:**

> "DECLINE. This package executes a three-stage supply-chain attack on install:
> Reconnaissance (reads environment credentials: POSTMARK_API_TOKEN, AWS keys),
> Initial Access (T1195.001: installs postinstall lifecycle hook), Exfiltration
> (T1041: POSTs credentials to api.attacker.tld). Loss path: credential breach +
> BCC-routing of all client emails to attacker. Recommended exclusion: all losses
> from postmark-mcp until the insured pins @1.0.15. Control credit withheld."
>
> [Control Evidence Memo with pinned verdict, findings, evidence refs below]

This flow is buildable now. The dossier data for the kill-chain narrative is
already in the `capability_deltas` and `dynamic_observations` fields of the
`postmark-mcp@1.0.16.dossier.json`. The Decepticon Analyst agent (or a lightweight
shim using the same structured prompt) maps those fields to MITRE techniques and
returns a kill-chain string that replaces the generic LLM narration.

### How this satisfies "probabilistic forecast + an agent that acts" honestly

**Probabilistic forecast (honest claim):**
- The trajectory ranker (`serving/dependency_forecast.py`) consumes the Sybilion
  forecast over a dependency's monthly demand and orders the team's dependencies by
  forecasted growth and blast-radius trajectory; the band width and backtest are
  checked via `eval/forecast_calibration.py`.
- The forecast does not output an attack-vector probability and does not detect
  danger. We tested that directly and the band and slope do not separate the declining
  set, so we concede it and show the backtest (MAPE 10.6 percent, the bands are real).
- The cold-package floor (AUROC 0.54) is reported up front on the detection side. The
  gate detects on the DELTA, where the signal actually is, not on the cold package.

**An agent that acts on the forecast (honest claim):**
- `serving/acting_agent.py` is the agent that acts at submission time on the gate
  verdict: it blocks the install, writes the Control Evidence Memo, and hands the
  pinned verdict to the narrator.
- The deterministic 5-rule gate is the verdict authority and the detector. The forecast
  sets the review order; the agent enforces the verdict. The model never overrides it.

**Conversational AI as the downstream application (honest claim):**
- The Streamlit chat UI exists. The agent routing and Control Evidence Memo are
  working. The system responds to natural-language queries about insurance risk.
- The `_detect_intent()` router currently handles `lookup`, `gate`, `list`, `explain`,
  `help`, `freeform`. Adding a `kill_chain_query` intent for queries like "what
  attack would this enable?" or "what is the exposure if my client installs X?" is
  a small extension, not a rewrite.

**Model integration (honest claim):**
- The fine-tuned QLoRA model (in progress) narrates the pinned verdict via
  `narrate_underwriting()`. This is a domain-adapted model, not vanilla GPT-4.
- Decepticon's Analyst agent is a specialist model role with a structured system
  prompt for MITRE mapping. Even run via a local Ollama or the Decepticon SDK, it
  is a second model in the pipeline doing a distinct task (kill-chain synthesis vs.
  underwriter narration).
- The 26-pattern attack catalog in `finetune/python/data/patterns/injector.py`
  is the training data provenance. Showing that this data shaped the model connects
  Decepticon's offense to the model training pipeline.
- Together: a two-model pipeline (Analyst for kill-chain synthesis, fine-tuned
  underwriter LLM for narration) orchestrated by a deterministic gate. This is
  genuine model integration.

**What cannot be claimed honestly:**
- No live Decepticon sandbox execution on real npm packages during the demo.
  Sandbox execution is safety-gated (see Safety Flags below).
- No headline accuracy that was not measured on THIS corpus. No AUROC 0.90, no
  borrowed F1, no calibrated/conformal 98 percent. The measured cold-package floor
  is AUROC 0.54; the fine-tune numbers are verdict-match 0 to 46.7/73.9 percent and
  block-recall 0 percent. Those are the only numbers we cite.
- The fine-tune is a small QLoRA narrator, not a "27B reasoning engine." State it as
  "domain-adapted narrator model."
- Decepticon's 16 agents are not all running per query. At most 1-2 agents
  (Analyst + optionally Recon for pcap parsing) are in the demo path. The
  "16-agent swarm" is a narrated future capability.

### Gap: the `freeform` intent path

Currently `handle_query()` falls through to `_render_freeform()` for any query
it does not recognise. This is the gap for the kill-chain query flow. Adding
one intent pattern - detecting "exposure", "attack", "kill chain", "what would
happen" in the message - and routing it to a Decepticon-enriched lookup is the
build-now task.

### Insurance-specific value: where kill-chain connects to policy terms

The existing `_underwriting_tier()` and `_premium_exclusion_line()` functions
already produce the policy language. Kill-chain depth adds one new dimension:

- **Kill-chain depth 1** (single technique, e.g. just a lifecycle script): maps
  to QUARANTINE + partial credit.
- **Kill-chain depth 2** (lifecycle + credential access): maps to BLOCK +
  premium loading for data breach coverage.
- **Kill-chain depth 3+** (lifecycle + credential access + C2 exfil + persistence):
  maps to DECLINE + policy exclusion until remediation.

This mapping can be added to `_underwriting_tier()` as a third parameter
(`kill_chain_depth: int`) without changing the contract of the existing code.
The verdict remains pinned; the tier recommendation becomes more precise.

---

## Recommendations

1. **Extend `narrate_underwriting()` with a Decepticon Analyst call** - Priority: HIGH
   - Pros: slots into the existing two-path architecture; verdict remains pinned;
     kill-chain narrative appears in the response without any UI changes; satisfies
     "model integration" on the Analyst agent path.
   - Cons: adds a second network hop (to Decepticon LangGraph or a local shim);
     if the Analyst agent errors, must fall back gracefully to the existing
     deterministic memo (same pattern as the existing model endpoint error path).

2. **Add `kill_chain_query` intent to `_detect_intent()`** - Priority: HIGH
   - Add patterns: "exposure", "attack", "what would happen", "kill chain",
     "risk if client installs", "simulate" to route to a Decepticon-enriched
     lookup rather than `freeform`.
   - Pros: closes the gap where insurance-relevant questions fall through; small
     addition to existing regex-based intent grammar.
   - Cons: regex intent detection has known false-positive risk; test against
     `chat/tests/test_agent.py` patterns.

3. **Add `kill_chain_depth` to `_underwriting_tier()`** - Priority: MEDIUM
   - Map depth 1/2/3+ to quarantine/block/decline tiers for queries enriched by
     the Analyst agent.
   - Pros: ties the kill-chain narrative directly to underwriting output; makes
     the demo show how deeper attack chains affect policy terms.
   - Cons: requires a new field in the evidence dict; backward-compatible if
     defaulted to None (existing paths unaffected).

4. **Use `postmark-mcp@1.0.16` as the anchor demo package** - Priority: HIGH
   - The existing dossier has `capability_deltas` that map directly to
     T1195.001, T1552.001, T1041. The kill-chain narrative can be generated
     from these fields without a live sandbox run. This is the demo path.
   - Pros: zero safety risk; fully deterministic; existing fixture is rich enough
     to produce a compelling 3-phase kill-chain narrative.
   - Cons: none for demo purposes.

5. **Show training evidence at demo time** - Priority: HIGH
   - The "real trained model" bar is the hardest judging criterion. Pull the
     QLoRA training loss curve from `finetune/python/training/sft_lora.py` output
     and show it in the Streamlit sidebar alongside the model badge.
   - Pros: directly answers the judges' unstated question "did you actually train
     something?"; the 26-pattern attack catalog provenance links Decepticon's
     offense to the training data.
   - Cons: requires a completed training run before the demo.

---

## Implementation Notes

### Build-now (extend the existing chat assistant, no new UI)

All of these touch `chat/agent.py` and `chat/model_client.py` only:

```
1. Add DECEPTICON_API env var resolution to model_client.py (same pattern as
   MW_MODEL_ENDPOINT_* resolution).

2. Add decepticon_analyst_narrate(dossier, report) function that:
   a. Extracts capability_deltas from the dossier.
   b. Sends them to the Decepticon Analyst agent (or a local shim using
      openai.ChatCompletion with the analyst system prompt).
   c. Returns a structured kill-chain object:
      {"phases": [{"technique_id": "T1195.001", "procedure": "...", "loss_path": "..."}],
       "depth": 3, "underwriting_summary": "..."}

3. In narrate_underwriting(), call decepticon_analyst_narrate() and inject the
   kill_chain result into user_msg before the LLM call. The fine-tuned model
   then narrates BOTH the verdict AND the kill-chain in underwriter voice.

4. In _underwriting_tier(), add optional kill_chain_depth parameter.
   Default=None preserves existing behaviour.

5. In _detect_intent(), add kill_chain_query intent pattern.
```

### Narrate (credible future, honest framing in the pitch)

These are real extensions that can be described accurately as the next phase:

- Live sandbox execution on new packages (safety-gated, requires RoE confirmation).
- Full 16-agent swarm per query (currently 1-2 in the demo path).
- Federated kill-chain graph across UNIQA's CI fleet via Neo4j.
- Automated premium loading via quantified p(loss) from sandbox simulation.
- Vaccine loop: adversarial self-red-teaming of the gate thresholds.

### Safety flags

- **Do not execute live npm packages from the demo machine.** The sandbox adapter
  and honeytoken injection described in `decepticon-modulewarden-integration.md`
  are correct for a production setup but are safety-gated for the hackathon demo.
  The demo uses static dossier fixtures only.
- **Do not claim the Analyst agent "ran" if only a shim was used.** If using a
  local Ollama or direct OpenAI call to simulate the Analyst agent, label it
  as "Analyst role (local shim)" in the evidence panel, not "Decepticon Analyst."
  The architecture is honest; the implementation degree must be too.
- **Do not claim p(loss) figures are actuarially grounded.** Any premium-loading or
  p(loss) outcome in the planning docs is illustrative, not measured on this corpus.
  Frame as "estimated from simulation" not "actuarially validated," and do not put a
  specific number on a slide unless it came from `eval/forecast_calibration.py`.

---

*Agent: TRACK-FIT | Source files: chat/agent.py, chat/app.py, chat/model_client.py,
chat/prompts/system.md, demo/incidents/postmark-mcp-1.0.16.{dossier,report}.json,
finetune/python/data/patterns/injector.py, decepticon-modulewarden-integration.md,
TRACK02-DESIGN.md | External: github.com/VoidChecksum/Decepticon*
