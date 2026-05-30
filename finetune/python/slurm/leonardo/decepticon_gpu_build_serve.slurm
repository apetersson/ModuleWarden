#!/bin/bash
# GPU proof: build the latest llama.cpp from source against Leonardo's native CUDA 12.2
# toolkit (exact match to the A100 driver 535.x/CUDA 12.2) with
# CMAKE_CUDA_ARCHITECTURES=80, so it bakes native sm_80 SASS and never PTX-JITs. Then
# serve the heretic-v2 qwen35 GGUF on the GPU and run the Decepticon narration smoke.
# The cuda/12.2 module is gcc-8.5-based and does not put nvcc on PATH, so we point at
# the toolkit directly. Build on the compute node (the login node OOM-kills heavy
# builds). One job: build (once) -> serve -> smoke.
#SBATCH --account=euhpc_d30_031
#SBATCH --partition=boost_usr_prod
#SBATCH --reservation=s_tra_ncc
#SBATCH --nodes=1
#SBATCH --ntasks-per-node=1
#SBATCH --gpus-per-task=1
#SBATCH --cpus-per-task=32
#SBATCH --mem=120G
#SBATCH --time=0:55:00
#SBATCH --job-name=mw-dec-gpu
#SBATCH --output=%x-%j.out

set -x
SCRATCH="${SCRATCH:-/leonardo_scratch/large/usertrain/$USER}"
SRC=$SCRATCH/llama.cpp-src
BIN=$SRC/build/bin/llama-server
GGUF=$SCRATCH/models/decepticon-heretic-v2-gguf/Qwen3.6-27B-uncensored-heretic-v2-Native-MTP-Preserved-Q5_K_M.gguf
PORT=8000

# native CUDA 12.2 toolkit (matches driver 12.2 -> sm_80 SASS, no JIT). Prefer the
# gcc/12.2.0 module as the CUDA host compiler: it is a supported CUDA 12.2 host gcc and
# ships std::filesystem in libstdc++ proper. Falls back to system g++ if the module is
# missing, in which case the -lstdc++fs link flag is re-added below.
module load gcc/12.2.0 2>/dev/null || echo "warn: gcc/12.2.0 module unavailable, using system g++"
CUROOT=/leonardo/prod/opt/compilers/cuda/12.2/none
export CUDAToolkit_ROOT=$CUROOT CUDACXX=$CUROOT/bin/nvcc
export PATH=$CUROOT/bin:$SCRATCH/cmake/bin:$PATH
export LD_LIBRARY_PATH=$CUROOT/lib64:$LD_LIBRARY_PATH
HOSTCXX=$(command -v g++)
GCCMAJ=$("$HOSTCXX" -dumpversion 2>/dev/null | cut -d. -f1)
# gcc < 9 keeps std::filesystem in a separate lib; only then add -lstdc++fs.
STDFS=""; [ "${GCCMAJ:-0}" -lt 9 ] && STDFS="-DCMAKE_CXX_STANDARD_LIBRARIES=-lstdc++fs"
echo "host g++ = $HOSTCXX (gcc major ${GCCMAJ:-?})"

nvidia-smi --query-gpu=name,memory.total --format=csv,noheader
nvcc --version | tail -1
cmake --version | head -1

# ---- build once (native sm_80 SASS so the 12.2 driver never JITs PTX) ----
if [ ! -x "$BIN" ]; then
  echo "=== building llama.cpp (CUDA 12.2, arch sm_80, host $HOSTCXX) ==="
  cd "$SRC" || exit 1
  cmake -B build -DGGML_CUDA=ON -DCMAKE_CUDA_ARCHITECTURES=80 -DLLAMA_CURL=OFF \
        -DGGML_NATIVE=OFF -DCMAKE_BUILD_TYPE=Release \
        -DLLAMA_BUILD_TESTS=OFF -DLLAMA_BUILD_EXAMPLES=OFF -DLLAMA_BUILD_TOOLS=ON \
        -DCMAKE_CUDA_HOST_COMPILER="$HOSTCXX" \
        $STDFS \
        || { echo CMAKE_CONFIG_FAILED; exit 2; }
  cmake --build build --config Release -j 32 --target llama-server
  echo "BUILD_RC=$?"
fi
ls -la "$BIN" 2>/dev/null || { echo BUILD_FAILED; exit 1; }
LIBDIRS=$(find "$SRC/build" -name '*.so' -printf '%h\n' 2>/dev/null | sort -u | tr '\n' ':')
echo "LIBDIRS=$LIBDIRS"
export LD_LIBRARY_PATH="${LIBDIRS}${LD_LIBRARY_PATH}"

# ---- serve on the GPU (native; driver libcuda.so.1 is on the node, CUDA libs via LD path) ----
"$BIN" -m "$GGUF" --host 127.0.0.1 --port $PORT --ctx-size 8192 --n-gpu-layers 999 \
  > $SCRATCH/llama-gpu.log 2>&1 &
LLPID=$!
echo "gpu server pid=$LLPID"

HEALTH=no
for i in $(seq 1 90); do
  if curl -sf http://127.0.0.1:$PORT/health >/dev/null 2>&1; then HEALTH=ok; echo "HEALTH_OK after ${i}x5s"; break; fi
  if ! kill -0 $LLPID 2>/dev/null; then echo "SERVER_DIED at ${i}x5s"; tail -50 $SCRATCH/llama-gpu.log; exit 3; fi
  sleep 5
done
[ "$HEALTH" != ok ] && { echo HEALTH_FAILED; tail -50 $SCRATCH/llama-gpu.log; kill $LLPID 2>/dev/null; exit 2; }

echo "=== gpu chat smoke ==="
curl -s http://127.0.0.1:$PORT/v1/chat/completions -H "Content-Type: application/json" \
  -d '{"model":"qwen3.6-27b-heretic-v2","messages":[{"role":"user","content":"reply with the single word ready /no_think"}],"max_tokens":64}'
echo ""

echo "=== decepticon narrate (GPU, real model_client.narrate_attack_chain) ==="
export DECEPTICON_MODEL_ENDPOINT_BASE_URL=http://127.0.0.1:$PORT/v1
export DECEPTICON_MODEL_ENDPOINT_MODEL=qwen3.6-27b-heretic-v2
cd "$SCRATCH/ModuleWarden"
singularity exec --bind "$SCRATCH" "$SCRATCH/pytorch57.sif" python3 - <<'PY'
import importlib.util, sys
from pathlib import Path
p = Path("finetune/python/decepticon/model_client.py")
spec = importlib.util.spec_from_file_location("dc_mc", p)
mc = importlib.util.module_from_spec(spec); sys.modules[spec.name] = mc
spec.loader.exec_module(mc)
print("configured:", mc.is_configured())
chain = {
  "chain": "Initial Access to Credential Access to Exfiltration",
  "technique_ids": ["T1195.002", "T1552.001", "T1041"],
  "steps": [
    {"tactic": "Initial Access", "technique_id": "T1195.002", "procedure": "A postinstall hook runs at dependency install time."},
    {"tactic": "Credential Access", "technique_id": "T1552.001", "procedure": "Reads env vars and credential files in the install context."},
    {"tactic": "Exfiltration", "technique_id": "T1041", "procedure": "Opens an undeclared outbound connection."},
  ],
}
out = mc.narrate_attack_chain(chain, package="evil-postinstall@2.0.0")
print("NARRATION_START")
print(out)
print("NARRATION_END")
PY
echo "NARRATE_RC=$?"

echo "=== gpu throughput ==="
grep -E "eval time|tokens per second|prompt eval" $SCRATCH/llama-gpu.log | tail -4
kill $LLPID 2>/dev/null
echo "MW_GPU_SMOKE_DONE"
