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
| Auditor (abliterated base we SFT) | `huihui-ai/Huihui-Qwen3.6-27B-abliterated` | bf16 (vLLM/HF) | ~55.6 GB |
| Decepticon (offense narration, inference-only) | `llmfan46/Qwen3.6-27B-uncensored-heretic-v2-Native-MTP-Preserved-GGUF`, `Q5_K_M` | GGUF (llama.cpp) | ~19.7 GB |

## Fetch on Leonardo

Run this on a LOGIN/SERIAL node. Those have direct outbound internet (verified
2026-05-30: HTTP 200 to huggingface.co), so no proxy is needed. The fetch uses the
`hf` CLI; the old `huggingface-cli` is deprecated and no longer downloads. Compute
nodes have no internet, so always stage on the login node first.

```
MODELS_DIR=$SCRATCH/models ./fetch-models.sh --auditor-base      # auditor bf16 (huihui)
MODELS_DIR=$SCRATCH/models ./fetch-models.sh --decepticon-gguf   # Decepticon GGUF (heretic-v2)
MODELS_DIR=$SCRATCH/models ./fetch-models.sh --decepticon-bf16   # optional: serve Decepticon from huihui bf16
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
