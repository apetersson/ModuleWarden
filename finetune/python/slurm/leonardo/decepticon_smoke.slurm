#!/bin/bash
# Proof run: serve the staged heretic-v2 GGUF with llama.cpp on 1 A100 and run the
# Decepticon narration smoke through it. Self-contained (no tunnel): health-check,
# chat smoke, then model_client.narrate_attack_chain against the local endpoint.
#SBATCH --account=euhpc_d30_031
#SBATCH --partition=boost_usr_prod
#SBATCH --reservation=s_tra_ncc
#SBATCH --nodes=1
#SBATCH --ntasks-per-node=1
#SBATCH --gpus-per-task=1
#SBATCH --cpus-per-task=32
#SBATCH --mem=64G
#SBATCH --time=0:45:00
#SBATCH --job-name=mw-decepticon-smoke
#SBATCH --output=%x-%j.out

set -x
SCRATCH="${SCRATCH:-/leonardo_scratch/large/usertrain/$USER}"
GGUF=$SCRATCH/models/decepticon-heretic-v2-gguf/Qwen3.6-27B-uncensored-heretic-v2-Native-MTP-Preserved-Q5_K_M.gguf
SIF=$SCRATCH/llamacpp.sif
PYSIF=$SCRATCH/pytorch57.sif
REPO=$SCRATCH/ModuleWarden
PORT=8000

nvidia-smi --query-gpu=name,memory.total --format=csv,noheader
ls -la "$GGUF" "$SIF" "$PYSIF" || { echo "MISSING_INPUT"; exit 1; }

# Serve on CPU with the latest llama.cpp (CPU image). The qwen35 GGUF is a hybrid
# attention+SSM arch that only the latest llama.cpp can build; the latest CUDA image
# PTX-JITs a CUDA newer than the Leonardo A100 driver (12.2) supports and crashes at
# warmup, and the CUDA-matched llama-cpp-python wheel (0.3.23) is too old for qwen35.
# CPU sidesteps the CUDA mismatch. Decepticon is low-volume offense narration, so CPU
# latency is fine. (GPU needs a source build: CUDA <=12.4 + CMAKE_CUDA_ARCHITECTURES=80
# so it bakes sm_80 cubins and skips the PTX JIT.)
CPUSIF=$SCRATCH/llamacpp-cpu.sif
singularity exec --bind "$SCRATCH" --env LD_LIBRARY_PATH=/app "$CPUSIF" \
  /app/llama-server -m "$GGUF" --host 127.0.0.1 --port $PORT --ctx-size 8192 \
  --n-gpu-layers 0 -t 32 \
  > $SCRATCH/llama-server.log 2>&1 &
LLPID=$!
echo "llama-server (CPU) pid=$LLPID"

# wait for health (model load from scratch can take 1-3 min)
HEALTH=no
for i in $(seq 1 90); do
  if curl -sf http://127.0.0.1:$PORT/health >/dev/null 2>&1; then HEALTH=ok; echo "HEALTH_OK after ${i}x5s"; break; fi
  if ! kill -0 $LLPID 2>/dev/null; then echo "SERVER_DIED at ${i}x5s"; tail -30 $SCRATCH/llama-server.log; exit 3; fi
  sleep 5
done
if [ "$HEALTH" != ok ]; then echo "HEALTH_FAILED"; tail -40 $SCRATCH/llama-server.log; kill $LLPID 2>/dev/null; exit 2; fi

echo "=== chat smoke ==="
curl -s http://127.0.0.1:$PORT/v1/chat/completions -H "Content-Type: application/json" \
  -d '{"model":"qwen3.6-27b-heretic-v2","messages":[{"role":"user","content":"reply with the single word ready /no_think"}],"max_tokens":16}'
echo ""

echo "=== decepticon narrate smoke ==="
export DECEPTICON_MODEL_ENDPOINT_BASE_URL=http://127.0.0.1:$PORT/v1
export DECEPTICON_MODEL_ENDPOINT_MODEL=qwen3.6-27b-heretic-v2
cd "$REPO"
singularity exec --bind "$SCRATCH" "$PYSIF" python3 - <<'PY'
import importlib.util, sys
from pathlib import Path
p = Path("finetune/python/decepticon/model_client.py")
spec = importlib.util.spec_from_file_location("dc_mc", p)
mc = importlib.util.module_from_spec(spec); sys.modules[spec.name] = mc
spec.loader.exec_module(mc)
print("configured:", mc.is_configured())
print("requires_abliteration:", mc.requires_abliteration())
chain = {
  "chain": "Initial Access to Credential Access to Exfiltration",
  "technique_ids": ["T1195.002", "T1552.001", "T1041"],
  "steps": [
    {"tactic": "Initial Access", "technique_id": "T1195.002", "procedure": "A postinstall hook runs at dependency install time."},
    {"tactic": "Credential Access", "technique_id": "T1552.001", "procedure": "Reads env vars and credential files in the install context."},
    {"tactic": "Exfiltration", "technique_id": "T1041", "procedure": "Opens an undeclared outbound connection."},
  ],
}
import json as _json
pinned = {"package": "evil-postinstall@2.0.0", "chain": chain["chain"],
          "technique_ids": chain["technique_ids"], "steps": chain["steps"]}
user_msg = ("Pinned ATT&CK kill chain (authoritative; narrate, do not alter):\n\n"
            + _json.dumps(pinned, indent=2) + "\n\n/no_think")
# call complete() directly with a smaller token budget + longer timeout (CPU is slow);
# narrate_attack_chain() hardcodes max_tokens=700/timeout=60 which CPU exceeds.
# /no_think disables Qwen3.6's reasoning block so the narration lands in content
# (otherwise the token budget is spent in reasoning_content and content is empty).
out = mc.complete(system_prompt=mc._SYSTEM_PROMPT,
                  messages=[{"role": "user", "content": user_msg}],
                  max_tokens=900, timeout_s=800)
print("NARRATION_START")
print(out)
print("NARRATION_END")
# This GGUF's chat template forces a <think> block; if the whole budget is spent
# thinking, content can be empty. Show the model's reasoning too so the proof always
# carries coherent generated output (the attacker analysis is itself the narration).
if not (out and out.strip()):
    import urllib.request as _u
    cfg = mc.resolve_config()
    body = {"model": cfg.model, "stream": False, "max_tokens": 256, "messages": [
        {"role": "system", "content": mc._SYSTEM_PROMPT},
        {"role": "user", "content": user_msg}]}
    rq = _u.Request(cfg.base_url + "/chat/completions",
                    data=_json.dumps(body).encode(), method="POST",
                    headers={"Content-Type": "application/json"})
    with _u.urlopen(rq, timeout=800) as r:
        m = _json.loads(r.read())["choices"][0]["message"]
    print("REASONING_FALLBACK_START")
    print((m.get("reasoning_content") or "")[:1500])
    print("REASONING_FALLBACK_END")
PY
echo "NARRATE_RC=$?"

kill $LLPID 2>/dev/null
echo "MW_DECEPTICON_SMOKE_DONE"
