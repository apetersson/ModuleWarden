#!/usr/bin/env bash
# Fetch ModuleWarden models directly from HuggingFace into a defined location.
#
# Run this on the Leonardo serial/login node. The weights land in $MODELS_DIR on
# scratch and the GPU job reads them from there. Do NOT route the weights through a
# laptop: the bf16 is ~56 GB and the disk fills fast.
#
# Run this on a Leonardo LOGIN/SERIAL node. Those have direct outbound internet
# (verified 2026-05-30: HTTP 200 to huggingface.co from the login node), so no proxy
# is needed. The old HTTP proxy in docs/leonardo-docs/slides.md is for COMPUTE nodes
# only and its credentials rotate (they 401 once the proxy restarts), so do not rely
# on it here. Compute nodes have no internet; always stage on the login node first.
#
# Sizes (measured 2026-05-30 from the HF API):
#   Decepticon bf16 (vLLM)        ~55.6 GB
#   Decepticon GGUF Q5_K_M (llama)  ~19.7 GB  (single file)
#   Auditor base Qwen3.6-27B       ~55.6 GB  (we abliterate this ourselves)
#
# Usage (pick what the role needs):
#   MODELS_DIR=$SCRATCH/models ./fetch-models.sh --decepticon-bf16   # vLLM on Leonardo
#   MODELS_DIR=$SCRATCH/models ./fetch-models.sh --decepticon-gguf   # llama.cpp / smaller
#   MODELS_DIR=$SCRATCH/models ./fetch-models.sh --auditor-base      # base we abliterate
#   MODELS_DIR=$SCRATCH/models ./fetch-models.sh --all
set -euo pipefail

MODELS_DIR="${MODELS_DIR:-./models}"

# Canonical pre-abliterated checkpoint per CLAUDE.md. Shared by the auditor and Decepticon.
DEC_BF16_REPO="huihui-ai/Huihui-Qwen3.6-27B-abliterated"
AUDITOR_BASE_REPO="huihui-ai/Huihui-Qwen3.6-27B-abliterated"
# Optional alternative: a heretic-v2 GGUF for local llama.cpp (different abliteration lineage)
DEC_GGUF_REPO="llmfan46/Qwen3.6-27B-uncensored-heretic-v2-Native-MTP-Preserved-GGUF"
DEC_GGUF_FILE="Qwen3.6-27B-uncensored-heretic-v2-Native-MTP-Preserved-Q5_K_M.gguf"

want_bf16=0; want_gguf=0; want_base=0
for a in "$@"; do
  case "$a" in
    --decepticon-bf16) want_bf16=1 ;;
    --decepticon-gguf) want_gguf=1 ;;
    --auditor-base)    want_base=1 ;;
    --all)             want_bf16=1; want_gguf=1; want_base=1 ;;
    *) echo "unknown arg: $a"; exit 2 ;;
  esac
done
if [ "$want_bf16$want_gguf$want_base" = "000" ]; then
  echo "pick at least one: --decepticon-bf16 | --decepticon-gguf | --auditor-base | --all"
  exit 2
fi

command -v hf >/dev/null 2>&1 || {
  echo "hf CLI missing. Install: pip install -U 'huggingface_hub[cli]'"
  exit 1
}
mkdir -p "$MODELS_DIR"

# bf16 weights for vLLM: download into the HF cache under $MODELS_DIR so the vLLM
# job finds them via --model <repo-id>. scripts/leonardo/slurm-vllm.sh binds
# MODEL_CACHE=$SCRATCH/models as the HF cache, so set MODELS_DIR=$SCRATCH/models.
dl_cache() {  # repo
  echo ">> $1 -> HF cache under $MODELS_DIR"
  hf download "$1" --cache-dir "$MODELS_DIR"
}
# raw GGUF file for local llama.cpp (not the HF cache layout)
dl_file() {  # repo subdir extra...
  local repo="$1" sub="$2"; shift 2
  echo ">> $repo -> $MODELS_DIR/$sub"
  hf download "$repo" "$@" --local-dir "$MODELS_DIR/$sub"
}

[ "$want_bf16" = 1 ] && dl_cache "$DEC_BF16_REPO"
[ "$want_gguf" = 1 ] && dl_file "$DEC_GGUF_REPO" decepticon-heretic-v2-gguf --include "$DEC_GGUF_FILE"
# auditor base is the same checkpoint as the bf16 (huihui-ai); skip if already pulled
[ "$want_base" = 1 ] && [ "$want_bf16" != 1 ] && dl_cache "$AUDITOR_BASE_REPO"

echo
echo "done. The bf16 is in the HF cache under $MODELS_DIR."
echo "vLLM finds it via --model $DEC_BF16_REPO when MODEL_CACHE=$MODELS_DIR"
echo "(scripts/leonardo/slurm-vllm.sh already wires that up)."
echo "gguf (local llama.cpp): -m $MODELS_DIR/decepticon-heretic-v2-gguf/$DEC_GGUF_FILE"
