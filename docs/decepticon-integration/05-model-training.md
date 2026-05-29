# 05 - Model Training: Decepticon Data Augmentation

*Deep-analyst deliverable for the MODEL-TRAINING agent lane.*
*Date: 2026-05-29*

---

## Local Context

The existing fine-tune pipeline is real and partially running:

| Asset | File | State |
|---|---|---|
| SFT JSONL | `finetune/corpus/sft-records.jsonl` | 481 records (386 train / 72 val / 23 test per SATURDAY_QUICKSTART) |
| GHSA corpus | `finetune/corpus/scraped-cases.npm-enriched.jsonl` | 4,212 cases, 1,692 CWE-506 embedded-malicious-code |
| Attack catalog | `finetune/python/data/patterns/attack-catalog.yaml` | 26 patterns across 8 families (lifecycle_hijack, code_execution, filesystem, network, persistence, supply_chain_manipulation) with injection templates |
| Pipeline | `finetune/python/pipeline/` | 5-module Python pipeline: corpus_walker, dossier_builder, report_template, sft_pair_builder, version_pair_extractor |
| SFT schema | `modulewarden.sft_record.v1` | system + user(dossier JSON) + assistant(report JSON) 3-turn chat format |
| QLoRA trainer | `finetune/python/training/sft_lora.py` | trl.SFTTrainer + peft, supports bitsandbytes 4-bit, target: Qwen2.5-Coder-1.5B (running) / Qwen3.6-27B (aspirational) |
| Eval matrix | `finetune/python/eval/matrix_runner.py` | 4-arm matrix; arms 1+2 are one-shot HF generate; arms 3+4 are PI agentic harness |
| Metrics | `finetune/python/eval/metrics.py` | 7 metrics: malicious_catch_rate, false_quarantine_block_rate, json_validity, evidence_citation_accuracy, missed_suspicious, runtime, tool_calls |
| Smoke result | `finetune/python/eval/finetune-metrics.json` | 0.5B smoke: 8 train / 4 eval; both arms schema_valid=0 (expected for a 3-epoch smoke on 8 records) |

The REAL running training is `Qwen2.5-Coder-1.5B` (QLoRA 4-bit) on the 386-record train split. The eval will produce genuine base-vs-fine-tuned verdict-match numbers on the 72 held-out validation records. There is NO 27B model running now; `Qwen3.6-27B` is the aspirational Saturday vast.ai target.

The model's current task: given an `audit_dossier.v1` JSON, produce an `audit_report.v1` JSON with verdict in `{allow, quarantine, block}` + structured findings with evidence references.

---

## External Findings

Decepticon (`github.com/VoidChecksum/Decepticon`, Apache-2.0) generates:
- MITRE ATT&CK kill-chain narratives (tactical procedures in natural language)
- Engagement packages: RoE, ConOps, OPPLAN documents
- Neo4j attack-chain graphs: `(Technique)-[:LEADS_TO]->(Technique)` chains
- Agent swarm outputs: Recon, Exploitation, Post-Exploitation, Analyst agent reports

These are **text artifacts generated from static descriptors**. Decepticon takes a threat actor profile + target environment description and emits rich prose narratives. It does not need to execute live malware to do this.

The `decepticon-modulewarden-integration.md` architecture document (in the kimiclaw working tree) establishes the integration concept. The model-training dimension is the specific question of how Decepticon's text artifacts become training signal.

Relevant prior art on narrative-augmented training data:
- Chain-of-thought distillation: augmenting target labels with reasoning chains improves both accuracy and calibration (Wei et al. 2022, Magister et al. 2022)
- Reward-model training from explanations: grounded explanation fields in training examples improve generalization to held-out cases beyond verdict-only supervision
- MITRE ATT&CK has a controlled vocabulary of ~200 techniques; using it as a structured output field gives the model a learnable ontology rather than free text

---

## Analysis

### What the current model learns

Each SFT record teaches the model one mapping:

```
system: "You are ModuleWarden's package-version code auditor..."
user: <audit_dossier.v1 JSON>
assistant: <audit_report.v1 JSON>
```

The `audit_report.v1` currently contains:
- `verdict` (allow/quarantine/block)
- `primary_findings` (list of {finding_id, category, severity, evidence_refs, claim, why_it_matters})
- `benign_explanations_considered`
- `recommended_agent_checks`
- `developer_safe_summary`
- `security_admin_summary`
- `output_integrity`

The `primary_findings[].claim` field is a one-line string summarizing the finding. The `why_it_matters` field is a fixed template string per category (see `report_template.py::_why_for_category`). Neither field currently contains a MITRE technique ID, a kill-chain narrative, or an attacker procedure description.

### What Decepticon can add

Decepticon generates text from static attack descriptors - specifically from the same families already in `attack-catalog.yaml` (lifecycle_hijack, code_execution, filesystem, network, persistence, supply_chain_manipulation). Each pattern in the catalog already has:
- `family` and `id` (maps to a Decepticon threat-actor profile)
- `description` (the threat narrative)
- `real_world_examples` with dates and URLs
- `indicators` (observable signals)
- `injection_template_js` (the actual attack code, static text)

The gap is that the current SFT records' `finding.claim` and `finding.why_it_matters` fields are short boilerplate strings. They do not teach the model to reason about attacker intent, kill-chain phase, or MITRE technique.

### The augmentation: `kill_chain_narrative` field in `audit_report.v1`

The concrete integration is adding a `kill_chain_narrative` block to each SFT record's assistant turn. The training target becomes:

```json
{
  "schema_version": "modulewarden.audit_report.v1",
  "audit_id": "...",
  "verdict": "block",
  "confidence": "high",
  "risk_level": "critical",
  "primary_findings": [...],
  "kill_chain_narrative": {
    "tactic": "Credential Access",
    "technique_id": "T1552.001",
    "technique_name": "Credentials in Environment Variables",
    "procedure": "postinstall script reads process.env.AWS_ACCESS_KEY_ID and POSTs to attacker-controlled endpoint",
    "kill_chain_depth": 2,
    "engagement_summary": "Supply-chain opportunist compromises legitimate package maintainer account and inserts postinstall exfil script in patch release. Victim developer installs during CI build. AWS credentials sent to threat actor within 30 seconds of npm install.",
    "mitre_chain": ["T1195.001", "T1552.001", "T1041"]
  },
  ...
}
```

This trains the fine-tuned model to emit underwriter-grade kill-chain narratives alongside the verdict - directly addressing the UNIQA insurance track requirement for explainable risk reasoning.

### How Decepticon data generates the `kill_chain_narrative` field

Decepticon generates narratives from static descriptors without executing malware. The attack-catalog.yaml patterns already provide the raw material. The generation chain is:

1. Take an SFT record whose dossier has `capability_deltas` matching an attack-catalog pattern (e.g., `postinstall_env_exfil` has indicators matching `credential_or_env_access + network_access + lifecycle_script`)
2. Map the capability set to a Decepticon engagement profile (JSON descriptor specifying the threat actor, target type, attack family)
3. Run Decepticon's narrative generator against that descriptor - this is a text generation call over static data, no live execution
4. Parse the OPPLAN, kill-chain steps, and MITRE mapping out of Decepticon's output
5. Write the `kill_chain_narrative` block into the assistant turn of the SFT record

For the 36-hour build window, the Decepticon call can be replaced by a deterministic lookup table built from `attack-catalog.yaml` - the catalog already has `description`, `real_world_examples`, and enough structure to hand-write `kill_chain_narrative` blocks for all 26 patterns. This is ~6 hours of work and produces clean, consistent training targets that can later be regenerated with the real Decepticon SDK.

### Composition with existing synthetic-data pipeline

The attack-catalog `injector.py` generates synthetic training examples by injecting attack patterns into benign packages. Those synthetic records currently produce `audit_report.v1` objects via `report_template.py::build_report`. The augmentation adds a post-processing step that enriches the assistant turn with the `kill_chain_narrative` block derived from the injected pattern's metadata.

This means:
- GHSA records (481 real records): narrative augmentation comes from mapping `capability_deltas` to the attack catalog, then to Decepticon output or the static lookup table
- Synthetic records (attack-catalog injected): narrative augmentation is trivial because the pattern id is known exactly at generation time

### Honest training numbers

What is true right now:
- A real QLoRA training run is active on `Qwen2.5-Coder-1.5B` (1.5B params, NOT 27B)
- Training corpus: 386 records, validation: 72 records
- The 72 held-out records will produce real `verdict_match_pct` numbers comparing base model vs fine-tuned model on the same dossier inputs
- The smoke result (`finetune-metrics.json`) shows 0% schema validity on an 8-record, 0.5B smoke - this is expected and does not represent the real training run
- Expected honest outcome from the 1.5B run: schema validity will improve substantially (the model learns the JSON format), verdict match will improve on cases matching training distribution

What is NOT true and should not be claimed:
- There is no 27B model fine-tuned yet
- The 72-record eval is not statistically significant for rare attack families
- The attack-catalog synthetic examples are not yet in the training JSONL (the injector exists but corpus_walker produces incident_replay + cve_diff records primarily)

---

## Recommendations

### 1. Add `kill_chain_narrative` to `audit_report.v1` schema and `report_template.py` - Priority: HIGH

**Pros:**
- Teaches the fine-tuned model to emit MITRE-mapped explanations, not just verdicts
- Directly satisfies the underwriter/UNIQA track requirement for explainable kill-chain output
- Composes with the existing `_CAP_TO_CATEGORY` mapping in `report_template.py`
- Does not change the verdict logic; it is an additive output field
- Safe: generation is from static descriptors, no live execution

**Cons:**
- Adds ~200-400 tokens per record to the assistant turn, increasing sequence length and training cost
- The 1.5B model may not have capacity to reliably generate both structured JSON findings AND a coherent narrative
- 72 held-out records is thin for measuring narrative quality

**Implementation:** Add `kill_chain_narrative` as an optional field in the report schema. In `report_template.py`, add `_kill_chain_for_caps(capability_deltas, case_type)` that maps capability combinations to a `kill_chain_narrative` dict using the attack catalog as a static lookup. The function returns `None` when no matching catalog pattern exists (benign/cold-start records). The `sft_pair_builder.py` assistant turn includes the field when non-null.

---

### 2. Add a `source: "synthetic_decepticon"` track to the SFT JSONL pipeline - Priority: HIGH

**Pros:**
- Increases synthetic record count with pattern diversity beyond the 26 existing catalog entries
- Attack-catalog `injector.py` already generates diverse code variants; adding Decepticon narratives as targets is a 1-day addition on top of existing infrastructure
- The `_VALID_SOURCES` in `sft_pair_builder.py` already includes `"synthetic_teacher"` - a Decepticon track fits the same slot
- Doubles or triples training record count without additional GHSA scraping

**Cons:**
- Requires running Decepticon's generator or the static lookup table for each catalog pattern variant
- Narrative quality from a lookup table is lower than from Decepticon's real generator
- Adds complexity to the pipeline; risk of synthetic records dominating and reducing diversity

**Implementation:** Add `source: "synthetic_decepticon"` to `_VALID_SOURCES`. Add `finetune/python/pipeline/decepticon_augmentor.py` with a `build_narrative_record(dossier, report, pattern_id)` function that calls `_kill_chain_for_caps` and wraps via `build_sft_record`. Wire into `corpus_walker.py` as an optional second pass over attack-catalog-matched dossiers.

---

### 3. The honest "real trained model" pitch framing - Priority: HIGH

State exactly this, nothing more:

> "We are fine-tuning `Qwen2.5-Coder-1.5B` via QLoRA 4-bit on 386 real GHSA incident-replay and CVE-diff records (72 held-out for eval). The base model has no idea what a ModuleWarden audit_report is; the fine-tuned model learns the structured JSON verdict format and grounded evidence citation from real supply-chain incident data. We have a real eval number: verdict-match rate on 72 held-out cases, comparing base vs fine-tuned. We are not claiming a 27B model is running - that is the Saturday vast.ai goal. What is running now is small, real, and honest. The Decepticon integration augments training targets with MITRE kill-chain narratives derived from the same attack catalog that already drives our synthetic data pipeline."

Do not claim: a 27B model, production-grade recall numbers, or that the 1.5B model generalizes to novel attack families not in the training distribution.

---

### 4. Do NOT run live npm malware to generate training data - Priority: SAFETY GATE

**This is flagged as safety-gated.** The attack-catalog `injection_template_js` fields contain real exploit code (reverse shells, ssh key theft, cryptominer droppers). Generating training data by executing these templates against a live npm install - even in a sandbox - is out of scope for the data-generation pipeline. The `injector.py` injects these templates as static text into benign package tarballs for static analysis training; the tarballs are never installed.

If dynamic sandbox execution data is needed for training (e.g., strace logs, pcap captures as additional dossier evidence fields), that is a separate safety-reviewed process that must be gated behind the Decepticon sandbox infrastructure with honeytoken injection and network isolation. It is NOT a 36-hour build item.

---

## Implementation Notes

### Files to touch in order (36-hour window)

**Phase 1: Schema extension (2 hours)**
- `finetune/contracts/audit-report.schema.json`: add `kill_chain_narrative` as optional object with fields `tactic`, `technique_id`, `technique_name`, `procedure`, `kill_chain_depth`, `engagement_summary`, `mitre_chain`
- `finetune/python/pipeline/report_template.py`: add `_CAPABILITY_TO_MITRE` dict (26 entries from attack catalog) and `_kill_chain_for_caps` function; call it in `build_report` and include in the returned dict

**Phase 2: SFT pair builder update (1 hour)**
- `finetune/python/pipeline/sft_pair_builder.py`: extend `_VALID_SOURCES` to include `"synthetic_decepticon"`; no other changes needed - the `kill_chain_narrative` field arrives in the report dict and is serialized as part of the assistant turn JSON

**Phase 3: Augmentor module (3 hours)**
- `finetune/python/pipeline/decepticon_augmentor.py` (new file): `build_narrative_record(dossier, report, pattern_id)` - takes an existing dossier+report pair, looks up the pattern's narrative from a bundled lookup table (JSON), returns a new SFT record with enriched assistant content. Also `augment_jsonl(input_path, output_path, pattern_db_path)` to batch-process an existing sft-records.jsonl.

**Phase 4: Pattern narrative database (3 hours)**
- `finetune/python/data/patterns/narrative-db.json` (new file): 26 entries, one per attack-catalog pattern, each with `technique_id`, `technique_name`, `tactic`, `mitre_chain`, `engagement_summary_template`. Built by hand from the attack-catalog descriptions + MITRE ATT&CK data. This is the static Decepticon substitute for the 36-hour window.

**Phase 5: Wire and rerun (2 hours)**
- Re-run `corpus_walker` or the `augment_jsonl` pass on the existing 481 records to produce `sft-records-decepticon.jsonl`
- Point rehearsal at the enriched JSONL; verify loss curve
- Point eval matrix arm 2 at the enriched JSONL; compare verdict_match and json_validity vs non-enriched

### Eval metric to add

Add `narrative_present_rate` to `metrics.py::per_case_metrics`: fraction of cases where the model output includes a syntactically valid `kill_chain_narrative.technique_id` field. This is the pitch-demo number: "X% of block/quarantine verdicts include a MITRE-mapped kill-chain explanation."

### What to show the judges

1. `finetune-metrics.json` with real numbers from the 1.5B run (replace the 0.5B smoke file once the run completes)
2. Side-by-side: base model response to a dossier with `postinstall_env_exfil` indicators vs fine-tuned model response. Base: random/invalid JSON. Fine-tuned: correct verdict + `T1552.001` mapping + `engagement_summary`
3. The `narrative-db.json` as evidence that the kill-chain vocabulary is grounded in real threat intelligence, not generated by the model hallucinating MITRE IDs

### Safety posture

All narrative generation in the training pipeline is from static text descriptors:
- Attack catalog `injection_template_js` fields are text constants, never executed
- `narrative-db.json` entries are prose derived from public MITRE ATT&CK data
- The only execution in the pipeline is the QLoRA trainer on a GPU
- Sandbox execution (Decepticon behavioral pipeline) is a separate system and is NOT used for training data generation in the 36-hour scope
