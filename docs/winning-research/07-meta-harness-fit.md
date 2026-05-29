# 07 - Meta-Harness and BitGN-PAC Fit Assessment for ModuleWarden

*Analyst: deep-analyst agent. Date: 2026-05-29.*

---

## 1. Stanford Meta-Harness

### 1.1 What the Framework Expects

The Stanford meta-harness (arXiv:2603.28052, `stanford-iris-lab/meta-harness`) runs an AI proposer
(Claude Code) in a read-write filesystem loop. Each iteration the proposer:

1. Reads source code of the current harness candidate plus all prior execution traces and scores.
2. Diagnoses failure modes by grepping and catting files (up to 10M token filesystem context).
3. Proposes targeted edits to the harness.
4. Runs the candidate on a search (dev) task set, scores it.
5. Logs results and traces, then loops.

The framework needs four concrete artefacts from the new domain:

| Requirement | What it is |
|---|---|
| **Harness** | The code wrapping the fixed base model: system prompt, context construction, tool definitions, retrieval, completion logic. Must expose a stable interface so each candidate is a drop-in replacement. |
| **Task set (search)** | A finite benchmark of discrete tasks the harness runs during optimization. Never touches the held-out set. |
| **Task set (held-out)** | Separate from search; used only for final validation to prevent overfitting. |
| **Scorer** | An objective function returning a numeric score per task. The proposer reads raw traces AND score files to diagnose why a candidate failed. |

The reference example wraps `claude -p` via a thin Python `claude_wrapper.py` that logs `events.jsonl`,
`meta.json`, and per-tool-call artifacts to disk. The proposer reads these directly.

### 1.2 ModuleWarden Mapping

**What already exists:**

- **Harness (present, well-defined).** ModuleWarden's harness is:
  - `chat/prompts/system.md` - the underwriter assistant system prompt.
  - `finetune/python/serving/prompt_defense.py` - the versioned `PromptDefensePolicy`
    (spotlighting, instruction hierarchy, envelope markers), which is the inference-time
    prompt construction layer.
  - The `_system_prompt_for_arm()` call inside `matrix_runner.py` (the audit arm system prompt).
  - The deterministic 5-rule gate (structural rules over capability deltas and lifecycle scripts).
  - The dossier-to-report pipeline (`build_dossiers`, `corpus_walker`, SFT records JSONL).

  These are all filesystem-resident, version-controlled, editable text or Python. A proposer
  can grep, read, and modify them without a build step.

- **Task set (present, partly labeled).** `finetune/corpus/sft-records.jsonl` holds records
  with `"split": "train"`, `"split": "validation"`, and `"split": "test"` fields.
  Each record is one dossier-to-audit-report pair: a concrete, self-contained task.
  The test split is held-out already. The validation split serves as the search set.

- **Scorer (present, fully operational).** `local_finetune_eval.py` emits a metrics JSON to
  `finetune/python/eval/finetune-metrics.json` with:
  - `verdict_match_pct` - primary accuracy metric.
  - `block_recall_pct` - critical safety metric (must a block verdict be called block?).
  - `schema_valid_pct` - structural correctness.
  - `kill_chain_emitted_pct` - technique attribution completeness.

  `matrix_runner.py` extends this to four arms (base one-shot, fine-tuned one-shot,
  agentic base, agentic fine-tuned), writing timestamped `matrix-{ts}.json`.

  Both scripts are self-contained Python, runnable from CLI. A proposer can invoke them
  as subprocess calls, then read the output JSON for score values.

- **Traces (present for model runs, partial for agentic runs).** Each eval run writes
  per-case rows with `raw_output`, `elapsed_s`, `tool_calls` to the matrix JSON.
  The `demo/tests/test_injection_robustness.py` suite captures injection test results.
  The agentic arm (arm 3/4) writes workspace scratch dirs per case, though these are
  not yet structured as canonical trace logs.

**What is missing or incomplete:**

- **Harness interface contract.** There is no single file that defines what "one harness
  candidate" is. The system prompt, prompt policy, and audit gate thresholds are in
  separate files. The proposer needs a spec doc (`domain_spec.md` in meta-harness terms)
  that says: "the harness is these three files; changing any of them counts as a new
  candidate; the interface they implement is `build_audit_prompt(dossier) -> str` plus
  the gate rule weights."

- **Structured trace per case.** Meta-harness needs the proposer to read failure traces
  and diagnose WHY a specific case failed. `matrix_runner.py` writes `raw_output` per
  case, but there is no trace that says "case audit_xyz: model received this prompt,
  emitted this generation, gate rule 3 triggered, verdict was quarantine, gold was block."
  That causal trace is what lets the proposer write targeted prompt fixes.

- **The proposer loop itself.** The framework ships a Claude Code proposer that reads
  the filesystem and proposes file edits. ModuleWarden does not have this outer loop
  wired up. It needs to be added - either by following the meta-harness `ONBOARDING.md`
  conversation to generate a `domain_spec.md`, or by writing a thin shell script that:
  (a) runs the eval, (b) writes traces, (c) invokes Claude Code with the right
  filesystem layout and a prompt like "diagnose failures in traces/, propose edits to
  chat/prompts/system.md and prompt_defense.py, then run eval again."

### 1.3 Adoption Plan for a Hackathon

**Scope: optimize the audit system prompt and PromptDefensePolicy against verdict-match + block-recall.**

**Step 1 - Write `domain_spec.md` (1-2 hours).** Define:
- Harness = `chat/prompts/system.md` + `finetune/python/serving/prompt_defense.py` (the
  preamble and envelope markers). These two files are the editable surface.
- Search set = `validation` split of `sft-records.jsonl`, capped at 50 cases for speed.
- Held-out set = `test` split, locked.
- Scorer = `python -m finetune.python.training.local_finetune_eval --eval-split validation --eval-limit 50`
  reading `verdict_match_pct` and `block_recall_pct` from the output JSON.
- Primary objective = `0.6 * verdict_match_pct + 0.4 * block_recall_pct` (block-recall
  weighted higher because a missed block is a critical failure mode).

**Step 2 - Add per-case trace writing (2-3 hours).** Patch `_evaluate()` in
`local_finetune_eval.py` to write one JSON file per case to a `traces/` directory:
```json
{
  "audit_id": "...",
  "gold_verdict": "block",
  "model_verdict": "quarantine",
  "schema_valid": true,
  "raw_output": "...",
  "prompt_used": "..."
}
```
This is the filesystem the proposer diagnoses. Without it the proposer is flying blind.

**Step 3 - Wire the proposer loop (2-4 hours).** Write a shell script (`meta_harness_loop.sh`)
that:
1. Copies current harness files to `candidates/candidate-N/`.
2. Runs eval, writes traces to `traces/`.
3. Calls `claude -p` with the meta-harness system prompt pointing at `candidates/`,
   `traces/`, and `finetune/python/training/local_finetune_eval.py`.
4. Reads proposed edits, applies to the harness files.
5. Loops up to budget (e.g. 8 iterations).

**Step 4 - Final validation (1 hour).** Run the best candidate found on the `test` split
via `matrix_runner.py --arms 1,2 --max-cases 100` for the honest number.

**Effort estimate:** 6-10 hours for a hackathon integration. The scorer and task set are
essentially done. The gap is the trace format and the proposer wiring.

**Risk assessment:**
- Low risk: the eval substrate is real and already used in the project. No fabrication.
- Medium risk: the search set (validation split) is small. Proposer may overfit the preamble
  to that 50-case slice. Mitigate by checking held-out delta after each accepted candidate.
- Low-to-medium risk: the proposer model (Claude Code) has full write access to the harness
  files. Add a git commit between each iteration so rollback is one `git checkout` away.
- The meta-harness result claims (+4.7 on math, 48.6% text classification) come from
  compute-heavy optimization loops over large benchmarks. A hackathon run of 8 iterations
  on 50 cases will produce a real signal but not the headline numbers. Be honest about
  iteration count in any claims.

---

## 2. BitGN-PAC Agent

### 2.1 Honest Classification

BitGN-PAC is **not a meta-harness and not a self-improving system.** It explicitly states:
"No meta-harness or self-improving loops" and "Not a knowledge graph." It is a
deterministic, hardened agent for a fixed benchmark (Vienna BitGN PAC 2026). Do not
misframe it as a method for optimizing ModuleWarden.

The value is its **hardening ring** as a reference implementation, MIT-licensed, written in
TypeScript with Vercel AI SDK v6, from a 1st-place winner at a benchmark that shares
hackathon lineage with ModuleWarden (Vienna 2026).

### 2.2 B1-B5 + security.ts vs ModuleWarden's Defense Stack

| BitGN-PAC module | What it does | ModuleWarden status |
|---|---|---|
| **B1 path guard** (`paths.ts`) | Pre-dispatch: blocks `../`, `~/.ssh/`, `.env` path traversal. Returns recoverable error, not crash. | Partial. The Docker audit-runner sandbox isolates filesystem access at the container level. There is no pre-dispatch path guard inside the agentic loop itself. The audit runner PI harness (arm 3/4) runs tool calls inside a Docker workspace; path traversal is blocked by the container boundary, not by an explicit guard in the harness code. Adopting an explicit path guard at the harness layer (before Docker dispatch) would add defense-in-depth without requiring a container. |
| **B2 PII refusal** (`pii.ts`) | Rejects queries for home addresses, family relations, private contact data. | Not applicable to ModuleWarden's threat model. ModuleWarden audits npm packages, not personal queries. This module does not transfer. |
| **B3 grounding refs validation** (`refs.ts`) | Pre-submit: cross-checks every evidence reference in the output against paths actually visited. Hallucinated refs trigger a recoverable error; strict mode blocks. | Partial and different form. ModuleWarden's audit report schema requires evidence IDs to be drawn from the dossier's `evidence_index`. The system prompt says "Cite only evidence ids from the dossier's evidence_index." But there is no runtime cross-check that validates model-cited IDs against the actual index before the report is accepted. Implementing a post-generation `grounding_refs` validator - rejecting or flagging reports that cite non-existent evidence IDs - would close this gap. Effort: low (one function comparing model output's cited IDs against the dossier's `evidence_index` keys). |
| **B4 destructive-action + exploration-spiral brakes** (`hardening.ts`) | Caps write/delete/move operations at 10/task; caps loop iterations at 35. | Partial. The agentic audit runner has a per-case `timeout_s` (600s default in `matrix_runner.py`). There is no explicit write-operation counter or iteration cap inside the tool-call loop. For the PI harness (arms 3/4), adding a max-tool-calls guard analogous to B4 would prevent a malicious package from triggering a spiral via a crafted README that keeps the agent requesting more tools. Effort: low, one counter in the PI harness wrapper. |
| **B5 secret redaction** (`redaction.ts`) | Post-read: replaces AWS keys, GitHub tokens, Anthropic/OpenAI creds, JWT, PEM certs with `[REDACTED:KIND]` before re-entering LLM context. | Not present as a distinct layer. The audit runner reads tarball source files, READMEs, and changelogs - all of which may contain real secrets from the package repo. If the auditing LLM sees and then echoes a secret in its report, that secret would appear in the audit log. A B5-style post-read redactor - strip known secret patterns from file contents before feeding to the audit model - is directly adoptable. MIT license, patterns are public knowledge (AWS key regex etc). Effort: medium (one regex filter module, plug in before tool output enters the LLM context). This is the most concrete, highest-value BitGN-PAC adoption for ModuleWarden. |
| **security.ts injection scanner** | Post-read: 16+ injection patterns, base64 variants, sender-domain spoofing, appends warnings to context without blocking. | Partial overlap. ModuleWarden has: `ingestion_hardening.py` (normalize + datamark at ingestion), `prompt_defense.py` (spotlighting + instruction hierarchy at served path), `activation_steering.py` (residual-stream steering at HF path), `test_injection_robustness.py` (T1606 vectors). The BitGN-PAC scanner's post-read warning append (non-fatal gate, warnings injected into context) is a different pattern from ModuleWarden's pre-prompt normalization and envelope approach. For the agentic arms, a non-fatal post-read injection-pattern scan (base64 decode + injection check before tool output is returned to the model) would complement the existing pre-prompt defenses. Effort: low to medium; the T1606 pattern list in `test_injection_robustness.py` already exists and could be reused. |

### 2.3 Same-Hackathon-Scene Relevance

BitGN-PAC won the Vienna BitGN PAC 2026, described as a deterministic agent benchmark in
the same April 2026 Vienna hackathon scene as Zero-One Hack. The judges measured hardening
robustness explicitly - path guards, PII refusal, secret redaction all counted. ModuleWarden
is demoed in the same competitive context. Referencing BitGN-PAC's B1-B5 pattern (with MIT
attribution) in ModuleWarden's architecture notes signals awareness of the peer field and
gives judges a concrete reference for why each layer exists.

---

## 3. Leverage Ranking

| Resource | Fit | Effort | Leverage | Verdict |
|---|---|---|---|---|
| **Stanford Meta-Harness** | High fit: 3 of 4 required artefacts are already present (task set, scorer, harness files). Missing: per-case trace format and the proposer loop wiring. | 6-10 hours for a hackathon integration. | High: genuine automated optimization of the system prompt and defense policy against real eval metrics. Demonstrates the "self-improving audit harness" angle that judges reward. Honest result possible in 8 iterations. | **Adopt. Priority: HIGH.** |
| **BitGN-PAC hardening ring** | Medium fit: B5 (secret redaction) and B3 (grounding refs validation) transfer directly. B4 (spiral brakes) transfers with low effort. B1 (path guard) adds defense-in-depth at the harness layer. B2 (PII refusal) does not transfer. security.ts complements existing injection defenses for the agentic arms. | Low to medium effort per module: B3 and B5 are 1-2 hour additions. B4 is 1 hour. B1 is 1 hour. security.ts post-read scan 2-3 hours. | Medium: hardens the agentic audit arms against real threats (secret leakage, evidence hallucination, tool spirals). MIT license, citable in architecture notes. Weak leverage as a headline claim (it is a deterministic agent, not a learning system). | **Selectively adopt B3 + B5 + B4. Priority: MEDIUM. Do not adopt B2. Reference B1 + security.ts if time allows.** |

**Bottom line:** The meta-harness gives ModuleWarden an automated optimization loop it does
not currently have, grounded in real metrics and a real task set. The BitGN-PAC hardening
ring fills three concrete gaps in the agentic audit path. Both are MIT/open-licensed.
Neither requires fabricating a capability. The meta-harness is the higher-leverage choice
for a hackathon because it changes the narrative from "we built a good system" to "the
system improves itself against measured objectives."

---

## Sources

- Stanford Meta-Harness: https://yoonholee.com/meta-harness/ and arXiv:2603.28052
- stanford-iris-lab/meta-harness GitHub: https://github.com/stanford-iris-lab/meta-harness
- BitGN-PAC Agent (MIT): https://github.com/Kanevry/bitgn-pac-agent-public
- Microsoft Spotlighting (arXiv:2403.14720): defense used in ModuleWarden's ingestion_hardening.py
- Instruction Hierarchy (arXiv:2404.13208): defense used in prompt_defense.py
- Turner et al. Activation Steering (arXiv:2308.10248): used in steering/activation_steering.py
- MITRE ATLAS T1606 taxonomy: referenced in demo/tests/test_injection_robustness.py
