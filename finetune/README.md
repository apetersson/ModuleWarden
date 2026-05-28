# ModuleWarden Fine-Tune Artifacts

This directory defines the training contract for the ModuleWarden code-auditor model.

The first fine-tune target is intentionally narrow:

> Given a prepared npm package-version audit dossier, produce a structured audit report with an allow, quarantine, or block verdict and evidence-grounded findings.

The trained model is not expected to inspect raw tarballs by itself. ModuleWarden prepares deterministic evidence first, then the model judges that evidence. Agentic PI runs can use the one-shot report as a starting brief and may confirm, refine, or overturn it after running tools inside the isolated audit container.

## Contents

- `contracts/audit-dossier.schema.json`: JSON Schema for model input.
- `contracts/audit-report.schema.json`: JSON Schema for model output.
- `contracts/sft-record.schema.json`: JSON Schema for one supervised fine-tuning record.
- `templates/audit-dossier.template.json`: Fill-in template for generating dossiers.
- `templates/audit-report.template.json`: Fill-in template for expected reports.
- `examples/version-diff/`: A suspicious version-diff example.
- `examples/cold-start/`: A conservative cold-start example.
- `docs/audit-contract.md`: Human-readable data contract and modeling notes.
- `docs/finding-taxonomy.md`: Controlled vocabulary for findings and capabilities.
- `docs/corpus-plan.md`: Case buckets, split strategy, and quality gates.
- `docs/labeling-rubric.md`: Human labeling rules for allow, quarantine, and block.
- `docs/case-sourcing.md`: Scraping and enrichment method for candidate cases.
- `corpus/golden-cases.json`: Hand-promoted starter golden case manifest.
- `corpus/scrape-config.json`: Scraper configuration.
- `scripts/scrape-cases.mjs`: Dependency-free GitHub advisory, npm, and OSV candidate scraper.

## Training Shape

Each SFT example should pair one `AuditDossier` with one `AuditReport`.

The model should learn to:

- cite existing evidence IDs only;
- distinguish package-purpose mismatch from generic suspiciousness;
- quarantine on uncertainty;
- avoid claiming that an allow means permanent safety;
- recommend agentic follow-up checks when one-shot evidence is insufficient;
- emit developer-safe and security-admin summaries separately.

## Evaluation Shape

Compare at least four paths on the same cases:

1. base Qwen3.6-27B one-shot with prompt;
2. fine-tuned Qwen3.6-27B one-shot;
3. base Qwen3.6-27B PI agentic run;
4. fine-tuned Qwen3.6-27B PI agentic run seeded with the one-shot audit report.

Track malicious catch rate, benign false quarantine/block rate, JSON validity, evidence citation accuracy, missed suspicious deltas, runtime, and tool-call count.

## Scraping Candidate Cases

Generate normalized candidate cases with:

```bash
pnpm finetune:scrape
```

Fast candidate-only run, without npm or OSV enrichment:

```bash
node finetune/scripts/scrape-cases.mjs --github-only --max-pages 10
```

Enriched run with progress, request timeouts, and concurrent npm/OSV lookups:

```bash
node finetune/scripts/scrape-cases.mjs --max-pages 10 --concurrency 16 --timeout-ms 30000
```

Useful small dry run:

```bash
node finetune/scripts/scrape-cases.mjs --dry-run --limit 10 --max-pages 1
```

The scraper writes JSONL records to `finetune/corpus/scraped-cases.jsonl` by default. Treat those records as candidates only; promote reviewed cases into `golden-cases.json` before generating training dossiers.
