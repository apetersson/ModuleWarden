#!/usr/bin/env bash
# Saturday-morning failsafe: confirm the overnight scrape produced the
# expected line count before any consumer (select-golden-cases.mjs,
# corpus_walker.py) reads the file. See backlog TASK-24.
#
# Usage:
#   bash finetune/scripts/verify-overnight-corpus.sh
#   bash finetune/scripts/verify-overnight-corpus.sh path/to/corpus.jsonl
#   EXPECTED_LINES=9123 bash finetune/scripts/verify-overnight-corpus.sh
#
# Exit codes:
#   0 - file exists and line count matches
#   2 - file not found
#   3 - line count mismatch
#   4 - bad arguments

set -euo pipefail

CORPUS="${1:-finetune/corpus/scraped-cases-overnight.jsonl}"
EXPECTED="${EXPECTED_LINES:-8510}"

if ! [[ "$EXPECTED" =~ ^[0-9]+$ ]]; then
    echo "verify-overnight-corpus: EXPECTED_LINES must be an integer, got $EXPECTED" >&2
    exit 4
fi

if [[ ! -f "$CORPUS" ]]; then
    echo "verify-overnight-corpus FAIL: $CORPUS not found." >&2
    echo "  Did the overnight scraper finish? If yes, was the output written" >&2
    echo "  to a different path? Pass the path as arg 1, or set EXPECTED_LINES." >&2
    exit 2
fi

actual=$(wc -l < "$CORPUS" | tr -d ' ')

if [[ "$actual" != "$EXPECTED" ]]; then
    echo "verify-overnight-corpus FAIL: $CORPUS has $actual lines, expected $EXPECTED." >&2
    echo "  Diff: $((actual - EXPECTED))" >&2
    echo "  If the overnight scrape grew or shrank, update EXPECTED_LINES." >&2
    echo "  If the file is truncated or empty, re-run the scraper before walker." >&2
    exit 3
fi

echo "verify-overnight-corpus OK: $CORPUS has $actual lines."
