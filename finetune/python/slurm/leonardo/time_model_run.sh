#!/bin/bash
# time_model_run.sh <decepticon|auditor> "<prompt>" [max_tokens]
#
# Runs ON a Leonardo GPU compute node (invoked by time_model.sh via srun, or directly
# inside an sbatch job). Times model LOAD and INFERENCE for a custom prompt and prints
# a uniform breakdown. TOTAL_SECONDS = load + inference (full on-node response time,
# all model overhead included).
#
# Account-agnostic: all paths derive from $SCRATCH / $USER, so it runs unchanged on
# any team account once the per-account prerequisites are present (see time_model.sh,
# which bootstraps the decepticon path automatically on first use).
set -o pipefail
MODEL="${1:?model: decepticon|auditor}"
PROMPT="${2:?prompt text in quotes}"
MAXTOK="${3:-200}"
SCRATCH="${SCRATCH:-/leonardo_scratch/large/usertrain/$USER}"
sub(){ awk "BEGIN{printf \"%.2f\", $2-$1}"; }   # sub A B -> B-A

# HARD GUARD: this script builds llama.cpp and loads a 20-55 GB model. That must
# happen on a COMPUTE node. Run on a Leonardo LOGIN node it will spike CPU/memory and
# the login arbiter/OOM-killer terminates ALL your processes (including SSH) after a
# few minutes. Refuse unless we are inside a Slurm allocation; use time_model.sh.
if [ -z "${SLURM_JOB_ID:-}" ]; then
  echo "ERROR: do not run time_model_run.sh directly -- it loads a model and would be"
  echo "killed on the login node (taking your SSH session with it)."
  echo "Launch it through the wrapper, which allocates a GPU for you:"
  echo "    ./time_model.sh $MODEL \"$PROMPT\" ${MAXTOK}"
  exit 1
fi

if [ "$MODEL" = decepticon ]; then
  # heretic-v2 qwen35 GGUF served by a source-built llama.cpp (native CUDA 12.2, sm_80)
  GGUF=$SCRATCH/models/decepticon-heretic-v2-gguf/Qwen3.6-27B-uncensored-heretic-v2-Native-MTP-Preserved-Q5_K_M.gguf
  SRC=$SCRATCH/llama.cpp-src
  BIN=$SRC/build/bin/llama-server
  CUROOT=/leonardo/prod/opt/compilers/cuda/12.2/none      # matches the A100 driver (CUDA 12.2)
  export PATH=$CUROOT/bin:${SCRATCH}/cmake/bin:$PATH
  export LD_LIBRARY_PATH=$CUROOT/lib64:${LD_LIBRARY_PATH:-}
  CMAKE=$SCRATCH/cmake/bin/cmake; [ -x "$CMAKE" ] || CMAKE=cmake

  # one-time build (untimed): native sm_80 SASS so the 12.2 driver never JITs PTX,
  # and latest source so the qwen35 hybrid-SSM arch builds. gcc 8.5 needs -lstdc++fs.
  if [ ! -x "$BIN" ]; then
    [ -d "$SRC" ] || { echo "no llama.cpp source at $SRC -- run time_model.sh from a login node first (it clones it)"; exit 1; }
    echo ">>> first run on this account: building llama.cpp (CUDA 12.2, sm_80) on this"
    echo ">>> compute node. One-time, ~5 min; progress streams below, then it's cached."
    cd "$SRC" || exit 1
    "$CMAKE" -B build -DGGML_CUDA=ON -DCMAKE_CUDA_ARCHITECTURES=80 -DLLAMA_CURL=OFF \
        -DGGML_NATIVE=OFF -DCMAKE_BUILD_TYPE=Release -DLLAMA_BUILD_TESTS=OFF \
        -DLLAMA_BUILD_EXAMPLES=OFF -DLLAMA_BUILD_TOOLS=ON -DCMAKE_CUDA_HOST_COMPILER=/usr/bin/g++ \
        -DCMAKE_CXX_STANDARD_LIBRARIES=-lstdc++fs 2>&1 | tail -3 || { echo "cmake config failed"; exit 1; }
    "$CMAKE" --build build --config Release -j "${SLURM_CPUS_PER_TASK:-16}" --target llama-server 2>&1 | grep --line-buffered -E "%\]|error|Error" | tail -40
    [ -x "$BIN" ] || { echo "BUILD FAILED"; exit 1; }
    echo ">>> build done, cached at $BIN"
  fi
  LIBDIRS=$(find "$SRC/build" -name '*.so' -printf '%h\n' 2>/dev/null | sort -u | tr '\n' ':')
  export LD_LIBRARY_PATH="${LIBDIRS}${LD_LIBRARY_PATH:-}"

  LOG=$SCRATCH/.tm-llama.$$.log
  T0=$(date +%s.%N)
  "$BIN" -m "$GGUF" --host 127.0.0.1 --port 8011 --ctx-size 4096 --n-gpu-layers 999 > "$LOG" 2>&1 &
  P=$!
  until curl -sf http://127.0.0.1:8011/health >/dev/null 2>&1; do
    kill -0 "$P" 2>/dev/null || { echo "DECEPTICON server died:"; tail -20 "$LOG"; exit 1; }
    sleep 0.3
  done
  T1=$(date +%s.%N)   # model loaded + server ready
  BODY=$(python3 -c "import json,sys;print(json.dumps({'model':'heretic-v2','messages':[{'role':'user','content':sys.argv[1]}],'max_tokens':int(sys.argv[2])}))" "$PROMPT" "$MAXTOK")
  RESP=$(curl -s http://127.0.0.1:8011/v1/chat/completions -H "Content-Type: application/json" -d "$BODY")
  T2=$(date +%s.%N)
  ANS=$(printf '%s' "$RESP" | python3 -c "import sys,json;m=json.load(sys.stdin)['choices'][0]['message'];print((m.get('content') or '').strip() or ('[reasoning] '+m.get('reasoning_content','')[:800]))")
  kill "$P" 2>/dev/null
  LOAD=$(sub "$T0" "$T1"); INFER=$(sub "$T1" "$T2"); TOTAL=$(sub "$T0" "$T2")

elif [ "$MODEL" = auditor ]; then
  # huihui-Qwen3.6-27B-abliterated bf16 loaded via transformers (the fine-tune env)
  VENV=$SCRATCH/mwenv57b/bin/python
  SIF=$SCRATCH/pytorch57.sif
  if [ ! -x "$VENV" ] || [ ! -f "$SIF" ]; then
    echo "auditor path needs the fine-tune env (pytorch57.sif + mwenv57b)."
    echo "Run the prep job once first:  sbatch finetune/python/slurm/leonardo/prep-qwen36.slurm"
    echo "(the decepticon path needs none of this and self-builds.)"
    exit 1
  fi
  export TM_PROMPT="$PROMPT" TM_MAXTOK="$MAXTOK" MWMODEL=$SCRATCH/models/huihui-qwen3.6-27b-abliterated
  OUT=$(singularity exec --nv --bind "$SCRATCH" "$SIF" "$VENV" - 2>&1 <<'PY'
import os, time, torch
from transformers import AutoConfig, AutoTokenizer, AutoModelForCausalLM
M = os.environ["MWMODEL"]
t0 = time.time()
tok = AutoTokenizer.from_pretrained(M, trust_remote_code=True)
cfg = AutoConfig.from_pretrained(M)
if hasattr(cfg, "language_model_only"):
    cfg.language_model_only = True
model = AutoModelForCausalLM.from_pretrained(M, config=cfg, device_map="auto", dtype=torch.bfloat16, trust_remote_code=True)
t1 = time.time()
msgs = [{"role": "user", "content": os.environ["TM_PROMPT"]}]
try:
    enc = tok.apply_chat_template(msgs, add_generation_prompt=True, return_tensors="pt", return_dict=True, enable_thinking=False)
except TypeError:
    enc = tok.apply_chat_template(msgs, add_generation_prompt=True, return_tensors="pt", return_dict=True)
enc = {k: (v.to(model.device) if hasattr(v, "to") else v) for k, v in enc.items()}
out = model.generate(**enc, max_new_tokens=int(os.environ["TM_MAXTOK"]), do_sample=False)
t2 = time.time()
ans = tok.decode(out[0][enc["input_ids"].shape[1]:], skip_special_tokens=True).strip()
print(f"LOAD={t1-t0:.2f}")
print(f"INFER={t2-t1:.2f}")
print(f"TOTAL={t2-t0:.2f}")
print("ANS_START"); print(ans); print("ANS_END")
PY
)
  LOAD=$(printf '%s' "$OUT" | sed -n 's/^LOAD=//p')
  INFER=$(printf '%s' "$OUT" | sed -n 's/^INFER=//p')
  TOTAL=$(printf '%s' "$OUT" | sed -n 's/^TOTAL=//p')
  ANS=$(printf '%s' "$OUT" | awk '/ANS_START/{f=1;next}/ANS_END/{f=0}f')
  if [ -z "$TOTAL" ]; then
    if printf '%s' "$OUT" | grep -qiE "mwenv57b.*no such|python.*no such file|cannot open shared object|FATAL"; then
      echo "auditor env (mwenv57b) was missing or vanished mid-run. On this account another"
      echo "job is rebuilding the fine-tune env, so it comes and goes. Retry once that has"
      echo "settled, or run prep-qwen36.slurm and let it finish. The decepticon path needs"
      echo "none of this and works now."
    else
      echo "auditor run produced no timing; raw output:"; printf '%s\n' "$OUT" | tail -20
    fi
    exit 1
  fi
else
  echo "unknown model '$MODEL' (use: decepticon | auditor)"; exit 2
fi

echo "================= TIMING ================="
echo "MODEL:             $MODEL"
echo "PROMPT:            $PROMPT"
echo "MAX_TOKENS:        $MAXTOK"
echo "LOAD_SECONDS:      $LOAD"
echo "INFERENCE_SECONDS: $INFER"
echo "TOTAL_SECONDS:     $TOTAL   (load + inference)"
echo "------------- RESPONSE -------------"
echo "$ANS"
echo "=========================================="
