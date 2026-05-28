---
id: TASK-24
title: >-
  Verify scraped-cases-overnight.jsonl is 8510 lines before running walker
  (failsafe)
status: In Progress
assignee:
  - ademczuk
created_date: '2026-05-28 19:05'
updated_date: '2026-05-28 19:13'
labels:
  - finetune
  - saturday-morning
  - failsafe
dependencies: []
priority: high
ordinal: 40000
---

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
Add finetune/scripts/verify-overnight-corpus.sh that wc -l's the overnight scrape and asserts the count against EXPECTED_LINES (default 8510). Non-zero exit on miss; one-line OK on hit. Add an entry at the top of the Saturday timeline in FINETUNE-DATA-PLAN.md so the script is the first thing Andrew runs Saturday morning before select-golden-cases or walker touch the file. Verify locally that the script exits 0 against the current scraped-cases-overnight.jsonl (8510 lines, confirmed).
<!-- SECTION:PLAN:END -->
