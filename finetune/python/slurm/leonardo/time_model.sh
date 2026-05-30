#!/bin/bash
# time_model.sh <decepticon|auditor> "<your prompt>" [max_tokens]
#
# Launch from a Leonardo LOGIN shell. It grabs a GPU on the hackathon reservation,
# loads the chosen model, runs your custom prompt, and prints LOAD / INFERENCE / TOTAL
# seconds plus the response. It also reports end-to-end wall clock (which adds Slurm
# queue + node allocation on top).
#
#   ./time_model.sh decepticon "Summarize the npm install lifecycle in two sentences."
#   ./time_model.sh auditor    "Is reading ~/.npmrc in a postinstall suspicious?" 300
#
# Account-agnostic: paths derive from $SCRATCH / $USER. On a fresh account the
# decepticon path self-bootstraps: this launcher clones llama.cpp source + fetches a
# cmake here (login node, has internet), then the first run builds llama.cpp on the
# GPU node (~10 min, one-time, cached). The auditor path reuses the fine-tune env
# (pytorch57.sif + mwenv57b from prep-qwen36.slurm).
set -euo pipefail
MODEL="${1:?usage: time_model.sh <decepticon|auditor> \"prompt\" [max_tokens]}"
PROMPT="${2:?provide a prompt in quotes}"
MAXTOK="${3:-200}"
SCRATCH="${SCRATCH:-/leonardo_scratch/large/usertrain/$USER}"
HERE="$(cd "$(dirname "$0")" && pwd)"

# --- one-time bootstrap for the decepticon (GPU llama.cpp) path, on the login node ---
if [ "$MODEL" = decepticon ]; then
  if [ ! -d "$SCRATCH/llama.cpp-src" ]; then
    echo ">>> cloning llama.cpp source to \$SCRATCH (one-time)..."
    git clone --depth 1 https://github.com/ggml-org/llama.cpp "$SCRATCH/llama.cpp-src"
  fi
  if [ ! -x "$SCRATCH/cmake/bin/cmake" ]; then
    echo ">>> fetching a recent cmake to \$SCRATCH (one-time)..."
    curl -fsSL https://github.com/Kitware/CMake/releases/download/v3.30.5/cmake-3.30.5-linux-x86_64.tar.gz -o "$SCRATCH/cmake.tgz" \
      && tar xzf "$SCRATCH/cmake.tgz" -C "$SCRATCH" && mv "$SCRATCH/cmake-3.30.5-linux-x86_64" "$SCRATCH/cmake" && rm -f "$SCRATCH/cmake.tgz"
  fi
fi

# make sure the on-node script is reachable on scratch (copy next to us if present)
RUN=$SCRATCH/time_model_run.sh
if [ -f "$HERE/time_model_run.sh" ] && [ ! "$HERE/time_model_run.sh" -ef "$RUN" ]; then
  cp -f "$HERE/time_model_run.sh" "$RUN"
fi
[ -f "$RUN" ] || { echo "missing $RUN (put time_model_run.sh next to this script or on \$SCRATCH)"; exit 1; }
chmod +x "$RUN"

if [ "$MODEL" = decepticon ] && [ ! -x "$SCRATCH/llama.cpp-src/build/bin/llama-server" ]; then
  echo ">>> first decepticon run on this account: the GPU job will build llama.cpp once"
  echo ">>> (~5 min, streamed below, then cached). Do not Ctrl-C; it is not hung."
fi

W0=$(date +%s.%N)
srun --account=euhpc_d30_031 --partition=boost_usr_prod --reservation=s_tra_ncc \
     --nodes=1 --ntasks=1 --gpus-per-task=2 --cpus-per-task=16 --mem=120G --time=0:30:00 \
     bash "$RUN" "$MODEL" "$PROMPT" "$MAXTOK"
W1=$(date +%s.%N)
awk "BEGIN{printf \"WALL_CLOCK_INCL_QUEUE_AND_ALLOC_SECONDS: %.1f\n\", $W1-$W0}"
