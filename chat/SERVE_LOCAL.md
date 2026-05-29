# Flip the live-model badge green for rehearsal

The chat narrates the underwriting verdict with a live model when a model
endpoint is configured. The verdict itself is always pinned by the
deterministic gate plus the audit report; the model only puts it in
underwriter language. That means ANY OpenAI-compatible endpoint makes the
badge green and the demo stays safe, because the model can never change the
verdict (a test asserts this).

There is no shipped fine-tuned checkpoint on this box (the A100 run was a
smoke test). For rehearsal, point the endpoint at any local server. The
honest on-stage line is: "the verdict is deterministic; the narration is
model-generated, and in production that model is the fine-tune."

## Option A - Ollama (easiest on Windows)

```powershell
# one-time: install from https://ollama.com, then
ollama pull qwen2.5-coder:7b      # or any instruct model you have
ollama serve                       # serves an OpenAI-compatible API on :11434
```

Point the chat at it (Ollama exposes `/v1` OpenAI-compatible):

```powershell
$env:MW_MODEL_ENDPOINT_BASE_URL = "http://localhost:11434/v1"
$env:MW_MODEL_ENDPOINT_API_KEY  = "ollama"          # any non-empty string
$env:MW_MODEL_ENDPOINT_MODEL    = "qwen2.5-coder:7b"
```

## Option B - vLLM (if serving real weights, e.g. on Leonardo)

```bash
python -m vllm.entrypoints.openai.api_server \
  --model /path/to/checkpoint --served-model-name modulewarden-finetune --port 8000
```

```powershell
$env:MW_MODEL_ENDPOINT_BASE_URL = "http://<host>:8000/v1"
$env:MW_MODEL_ENDPOINT_API_KEY  = "x"
$env:MW_MODEL_ENDPOINT_MODEL    = "modulewarden-finetune"
```

## Verify before you walk on

```powershell
python -m chat.check_endpoint
```

- Exit 0 with "LIVE" means the badge will be green.
- Exit 0 with "DETERMINISTIC MODE" means no endpoint is set (still demo-safe).
- Exit 1 means an endpoint is set but unreachable. Fix it or unset the vars
  to fall back cleanly to the deterministic memo.

Then run the UI:

```powershell
streamlit run chat/app.py
```

The title badge shows live-model vs deterministic. To go back to the safe
offline mode, clear the vars:

```powershell
Remove-Item Env:MW_MODEL_ENDPOINT_BASE_URL, Env:MW_MODEL_ENDPOINT_API_KEY, Env:MW_MODEL_ENDPOINT_MODEL
```
