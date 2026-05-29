# Models for ModuleWarden / Decepticon

The weights are NOT committed to git and NOT mirrored through a laptop (the bf16 is
~56 GB). They are pulled directly from HuggingFace by `fetch-models.sh` on the
Leonardo login node, into `$MODELS_DIR` on scratch, where the GPU job reads them.

A staging folder exists on Nextcloud at `ZeroToOne_Data/models/` holding this doc
and `fetch-models.sh`, so the location is defined and discoverable. The weights
themselves live on HuggingFace (the canonical source); duplicating 56 GB into
Nextcloud or GitHub adds a slow hop with no benefit when Leonardo reaches HF
directly.

## The models

| role | repo | format | size |
|------|------|--------|------|
| Chosen checkpoint (auditor + Decepticon, per CLAUDE.md) | `huihui-ai/Huihui-Qwen3.6-27B-abliterated` | bf16 (vLLM) | ~55.6 GB |
| Alternative local llama.cpp (different abliteration) | `llmfan46/Qwen3.6-27B-uncensored-heretic-v2-...-GGUF`, `Q5_K_M` | GGUF | ~19.7 GB |

## Fetch on Leonardo

Leonardo needs the HTTP proxy for outbound internet, or HuggingFace is unreachable.
Export it first (credentials in `docs/leonardo-docs/slides.md`):

```
export HTTP_PROXY=... HTTPS_PROXY=... http_proxy=... https_proxy=...
MODELS_DIR=$SCRATCH/models ./fetch-models.sh --decepticon-bf16   # vLLM serving
MODELS_DIR=$SCRATCH/models ./fetch-models.sh --decepticon-gguf   # llama.cpp / smaller
MODELS_DIR=$SCRATCH/models ./fetch-models.sh --auditor-base      # base we abliterate
```

Then verify before spending GPU:

```
python -m finetune.python.decepticon.config_check
```

## If Leonardo cannot reach HuggingFace

Some HPC sites firewall outbound traffic. If the login node cannot reach HF, pull
the weights on a machine that can, drop them into `ZeroToOne_Data/models/`, and
rclone or WebDAV them to Leonardo scratch. The fetch script and this doc define the
layout either way.
