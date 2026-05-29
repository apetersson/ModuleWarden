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

## On Leonardo HPC (reuse scripts/leonardo, do not run a parallel job)

Andreas already has the Leonardo deploy in `scripts/leonardo/`. Decepticon reuses
it. The serve script is parameterized, so pointing it at the abliterated checkpoint
is a one-variable override (`MW_VLLM_MODEL`). vLLM runs on a compute node via
Singularity (TP=4 across 4 A100s, port 8000); you reach it locally through an SSH
tunnel on port 8081. The model downloads inside the job through the Leonardo HTTP
proxy, so no manual fetch is required (`fetch-models.sh` is an optional login-node
pre-cache).

Model: `huihui-ai/Huihui-Qwen3.6-27B-abliterated`, the chosen pre-abliterated
checkpoint per CLAUDE.md (Apache 2.0, bf16). Decepticon and the auditor share it.

1. Deploy vLLM with the abliterated checkpoint:

    MW_VLLM_MODEL=huihui-ai/Huihui-Qwen3.6-27B-abliterated \
    MW_VLLM_MODEL_NAME=qwen3.6-27b-abliterated \
    sbatch scripts/leonardo/slurm-vllm.sh

2. Find the node and open the tunnel (localhost:8081 maps to node:8000):

    squeue --me
    scripts/leonardo/tunnel.sh <compute-node>

3. Health-check, then point Decepticon at the tunnel:

    scripts/leonardo/vllm-health-check.sh http://localhost:8081
    export DECEPTICON_MODEL_ENDPOINT_BASE_URL=http://localhost:8081/v1
    export DECEPTICON_MODEL_ENDPOINT_MODEL=qwen3.6-27b-abliterated

4. Preflight, then generate:

    python -m finetune.python.decepticon.config_check        # model_endpoint now PASS
    python -m finetune.python.decepticon.adversary -n 200 --use-model \
        --out finetune/corpus/hard-negatives.jsonl

The auditor uses the same chosen checkpoint `huihui-ai/Huihui-Qwen3.6-27B-abliterated`
(pre-abliterated per CLAUDE.md, then SFT LoRA), so no in-repo abliteration step is
needed. The deterministic Decepticon core (coverage, adversary without `--use-model`,
the preflight) needs no GPU and runs on the login node.

Security note: `scripts/leonardo/` currently has the HTTP proxy credentials inline.
The repo is private so it is contained, but those belong in `.leonardo-access` or an
env file (as the Leonardo login password already does), with the committed copies
scrubbed.

## Why no abliteration step here

The GGUF is already abliterated (heretic-v2). Decepticon is offense-side narration
for our own testing, run via inference only, so it consumes the GGUF as-is. The
auditor model is the one we abliterate ourselves (official `Qwen/Qwen3.6-27B`),
because the auditor is fine-tuned and produces the customer-facing verdict. See
`finetune/FINETUNING-METHOD.md` for the two-model-role split.
