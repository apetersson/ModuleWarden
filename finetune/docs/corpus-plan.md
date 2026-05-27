# Corpus Plan

## Goal

Build a training and evaluation corpus for a one-shot ModuleWarden code-auditor model. The model receives an `AuditDossier` and emits an `AuditReport`; agentic PI runs can then use the one-shot report as an audit brief.

The corpus must teach the model to make conservative, evidence-grounded judgments over npm package-version changes. It should include malicious supply-chain incidents, benign adjacent releases, CVE-like vulnerability diffs, cold-start packages, and dogfood dependencies.

## Corpus Buckets

| Bucket | Purpose | Expected Labels |
| --- | --- | --- |
| `incident_replay` | Known malicious or compromised package-version incidents. | Mostly `block` or high-confidence `quarantine`. |
| `benign_neighbor` | Adjacent versions around incident or CVE packages that should not be blocked. | Mostly `allow`, sometimes `quarantine` if evidence is ambiguous. |
| `cve_diff` | Vulnerability-fixing and likely vulnerability-introducing package diffs. | Usually `quarantine`, sometimes `block` for confirmed exploitable behavior. |
| `dogfood_dependency` | ModuleWarden's own npm/pnpm dependency graph. | Conservative cold-start `allow` or `quarantine`. |
| `synthetic_teacher` | Teacher-labeled examples generated from real patterns. | Used for scale after manual review. |
| `manual_golden` | Small, hand-reviewed examples used to anchor behavior. | Highest-trust labels. |

## Initial Target Sizes

For the hackathon:

- 20-40 manual golden cases.
- 50-150 scraped candidate advisory cases.
- 100-300 benign neighbor versions.
- 50-200 dogfood dependency cold-start cases.
- 500-2,000 synthetic teacher cases only after the manual rubric is stable.

For post-hackathon:

- Increase incident replay and benign-neighbor coverage before increasing synthetic volume.
- Keep a package-name holdout set for test data.

## Split Strategy

Split by package name, not by individual version pair.

Recommended split:

- `train`: 70%
- `validation`: 15%
- `test`: 15%

Hold out entire packages when possible. This prevents the model from memorizing package-specific quirks and makes evaluation closer to future unseen package updates.

## Case Selection Priority

Prioritize cases with:

- exact package and version information;
- a known fixed version or malicious version;
- a linked repository or source location;
- clear affected version range;
- public references that describe behavior;
- adjacent benign versions available from npm packuments.

Deprioritize cases with:

- no npm package mapping;
- no version boundary;
- withdrawn advisories without usable context;
- advisories that are purely application configuration issues;
- issues whose vulnerable behavior cannot be represented as package-code evidence.

## Scraped Candidate Flow

1. Scrape candidate advisories from GitHub global security advisories and OSV.
2. Normalize candidates into `finetune/corpus/scraped-cases.jsonl`.
3. Enrich candidates with npm packument version metadata.
4. Generate candidate version pairs:
   - vulnerable/latest-affected to first patched;
   - predecessor to suspicious/malicious version when known;
   - benign neighbors before and after the target version.
5. Manually promote selected candidates into `golden-cases.json`.
6. Generate `AuditDossier` files only for promoted cases.

## Quality Gates

A case is training-ready only when:

- the expected verdict follows the labeling rubric;
- all claims in the expected report cite evidence IDs;
- the case source is recorded;
- the train/validation/test split is assigned;
- package-name leakage across splits has been checked.
