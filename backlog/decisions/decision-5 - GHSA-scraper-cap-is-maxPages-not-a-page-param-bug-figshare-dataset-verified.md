---
id: decision-5
title: GHSA scraper cap is maxPages not a page-param bug; figshare dataset verified
date: '2026-05-29 08:48'
status: accepted
---
## Context

A Kimi-swarm research pass on training-data volume produced three
claims. Each was verified against the actual code and live APIs before
acting (claims are leads, not facts).

### Claim 1: "the GHSA scraper is capped at ~800 because the GitHub /advisories page param is ignored; needs a GraphQL rewrite"

REFUTED as stated. `finetune/scripts/scrape-cases.mjs` does NOT use
offset `?page=N` pagination. It uses cursor pagination via the
`Link: rel="next"` header (`parseNextLink`, advancing `url` from the
`after=` cursor). Live test against `GET /advisories?ecosystem=npm&type=malware`:
page 1 and the `Link`-cursor page 2 had ZERO overlap (200 distinct
advisories). The cursor advances correctly.

The real cap is `max_pages_per_query` in `finetune/corpus/scrape-config.json`,
which was set to 2. With 2 types x 2 severities x 2 pages x 100 = the
~800 ceiling the swarm observed. The swarm got the number right and the
cause wrong. No GraphQL rewrite is needed.

Also verified the severity matrix is not silently dropping malware:
GitHub rates npm malware advisories as `critical` (live test:
`type=malware&severity=critical` returns full pages with more;
`type=malware&severity=high` returns 0). So malware comes through the
`critical` combo; the `malware x high` combo is empty but harmless.

### Claim 2: "figshare dataset, arXiv:2603.27549, 13,708 labeled packages, ready to download"

VERIFIED (web-researcher + arXiv + figshare API). arXiv:2603.27549
resolves to "Understanding NPM Malicious Package Detection: A
Benchmark-Driven Empirical Analysis". Numbers exact: 13,708 packages
(6,420 malicious + 7,288 benign), 11 behavior categories, 8 evasion
techniques, Cohen kappa 0.78. Download: figshare DOI
10.6084/m9.figshare.31869370, three ZIPs ~6.55 GB, CC BY 4.0 (paper PDF
says CC0; attribute to be safe). Adapter effort is MODERATE (4-8h), not
trivial: must unpack and inspect the ZIP structure before writing the
adapter. Filed as TASK-32.

### Claim 3: "2 GB per case" / "target 4,000 cases"

Storage: ~4 MB/case (tarball only) to ~21 MB/case (with git archive for
source-match). The 2 GB figure is off by 50-500x. Target: 1,000-2,000
cases is the LoRA sweet spot for a 7B model; 4,000 is diminishing
returns; GPT-4 floor is 97 percent F1 on 5,115 cases (arXiv:2403.12196)
so raw volume is not the lever.

## Decision

1. Raise `max_pages_per_query` from 2 to 20 in `scrape-config.json`.
   The cursor is verified working and advisory JSON is tiny, so this is
   low-risk: it enlarges the candidate pool (productive combos
   reviewed x high, reviewed x critical, malware x critical at 100/page)
   to roughly a few thousand candidates. The expensive tarball-and-diff
   step is still gated downstream by `corpus_walker --max-cases`, so a
   bigger candidate pool does not change disk cost until the operator
   selects cases.
2. Do NOT rewrite the scraper to GraphQL. Not needed.
3. Do NOT change the severity matrix this weekend. Malware is captured
   via `critical`; adding a no-severity combo would broaden malware
   coverage but dilute the reviewed bucket with low/medium CVE noise.
   Noted for Andrew if he wants it later.
4. Adopt the figshare dataset as the training backbone (TASK-32), with
   GHSA-scraped cases supplementing it for the live-data story. Target
   1,000-2,000 trained cases, package-disjoint, 40-60 percent class
   balance, >=200 held-out test.

## Consequences

- Saturday corpus pull can reach the 1,000-2,000 target in one scraper
  run instead of needing 5+ runs with different query combos. One-line
  config change, reversible.
- The figshare backbone (13,708 labeled, balanced, no scraping) de-risks
  the whole data-volume question; the GHSA scrape becomes the
  freshness/live-data supplement, not the sole source.
- The "2 GB per case" disk planning figure in any runbook should be
  corrected to ~4-21 MB/case so the Saturday disk budget is right.
