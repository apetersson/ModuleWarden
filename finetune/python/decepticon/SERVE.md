# Decepticon serve recipe: run the pre-abliterated heretic-v2 GGUF (no re-abliteration)

Decepticon is inference-only. It narrates the deterministic ATT&CK kill chain for
blue-team detection testing. It does not train and it does not abliterate: the
heretic-v2 GGUF is already abliterated, so you serve it as-is and point the client
at it. `model_client.py` POSTs to whatever OpenAI-compatible server you stand up.

Model: `llmfan46/Qwen3.6-27B-uncensored-heretic-v2-Native-MTP-Preserved-GGUF`
(Apache-2.0, heretic v1.3.0 MPOA abliteration of `Qwen/Qwen3.6-27B`).

Quant guide for a 27B model:
- `Q5_K_M` about 19 to 20 GB VRAM, best quality/size balance. Default pick.
- `Q4_K_M` about 16 GB, if you are tighter on VRAM.
- A 24 GB or 32 GB card runs Q5_K_M comfortably.

## Step 1: download one quant

```bash
pip install -U "huggingface_hub[cli]"
# grab a single quant file, not the whole repo
huggingface-cli download \
  llmfan46/Qwen3.6-27B-uncensored-heretic-v2-Native-MTP-Preserved-GGUF \
  --include "*Q5_K_M*.gguf" \
  --local-dir ./heretic-v2
```

## Step 2a: serve with llama.cpp

```bash
# build or install llama.cpp first (provides llama-server)
llama-server \
  -m ./heretic-v2/*Q5_K_M*.gguf \
  --host 127.0.0.1 --port 8081 \
  --ctx-size 8192 \
  --n-gpu-layers 999          # offload all layers to GPU; drop if CPU-only

export DECEPTICON_MODEL_ENDPOINT_BASE_URL=http://127.0.0.1:8081/v1
export DECEPTICON_MODEL_ENDPOINT_MODEL=qwen3.6-27b-heretic-v2
```

## Step 2b: or serve with ollama

```bash
# Modelfile in ./heretic-v2/
printf 'FROM ./%s\n' "$(ls ./heretic-v2/*Q5_K_M*.gguf | xargs -n1 basename)" > ./heretic-v2/Modelfile
ollama create heretic-v2 -f ./heretic-v2/Modelfile

export DECEPTICON_MODEL_ENDPOINT_BASE_URL=http://127.0.0.1:11434/v1
export DECEPTICON_MODEL_ENDPOINT_MODEL=heretic-v2
```

## Step 3: verify the endpoint

```bash
curl -s "$DECEPTICON_MODEL_ENDPOINT_BASE_URL/chat/completions" \
  -H "Content-Type: application/json" \
  -d '{"model":"'"$DECEPTICON_MODEL_ENDPOINT_MODEL"'","messages":[{"role":"user","content":"reply with the single word ready"}],"max_tokens":8}' \
  | python -m json.tool
```

Expect a JSON response with a `choices[0].message.content` field.

## Step 4: smoke-test Decepticon narration

From the repo root, with the env vars set:

```bash
python - <<'PY'
import importlib.util, sys
from pathlib import Path
p = Path("finetune/python/decepticon/model_client.py")
spec = importlib.util.spec_from_file_location("dc_mc", p)
mc = importlib.util.module_from_spec(spec); sys.modules[spec.name] = mc
spec.loader.exec_module(mc)

print("configured:", mc.is_configured())
print("requires_abliteration:", mc.requires_abliteration())  # always False

# a pinned chain shaped like mapper.kill_chain_narrative() output
chain = {
    "chain": "Initial Access to Credential Access to Exfiltration",
    "technique_ids": ["T1195.002", "T1552.001", "T1041"],
    "steps": [
        {"tactic": "Initial Access", "technique_id": "T1195.002",
         "procedure": "A postinstall hook runs at dependency install time."},
        {"tactic": "Credential Access", "technique_id": "T1552.001",
         "procedure": "Reads env vars and credential files in the install context."},
        {"tactic": "Exfiltration", "technique_id": "T1041",
         "procedure": "Opens an undeclared outbound connection."},
    ],
}
print(mc.narrate_attack_chain(chain, package="evil-postinstall@2.0.0"))
PY
```

The technique ids stay pinned by the deterministic mapper; the GGUF only narrates
them. If the endpoint is not configured, the client raises rather than faking a
narrative (no silent degrade).

## On Leonardo HPC (validated 2026-05-30 on a08trc01)

Decepticon serves the heretic-v2 GGUF with llama.cpp. The GGUF is pre-staged in each
account's scratch at `$SCRATCH/models/decepticon-heretic-v2-gguf/` (a08trc01 and
a08trc02). Re-fetch on the login node (direct internet, no proxy):
`MODELS_DIR=$SCRATCH/models ./fetch-models.sh --decepticon-gguf`.

Two GPU constraints had to be solved together. Both paths below are validated end to
end (build/serve, `/health`, and `model_client` narrating the pinned chain
T1195.002 -> T1552.001 -> T1041):

- `qwen35` is a hybrid attention+SSM (Mamba-style) arch that only the latest llama.cpp
  can build. The CUDA-matched `llama-cpp-python` cu124 wheel (0.3.23) reads the GGUF
  metadata then fails to load it.
- The A100 driver is 535.x / CUDA 12.2. The prebuilt `*-cuda` llama.cpp container ships
  a newer CUDA with no sm_80 cubin, so it PTX-JITs at warmup and dies with "a PTX JIT
  compilation failed".

### GPU (recommended, about 44 tok/s)

Build the latest llama.cpp against Leonardo's native CUDA 12.2 toolkit with
`CMAKE_CUDA_ARCHITECTURES=80`. Native sm_80 SASS means no PTX JIT (runs on the 12.2
driver), and latest-source means qwen35 builds. Two Leonardo quirks: the cuda/12.2
module is gcc-8.5 based and does not put nvcc on PATH, so point at the toolkit
directly; and gcc 8.5 keeps `std::filesystem` in a separate lib, so add `-lstdc++fs`.
Build on a compute node (the login node OOM-kills heavy builds).

    git clone --depth 1 https://github.com/ggml-org/llama.cpp $SCRATCH/llama.cpp-src   # login node, has internet
    # then in a GPU job:
    CUROOT=/leonardo/prod/opt/compilers/cuda/12.2/none
    export PATH=$CUROOT/bin:$PATH LD_LIBRARY_PATH=$CUROOT/lib64:$LD_LIBRARY_PATH
    cmake -B build -DGGML_CUDA=ON -DCMAKE_CUDA_ARCHITECTURES=80 -DLLAMA_CURL=OFF \
          -DGGML_NATIVE=OFF -DCMAKE_BUILD_TYPE=Release -DCMAKE_CUDA_HOST_COMPILER=/usr/bin/g++ \
          -DCMAKE_CXX_STANDARD_LIBRARIES=-lstdc++fs
    cmake --build build -j 32 --target llama-server
    build/bin/llama-server -m "$G" --host 127.0.0.1 --port 8000 --ctx-size 8192 --n-gpu-layers 999

`finetune/python/slurm/leonardo/decepticon_gpu_build_serve.slurm` is the validated
build+serve+narrate job (builds once, then the binary is cached for re-runs).

### CPU (no build, about 2-3 tok/s)

If you would rather not build, serve on CPU with the prebuilt latest CPU image. Fine
for low-volume offense narration.

    cd $SCRATCH
    export SINGULARITY_CACHEDIR=$SCRATCH/.sing_cache SINGULARITY_TMPDIR=$SCRATCH/.sing_tmp
    singularity pull llamacpp-cpu.sif docker://ghcr.io/ggml-org/llama.cpp:server
    G=$SCRATCH/models/decepticon-heretic-v2-gguf/Qwen3.6-27B-uncensored-heretic-v2-Native-MTP-Preserved-Q5_K_M.gguf
    singularity exec --bind $SCRATCH --env LD_LIBRARY_PATH=/app $SCRATCH/llamacpp-cpu.sif \
      /app/llama-server -m "$G" --host 127.0.0.1 --port 8000 --ctx-size 8192 --n-gpu-layers 0 -t 32

`finetune/python/slurm/leonardo/decepticon_smoke.slurm` is the validated CPU reference job.

### Point Decepticon at the server (either path)

    export DECEPTICON_MODEL_ENDPOINT_BASE_URL=http://127.0.0.1:8000/v1
    export DECEPTICON_MODEL_ENDPOINT_MODEL=qwen3.6-27b-heretic-v2
    python -m finetune.python.decepticon.config_check        # model_endpoint PASS
    python -m finetune.python.decepticon.adversary -n 200 --use-model --out finetune/corpus/hard-negatives.jsonl

heretic-v2 is a reasoning model whose chat template emits a `<think>` block, so the
narration can land in `reasoning_content` with an empty `content`. `model_client`
falls back to `reasoning_content`, so the narration is never dropped.

The deterministic Decepticon core (coverage, adversary without `--use-model`, the
preflight) needs no model and runs on the login node.

Note: the HTTP proxy creds committed in `docs/leonardo-docs/slides.md` are stale (they
401) and unnecessary, since login nodes reach HuggingFace directly. Treat the committed
copy as needing a scrub; secrets belong in `.leonardo-access`, not git.

## Why no abliteration step here

The GGUF is already abliterated (heretic-v2). Decepticon is offense-side narration
for our own testing, run via inference only, so it consumes the GGUF as-is. The
auditor model is the one we abliterate ourselves (official `Qwen/Qwen3.6-27B`),
because the auditor is fine-tuned and produces the customer-facing verdict. See
`finetune/FINETUNING-METHOD.md` for the two-model-role split.
