#!/bin/bash
#SBATCH --account=euhpc_d30_031
#SBATCH --partition=boost_usr_prod
#SBATCH --reservation=s_tra_ncc
#SBATCH --nodes=1
#SBATCH --ntasks-per-node=1
#SBATCH --gpus-per-task=2
#SBATCH --mem=120GB
#SBATCH --cpus-per-task=16
#SBATCH --time=0:30:00
#SBATCH --job-name=mw-llama-serve
#SBATCH --output=mw-llama-serve-%j.out
#SBATCH --error=mw-llama-serve-%j.err

set -euo pipefail
S="/leonardo_scratch/large/usertrain/${USER}"
GGUF="$S/models/decepticon-heretic-v2-gguf/Qwen3.6-27B-uncensored-heretic-v2-Native-MTP-Preserved-Q5_K_M.gguf"
SRC="$S/llama.cpp-src"
BIN="$SRC/build/bin/llama-server"
CUROOT=/leonardo/prod/opt/compilers/cuda/12.2/none
export PATH=$CUROOT/bin:$PATH
export LD_LIBRARY_PATH=$CUROOT/lib64:${LD_LIBRARY_PATH:-}
CMAKE=cmake

echo "=== ModuleWarden llama.cpp serve ==="
echo "Job: ${SLURM_JOB_ID} on $(hostname)"

# One-time build of llama.cpp
if [ ! -x "$BIN" ]; then
  echo "Building llama.cpp (one-time, ~10 min)..."
  cd "$SRC"
  "$CMAKE" -B build -DGGML_CUDA=ON -DCMAKE_CUDA_ARCHITECTURES=80 -DLLAMA_CURL=OFF \
      -DGGML_NATIVE=OFF -DCMAKE_BUILD_TYPE=Release -DLLAMA_BUILD_TESTS=OFF \
      -DLLAMA_BUILD_EXAMPLES=OFF -DLLAMA_BUILD_TOOLS=ON -DCMAKE_CUDA_HOST_COMPILER=/usr/bin/g++ \
      -DCMAKE_CXX_STANDARD_LIBRARIES=-lstdc++fs
  "$CMAKE" --build build --config Release -j 16 --target llama-server
  echo "Build done."
fi

echo "Starting llama-server..."
"$BIN" -m "$GGUF" --host 0.0.0.0 --port 8000 --ctx-size 32768 --n-gpu-layers 999 --chat-template chatml
