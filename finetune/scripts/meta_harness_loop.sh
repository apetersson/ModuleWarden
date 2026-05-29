#!/usr/bin/env bash
#
# meta_harness_loop.sh - Stanford Meta-Harness proposer loop for ModuleWarden's
# audit harness.
#
# Pattern reference: Stanford meta-harness (arXiv:2603.28052,
# github.com/stanford-iris-lab/meta-harness). An AI proposer (Claude Code, via
# `claude -p`) runs in a read-write filesystem loop. Each iteration it:
#   1. Reads the current harness candidate files plus all prior eval traces and
#      scores.
#   2. Diagnoses failure modes by grepping and catting the trace JSON.
#   3. Proposes targeted edits to the harness files.
#   4. Re-runs the eval, scores it.
#   5. Logs results, then loops.
#
# ModuleWarden mapping (see docs/winning-research/07-meta-harness-fit.md s1.3):
#   Harness          = the editable files in HARNESS_FILES below. The fit doc
#                      defines this as chat/prompts/system.md plus
#                      finetune/python/serving/prompt_defense.py. The audit gate
#                      config (GATE_FILE) is included as an optional editable
#                      surface; leave it unset to keep the proposer focused on
#                      the prompt + defense policy only.
#   Search task set  = the `validation` split of finetune/corpus/sft-records.jsonl
#                      (capped at EVAL_LIMIT cases for speed). Never the held-out
#                      `test` split.
#   Scorer           = finetune.python.training.local_finetune_eval, reading
#                      verdict_match_pct and block_recall_pct from its metrics JSON.
#   Objective        = 0.6 * verdict_match_pct + 0.4 * block_recall_pct. Block
#                      recall is weighted higher because a missed block is the
#                      safety-critical failure.
#
# SAFETY:
#   This script never executes any package code. The eval reads JSON text only
#   (dossier -> AuditReport pairs); the model generation is parsed as DATA and
#   never executed. Trace files contain model text written as data. The only
#   things this script runs are: the eval subprocess, `claude -p`, git, and the
#   small Python objective-scorer helper at the bottom (json parsing only).
#
# This script needs the model to actually run (the eval needs a GPU; `claude -p`
# needs network + auth). It is correct and documented but is NOT auto-run as
# part of the build. Run it manually once the harness + GPU are available.
#
# Usage:
#   finetune/scripts/meta_harness_loop.sh [MAX_ITERS]
#
# Environment overrides (all optional):
#   MAX_ITERS        iterations to run (default 8; first positional arg wins)
#   EVAL_SPLIT       split to optimize against (default validation)
#   EVAL_LIMIT       cap eval cases for speed (default 50)
#   EVAL_MODEL       base model for the eval (default Qwen/Qwen2.5-0.5B-Instruct)
#   GATE_FILE        optional extra editable gate-thresholds file (default unset)
#   CLAUDE_BIN       claude CLI binary (default: claude)
#   DRY_RUN          if set to 1, skip the eval and `claude -p`, just lay out
#                    the candidate dirs and print the plan (handy to inspect the
#                    scaffold without a GPU). Default 0.
#
set -euo pipefail

# --- Resolve repo paths (script lives in finetune/scripts/) -----------------
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
cd "${REPO_ROOT}"

# --- Config -----------------------------------------------------------------
MAX_ITERS="${1:-${MAX_ITERS:-8}}"
EVAL_SPLIT="${EVAL_SPLIT:-validation}"
EVAL_LIMIT="${EVAL_LIMIT:-50}"
EVAL_MODEL="${EVAL_MODEL:-Qwen/Qwen2.5-0.5B-Instruct}"
CLAUDE_BIN="${CLAUDE_BIN:-claude}"
DRY_RUN="${DRY_RUN:-0}"
GATE_FILE="${GATE_FILE:-}"

# The editable harness surface. Each candidate is a copy of these files; the
# proposer edits the copies, and accepted edits are applied back to these paths.
HARNESS_FILES=(
  "chat/prompts/system.md"
  "finetune/python/serving/prompt_defense.py"
)
if [[ -n "${GATE_FILE}" ]]; then
  HARNESS_FILES+=("${GATE_FILE}")
fi

# Working dirs for the loop.
CANDIDATES_DIR="${REPO_ROOT}/finetune/python/eval/candidates"
TRACES_DIR="${REPO_ROOT}/finetune/python/eval/traces"
SCORES_LOG="${CANDIDATES_DIR}/scores.jsonl"
METRICS_JSON="${REPO_ROOT}/finetune/python/eval/finetune-metrics.json"

mkdir -p "${CANDIDATES_DIR}" "${TRACES_DIR}"

# --- Helper: compute the objective from the metrics JSON --------------------
# 0.6 * verdict_match_pct + 0.4 * block_recall_pct, read from the "fine_tuned"
# arm of the eval metrics. block_recall_pct can be null (no block cases in the
# slice); treat null as 0 so a candidate that never sees a block is not rewarded.
compute_objective() {
  local metrics_path="$1"
  python - "$metrics_path" <<'PY'
import json, sys
path = sys.argv[1]
try:
    m = json.load(open(path, encoding="utf-8"))
except Exception as exc:
    print(f"ERROR reading metrics: {exc}", file=sys.stderr)
    print("0.0")
    sys.exit(0)
arm = m.get("fine_tuned") or m.get("base") or {}
vm = arm.get("verdict_match_pct") or 0.0
br = arm.get("block_recall_pct")
br = 0.0 if br is None else br
score = 0.6 * float(vm) + 0.4 * float(br)
print(f"{score:.4f}")
PY
}

# --- Helper: run the scorer eval (writes traces) ----------------------------
run_eval() {
  echo "[meta-harness] running eval: split=${EVAL_SPLIT} limit=${EVAL_LIMIT} model=${EVAL_MODEL}"
  # --write-traces makes the eval drop one trace JSON per case into TRACES_DIR.
  # That filesystem is exactly what the proposer diagnoses each iteration.
  python -m finetune.python.training.local_finetune_eval \
    --model "${EVAL_MODEL}" \
    --eval-split "${EVAL_SPLIT}" \
    --eval-limit "${EVAL_LIMIT}" \
    --write-traces \
    --traces-dir "${TRACES_DIR}" \
    --metrics "${METRICS_JSON}"
}

# --- Helper: snapshot the current harness into a candidate dir --------------
snapshot_candidate() {
  local cand_dir="$1"
  mkdir -p "${cand_dir}"
  for f in "${HARNESS_FILES[@]}"; do
    if [[ -f "${REPO_ROOT}/${f}" ]]; then
      # Preserve the relative path inside the candidate dir so the proposer can
      # see which file is which.
      mkdir -p "${cand_dir}/$(dirname "${f}")"
      cp "${REPO_ROOT}/${f}" "${cand_dir}/${f}"
    else
      echo "[meta-harness] WARN: harness file not found: ${f}" >&2
    fi
  done
}

# --- Helper: build the proposer prompt for `claude -p` ----------------------
# The proposer reads candidates/ (current + prior harness snapshots), traces/
# (per-case failure records), the scorer source, and scores.jsonl (history). It
# proposes edits to the HARNESS_FILES in the repo working tree.
build_proposer_prompt() {
  local iter="$1"
  local cand_dir="$2"
  local prev_score="$3"
  cat <<PROMPT
You are the Stanford meta-harness proposer optimizing ModuleWarden's npm package
audit harness. This is iteration ${iter} of ${MAX_ITERS}.

OBJECTIVE (maximize): 0.6 * verdict_match_pct + 0.4 * block_recall_pct.
Block recall is weighted higher: a missed block verdict is a safety-critical
failure. Previous best objective score: ${prev_score}.

EDITABLE HARNESS FILES (the only files you may edit):
$(printf '  - %s\n' "${HARNESS_FILES[@]}")

READ-ONLY CONTEXT for diagnosis:
  - ${cand_dir}/        the current harness candidate snapshot
  - ${CANDIDATES_DIR}/  all prior candidate snapshots
  - ${TRACES_DIR}/      one JSON per eval case: prompt_used, gold_verdict,
                        model_verdict, raw_output, schema_valid. Grep these for
                        cases where model_verdict != gold_verdict, and especially
                        for is_block_gold:true with block_caught:false.
  - finetune/python/training/local_finetune_eval.py  the scorer (do not edit)
  - ${SCORES_LOG}       the per-iteration score history

YOUR TASK this iteration:
  1. Read the traces. Identify the dominant failure mode (e.g. blocks softened to
     quarantine, schema-invalid output, missed technique attribution).
  2. Make ONE focused, targeted edit to the harness files that should fix that
     failure mode. Prefer small prompt or defense-policy changes over rewrites.
  3. Do not edit the scorer, the corpus, or any file outside HARNESS_FILES.
  4. Do not weaken the safety posture: the harness must still quarantine on
     uncertainty and must not soften a block.

Explain the failure mode you found and the single edit you made.
PROMPT
}

# --- Main loop --------------------------------------------------------------
echo "[meta-harness] repo=${REPO_ROOT}"
echo "[meta-harness] objective = 0.6*verdict_match_pct + 0.4*block_recall_pct"
echo "[meta-harness] max iterations = ${MAX_ITERS}"
echo "[meta-harness] dry run = ${DRY_RUN}"

best_score="0.0"
prev_score="0.0"

for (( iter=1; iter<=MAX_ITERS; iter++ )); do
  echo ""
  echo "===================== iteration ${iter}/${MAX_ITERS} ====================="
  cand_dir="${CANDIDATES_DIR}/candidate-${iter}"

  # 1. Snapshot the current harness into candidate-N/.
  snapshot_candidate "${cand_dir}"
  echo "[meta-harness] snapshotted harness -> ${cand_dir}"

  if [[ "${DRY_RUN}" == "1" ]]; then
    echo "[meta-harness] DRY_RUN: skipping eval + claude -p for iteration ${iter}."
    echo "[meta-harness] would run eval, then invoke: ${CLAUDE_BIN} -p '<proposer prompt>'"
    build_proposer_prompt "${iter}" "${cand_dir}" "${prev_score}" > "${cand_dir}/proposer-prompt.txt"
    echo "[meta-harness] wrote proposer prompt -> ${cand_dir}/proposer-prompt.txt"
    continue
  fi

  # 2. Run the eval (writes traces to TRACES_DIR, metrics to METRICS_JSON).
  run_eval

  # 3. Score this candidate against the objective and record it.
  score="$(compute_objective "${METRICS_JSON}")"
  echo "[meta-harness] iteration ${iter} objective score = ${score}"
  cp "${METRICS_JSON}" "${cand_dir}/finetune-metrics.json" 2>/dev/null || true
  python - "$SCORES_LOG" "$iter" "$score" "$cand_dir" <<'PY'
import json, sys, time
log, iter_, score, cand = sys.argv[1], int(sys.argv[2]), float(sys.argv[3]), sys.argv[4]
row = {"iteration": iter_, "objective": score, "candidate_dir": cand,
       "ts": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())}
with open(log, "a", encoding="utf-8") as fh:
    fh.write(json.dumps(row) + "\n")
PY

  # Track the best score across iterations.
  if python -c "import sys; sys.exit(0 if float('${score}') > float('${best_score}') else 1)"; then
    best_score="${score}"
    echo "[meta-harness] new best objective = ${best_score} (candidate-${iter})"
  fi

  # The last iteration scores the final accepted harness; no further proposal.
  if (( iter == MAX_ITERS )); then
    echo "[meta-harness] reached MAX_ITERS; not proposing a further edit."
    break
  fi

  # 4. Invoke the proposer to read traces + candidates and edit the harness.
  echo "[meta-harness] invoking proposer (${CLAUDE_BIN} -p) ..."
  proposer_prompt="$(build_proposer_prompt "${iter}" "${cand_dir}" "${prev_score}")"
  echo "${proposer_prompt}" > "${cand_dir}/proposer-prompt.txt"
  # `claude -p` runs Claude Code headless with filesystem access; it applies the
  # proposed harness edit directly to the working tree (the HARNESS_FILES).
  "${CLAUDE_BIN}" -p "${proposer_prompt}"

  # 5. Commit between iterations so any accepted edit is one `git checkout` away
  #    from rollback (per the fit doc risk note). Only commits if the proposer
  #    actually changed a tracked harness file.
  if [[ -n "$(git status --porcelain -- "${HARNESS_FILES[@]}" 2>/dev/null)" ]]; then
    git add -- "${HARNESS_FILES[@]}"
    git commit -m "meta-harness iter ${iter}: harness edit (objective ${score})" >/dev/null 2>&1 \
      || echo "[meta-harness] WARN: commit failed (no git identity?); leaving edit uncommitted." >&2
  else
    echo "[meta-harness] proposer made no harness edit this iteration."
  fi

  prev_score="${score}"
done

echo ""
echo "[meta-harness] done. best objective = ${best_score}"
echo "[meta-harness] score history: ${SCORES_LOG}"
echo "[meta-harness] candidates:    ${CANDIDATES_DIR}"
echo "[meta-harness] NOTE: validate the best candidate on the held-out test split"
echo "[meta-harness]       before claiming a real number, e.g.:"
echo "[meta-harness]       python -m finetune.python.training.local_finetune_eval --eval-split test"
