# Finetune Data Plan

End-to-end plan for the ModuleWarden Saturday fine-tune corpus and the
ongoing data-collection pipeline.

## Why Nextcloud and not git

The scraper, the injector, and the sample-bad-deps test project all
deal with **public-but-sensitive material**: real malicious npm tarballs,
attack-pattern code variants, capability-trace snapshots. Committing any
of that to a public GitHub repo creates two problems:

1. GitHub's malware policy treats deliberate hosting of credential-exfil
   payloads as a violation, even for research. We do not want the MW
   repository flagged.
2. The team grows training data continuously. Git is the wrong storage
   for a multi-gigabyte corpus that mutates every Saturday.

The AI:AT Factory Nextcloud at `https://nextcloud.capacity.at/` provides
both isolation and the right shape for shared corpus storage. The folder
`/ZeroToOne_Data/finetune-data/` is the canonical location.

Andreas owns the credentials. Both members of the team have read+write.

## Current Nextcloud state (verified 2026-05-28)

```
/ZeroToOne_Data/finetune-data/
  scraped-cases.jsonl                 3.54 MB   2026-05-28 06:22 UTC
  scraped-cases.npm-enriched.jsonl    5.75 MB   2026-05-28 06:28 UTC
```

The enriched file is the better input for Saturday. It carries npm
packument data (maintainer email, time_created, time_modified) that the
walker uses to seed source-match.

## Required environment

Add to `.env` at the repo root (never commit the actual values):

```
GITHUB_TOKEN=ghp_xxx                            # for the scraper
NEXTCLOUD_URL=https://nextcloud.capacity.at
NEXTCLOUD_USER=ademczuk
NEXTCLOUD_PASS=<set me>
NEXTCLOUD_FINETUNE_PATH=/ZeroToOne_Data/finetune-data
```

`.env` is already in `.gitignore`. `.env.example` carries the template
with placeholders.

## GitHub PAT requirements

Per the audit, the scraper hits `GET https://api.github.com/advisories`
which is fully public. The PAT is needed only to raise the rate limit
from 60/hr to 5000/hr.

- No special scopes required.
- A classic personal access token with default public_repo read access
  is sufficient.
- Create at https://github.com/settings/tokens
- Expire 30 days, regenerate after the hackathon.

Without the PAT the scraper still works, but `max_pages_per_query: 2` is
the safe ceiling and total yield is 400-800 cases.

With the PAT:

- Set `max_pages_per_query: 20-30` in `finetune/corpus/scrape-config.json`
- Run overnight Friday for 1500-2500 normalized cases
- `select-golden-cases.mjs --target 150 --max-per-cwe 8` distills to ~150
  diverse golden cases for the Saturday walker

## Tooling

| Tool | Path | Purpose |
|---|---|---|
| Nextcloud sync | `finetune/scripts/nextcloud-sync.sh` | `ls`, `pull`, `push` subcommands. Reads `.env`. |
| Scraper | `finetune/scripts/scrape-cases.mjs` | GitHub GHSA + npm + OSV scraper |
| Golden selection | `finetune/scripts/select-golden-cases.mjs` | Diversity-aware case selection |
| Benign seeder | `finetune/python/data/benign-packages/seed.sh` | Downloads 20 top npm packages as injector baselines |
| Sample-bad-deps test | `finetune/python/data/sample-bad-deps-project/` | Docker-isolated gate verification |
| Walker | `finetune/python/pipeline/corpus_walker.py` | Produces final sft-records.jsonl |
| Rehearsal smoke | `finetune/python/training/rehearsal.py` | Smoke-tests the SFT plumbing before H100 burn |

## The Saturday timeline

| Time | Action |
|---|---|
| Friday 23:00 | Pull enriched scraped cases from Nextcloud (`./nextcloud-sync.sh pull scraped-cases.npm-enriched.jsonl`) |
| Friday 23:00 | Run expanded scraper overnight (`GITHUB_TOKEN=xxx node finetune/scripts/scrape-cases.mjs --max-pages 30 --partial-on-rate-limit`) |
| Saturday 07:30 | Stop the overnight scraper, push the latest snapshot to Nextcloud |
| Saturday 08:00 | Run `select-golden-cases.mjs --target 150 --max-per-cwe 8` |
| Saturday 08:15 | Run benign-package seeder (`bash finetune/python/data/benign-packages/seed.sh --upload-to-nextcloud`) |
| Saturday 08:30 | Run corpus walker on the golden cases (~45 min, no GPU) |
| Saturday 09:15 | Run rehearsal smoke on Qwen2.5-1.5B (5-10 min) |
| Saturday 09:30 | Launch Recipe A on vast.ai (safety net) AND submit Leonardo SLURM job (primary) |
| Saturday 12:00 | First eval matrix run on Recipe A checkpoint |
| Saturday 18:00 | Leonardo run expected complete; second eval matrix |

## The synthetic track (blocker until benign-packages seeded)

The injector at `finetune/python/data/patterns/injector.py` cannot run
without a benign-baseline package tree. This is currently the largest
gap. The seed script remedies this:

```bash
bash finetune/python/data/benign-packages/seed.sh
```

This downloads 20 top npm packages into
`finetune/python/data/benign-packages/extracted/`. The injector then
takes one of those directories plus one of the 26 attack patterns from
`attack-catalog.yaml` and produces a single synthetic example with the
pattern applied.

To bundle synthetic examples for upload to Nextcloud:

```bash
tar -czf finetune/corpus/synthetic-injected-$(date +%Y%m%d).tar.gz \
  finetune/python/data/synthetic-output/
bash finetune/scripts/nextcloud-sync.sh push \
  finetune/corpus/synthetic-injected-$(date +%Y%m%d).tar.gz
```

## End-to-end gate verification (sample-bad-deps)

The Docker-isolated test project at
`finetune/python/data/sample-bad-deps-project/` declares 5 known-bad +
5 known-clean dependencies. After the production stack is up, run:

```bash
docker compose up -d  # production stack
cd finetune/python/data/sample-bad-deps-project
docker compose up --abort-on-container-exit --exit-code-from tester
```

Expected output:

```
PASS  sample-bad-deps: 5 BLOCK + 5 ALLOW matched, 0 script executions
```

This runs entirely inside a read-only container with `--network none`
relative to the public internet (the only egress is to the MW gate on
the private bridge network), with `--ignore-scripts` enforced. No
malicious code can execute on the host.

## What is NOT on the plan

- Datadog malicious-software-packages-dataset: requires email approval,
  outside the 36-hour budget. Roadmap Q3.
- OSV bulk download: 200 MB+ of records, would dilute the synthetic
  track signal. Skip for Saturday.
- Custom GHSA scraper for non-npm ecosystems: PyPI and Composer are on
  the roadmap, but the synthetic injector already covers PyPI and
  Composer patterns. Real cases land Q3.

## Sign-off

Sign here when each Saturday checkpoint is met:

- [ ] Friday 23:00 scraper launched: ___ (initials)
- [ ] Saturday 08:00 golden selection complete: ___ (initials)
- [ ] Saturday 08:30 benign-packages seeded + uploaded: ___ (initials)
- [ ] Saturday 09:15 rehearsal smoke PASS: ___ (initials)
- [ ] Saturday 09:30 Recipe A launched: ___ (initials)
- [ ] Saturday 09:30 Leonardo SLURM submitted: ___ (initials)
- [ ] Saturday 12:00 first eval matrix complete: ___ (initials)
- [ ] Saturday 18:00 final eval matrix complete: ___ (initials)
