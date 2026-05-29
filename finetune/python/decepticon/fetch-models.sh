#!/usr/bin/env bash
# Fetch ModuleWarden models directly from HuggingFace into a defined location.
#
# Run this on the Leonardo serial/login node. The weights land in $MODELS_DIR on
# scratch and the GPU job reads them from there. Do NOT route the weights through a
# laptop: the bf16 is ~56 GB and the disk fills fast.
#
# Leonardo needs the HTTP proxy for outbound internet, or HuggingFace is
# unreachable. Export it first (credentials in docs/leonardo-docs/slides.md):
#   export HTTP_PROXY=... HTTPS_PROXY=... http_proxy=... https_proxy=...
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

DEC_BF16_REPO="llmfan46/Qwen3.6-27B-uncensored-heretic-v2-Native-MTP-Preserved"
DEC_GGUF_REPO="llmfan46/Qwen3.6-27B-uncensored-heretic-v2-Native-MTP-Preserved-GGUF"
DEC_GGUF_FILE="Qwen3.6-27B-uncensored-heretic-v2-Native-MTP-Preserved-Q5_K_M.gguf"
AUDITOR_BASE_REPO="Qwen/Qwen3.6-27B"

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

command -v huggingface-cli >/dev/null 2>&1 || {
  echo "huggingface-cli missing. Install: pip install -U 'huggingface_hub[cli]'"
  exit 1
}
mkdir -p "$MODELS_DIR"

dl() {  # repo subdir [extra-args...]
  local repo="$1" sub="$2"; shift 2
  echo ">> $repo -> $MODELS_DIR/$sub"
  huggingface-cli download "$repo" "$@" --local-dir "$MODELS_DIR/$sub"
}

[ "$want_bf16" = 1 ] && dl "$DEC_BF16_REPO" decepticon-heretic-v2-bf16
[ "$want_gguf" = 1 ] && dl "$DEC_GGUF_REPO" decepticon-heretic-v2-gguf --include "$DEC_GGUF_FILE"
[ "$want_base" = 1 ] && dl "$AUDITOR_BASE_REPO" qwen3.6-27b-base

echo
echo "done. Serving for Decepticon:"
echo "  bf16 + vLLM : --model $MODELS_DIR/decepticon-heretic-v2-bf16"
echo "  gguf + llama: -m $MODELS_DIR/decepticon-heretic-v2-gguf/$DEC_GGUF_FILE"
echo "Then: export DECEPTICON_MODEL_ENDPOINT_BASE_URL=http://localhost:8081/v1"
echo "      export DECEPTICON_MODEL_ENDPOINT_MODEL=heretic-v2"
echo "      python -m finetune.python.decepticon.config_check   # expect all PASS"
