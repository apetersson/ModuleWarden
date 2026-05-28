Here’s the high-level path from where we are now.

**1. Freeze Candidate Data**
We already have:
- [scrape-cases.mjs](/Users/andreas/code/ModuleWarden/main-ModuleWarden/finetune/scripts/scrape-cases.mjs)
- [select-golden-cases.mjs](/Users/andreas/code/ModuleWarden/main-ModuleWarden/finetune/scripts/select-golden-cases.mjs)
- [golden-cases.json](/Users/andreas/code/ModuleWarden/main-ModuleWarden/finetune/corpus/golden-cases.json)

Remaining work: keep the Drive JSONL as raw/silver data, and treat `golden-cases.json` as the reviewed manifest.

**2. Build Audit Dossiers**
Next tool to create:

`finetune/scripts/build-dossiers.mjs`

It should read `golden-cases.json`, fetch npm tarballs, unpack baseline/candidate versions, compute diffs, extract metadata, and emit `AuditDossier` JSON files matching [audit-dossier.schema.json](/Users/andreas/code/ModuleWarden/main-ModuleWarden/finetune/contracts/audit-dossier.schema.json).

Useful external tools:
- npm registry metadata: https://docs.npmjs.com/cli/v8/using-npm/registry/
- Docker isolated runner: https://docs.docker.com/reference/cli/docker/container/run
- Ajv for schema validation: https://ajv.js.org/

**3. Generate Evidence**
For each package diff, the dossier builder should produce deterministic evidence:

- `package.json` changes
- lifecycle scripts added/removed
- dependency changes
- sensitive API usage
- process/network/fs/env access
- obfuscation or dynamic execution
- install/import dynamic traces where safe

Useful audit tools:
- Semgrep for static rules: https://semgrep.dev/docs/cli-reference
- OSV-Scanner for known vuln context: https://google.github.io/osv-scanner/usage/
- TruffleHog for secret-like material: https://docs.trufflesecurity.com/
- Syft/Grype for SBOM/vuln scanning: https://oss.anchore.com/docs/installation/grype/

**4. Label Audit Reports**
Next tool to create:

`finetune/scripts/validate-audit-report.mjs`

Each dossier needs a matching `AuditReport` under the contract in [audit-report.schema.json](/Users/andreas/code/ModuleWarden/main-ModuleWarden/finetune/contracts/audit-report.schema.json).

Important: the selected CVE fix cases currently have provisional `allow` labels. We only keep those labels if the generated diff confirms “this is a normal fix release with no new suspicious supply-chain behavior.”

**5. Convert To SFT Records**
Next tool to create:

`finetune/scripts/build-sft-records.mjs`

It should pair each dossier + report into the structure in [sft-record.schema.json](/Users/andreas/code/ModuleWarden/main-ModuleWarden/finetune/contracts/sft-record.schema.json), then emit:

- `train.jsonl`
- `validation.jsonl`
- `test.jsonl`

Use Hugging Face Datasets for loading/splitting if needed: https://huggingface.co/docs/datasets

**6. Baseline Evaluation**
Before fine-tuning, run the base model on the held-out set.

Target model:
- Qwen3.6-27B: https://huggingface.co/Qwen/Qwen3.6-27B

Track:
- JSON validity
- verdict accuracy
- evidence citation accuracy
- false blocks/quarantines
- missed suspicious deltas
- report usefulness for PI

**7. Fine-Tune**
Fastest path: LoRA/QLoRA first, not full fine-tune.

Recommended training stack:
- Axolotl for the hackathon-speed path: https://docs.axolotl.ai/
- Hugging Face TRL `SFTTrainer` as the lower-level fallback: https://huggingface.co/docs/trl/v0.21.0/en/sft_trainer
- PEFT/LoRA: https://huggingface.co/docs/peft/v0.6.0/index
- Transformers Qwen3 support: https://huggingface.co/docs/transformers/model_doc/qwen3

**8. Serve And Compare**
Serve base and fine-tuned model, then compare four paths:

1. Base one-shot auditor
2. Fine-tuned one-shot auditor
3. Base model in PI agentic run
4. Fine-tuned model seeding PI agentic run

Serving tool:
- vLLM Qwen guide: https://docs.vllm.ai/projects/recipes/en/latest/Qwen/Qwen3.html

**9. Report Results**
Final artifact should be a small eval report:

- which cases improved
- where the fine-tune overfit
- whether PI corrected one-shot mistakes
- whether the model learned the schema
- false positive risk
- best next data expansion path

The shortest next implementation step is: build `build-dossiers.mjs`. Once dossiers exist, everything else becomes measurable instead of theoretical.