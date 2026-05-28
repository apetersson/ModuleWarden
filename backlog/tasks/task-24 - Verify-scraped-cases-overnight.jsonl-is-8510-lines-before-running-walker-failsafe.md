---
id: TASK-24
title: >-
  Verify scraped-cases-overnight.jsonl is 8510 lines before running walker
  (failsafe)
status: Done
assignee:
  - ademczuk
created_date: '2026-05-28 19:05'
updated_date: '2026-05-28 19:14'
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

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Script at finetune/scripts/verify-overnight-corpus.sh. POSIX bash, 4 exit codes:
- 0: line count matches EXPECTED_LINES
- 2: file not found
- 3: count mismatch (prints actual + diff against expected)
- 4: bad EXPECTED_LINES (non-integer)

Local smoke against current scraped-cases-overnight.jsonl: OK (8510 lines, exit 0).
Mismatch path also tested with EXPECTED_LINES=9999 (exit 3, "Diff: -1489").

Wired into FINETUNE-DATA-PLAN.md Saturday timeline at 07:35, between
"stop the overnight scraper" and "select-golden-cases.mjs". Andrew runs
`bash finetune/scripts/verify-overnight-corpus.sh` first thing; non-zero
exit means re-scrape rather than walk a truncated file.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Failsafe shell script at finetune/scripts/verify-overnight-corpus.sh asserts scraped-cases-overnight.jsonl is EXPECTED_LINES (default 8510) before any consumer touches it. Wired into the FINETUNE-DATA-PLAN.md Saturday timeline at 07:35. Commit 05e325c.
<!-- SECTION:FINAL_SUMMARY:END -->
