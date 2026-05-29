# Leonardo Integration Plan — ModuleWarden Agentic Audits

## Goal

Replace the current `audit-runner` (PI RPC + deepseek/remote model endpoint) with
Leonardo-hosted vLLM serving **qwen3.6 27b**, accessed via SSH tunnel from the
local ModuleWarden stack. Achieve **high parallelism** by running multiple
concurrent audit containers that all query the same vLLM instance on 4× A100 GPUs.

## Architecture

```
┌─ Local (Mac) ──────────────────────────────────────────────┐
│  docker compose up                                          │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌───────────┐  │
│  │ postgres │  │verdaccio │  │ searxng  │  │  web-ui   │  │
│  └──────────┘  └──────────┘  └──────────┘  └───────────┘  │
│  ┌──────────┐  ┌───────────────────────────────────────┐   │
│  │api-proxy │  │ worker → audit containers (×N)         │   │
│  └──────────┘  │   each runs PI RPC → SSH tunnel ───┐  │   │
│                └─────────────────────────────────────┘  │   │
│                                                        │   │
│  ┌──────────────────────────────────────────────────┐  │   │
│  │ SSH tunnel (localhost:8081 → leonardo:8000)       │  │   │
│  └──────────────────────────────────────────────────┘  │   │
└───────────────────────────────────┬─────────────────────┘
                                    │ SSH
┌─ Leonardo ────────────────────────┼─────────────────────┐
│  login node                       │                     │
│                                   ▼                     │
│  ┌─ compute node (Slurm job) ───────────────────────┐   │
│  │  Singularity: vllm-openai                         │   │
│  │  Model: qwen3.6 27b (4× A100 64GB, TP=4)         │   │
│  │  API: http://node:8000/v1                         │   │
│  │  Weights: $SCRATCH/models/qwen3.6-27b/            │   │
│  └──────────────────────────────────────────────────┘   │
│                                                         │
│  $SCRATCH/modulewarden/                                  │
│  ├── models/         (cached weights)                    │
│  ├── audits/         (optional evidence staging)        │
│  └── sessions/       (optional session archives)        │
└─────────────────────────────────────────────────────────┘
```

## Key Design Decisions

### 1. PI stays as the agentic driver
PI already handles RPC mode, tool calls, streaming, and model interaction.
We configure it to use an OpenAI-compatible provider pointing at the vLLM
endpoint. No custom agent rewrite needed.

### 2. vLLM on Leonardo, everything else local
- ModuleWarden control plane (postgres, worker, api-proxy, web-ui) stays local
- Only LLM inference moves to Leonardo
- Audit containers still run locally (Docker), hitting Leonardo via SSH tunnel
- This avoids the complexity of moving the full audit pipeline to HPC

### 3. High parallelism via concurrent audit containers
- vLLM with 4× A100 64GB can serve qwen3.6 27b with TP=4
- Agentic audit is I/O-bound (tool calls, web search, file I/O)
- The LLM can handle many concurrent requests while agents wait for tools
- Target: 8-16 concurrent audit jobs hitting one vLLM instance

### 4. Scratch region for model weights + optional staging
- Model weights: `$SCRATCH/models/qwen3.6-27b/` (downloaded once, reused)
- Audit evidence: `$SCRATCH/modulewarden/audits/` (optional, for persistence)
- vLLM container runs from $SCRATCH for fast model loading

## Implementation Phases

### Phase 1: vLLM Deployment on Leonardo
Files:
- `scripts/leonardo/slurm-vllm.sh` — Slurm batch script
- `scripts/leonardo/deploy-vllm.sh` — One-shot deploy wrapper
- `scripts/leonardo/vllm-health-check.sh` — Verify endpoint

### Phase 2: SSH Tunnel
Files:
- `scripts/leonardo/tunnel.sh` — Establish + maintain SSH tunnel

### Phase 3: Orchestrator Update
Files:
- `packages/audit-runner/src/orchestrator.ts` — Generalize provider support
- PI models.json for container — Register vLLM endpoint as a provider

### Phase 4: Configuration
Files:
- `.env` — Leonardo model endpoint config
- `docker-compose.yml` — Already passes MW_MODEL_ENDPOINT_* vars

### Phase 5: Bring-up Script
Files:
- `scripts/bring-up.sh` — Full stack with Leonardo

## Configuration

```bash
# .env additions/changes
MW_MODEL_ENDPOINT_BASE_URL=http://host.docker.internal:8081/v1
MW_MODEL_ENDPOINT_API_KEY=vllm
MW_MODEL_ENDPOINT_MODEL=qwen3.6-27b
MW_JOB_CONCURRENCY_AUDIT_CONTAINER_EXEC=8  # High parallelism
```

## Model Details: qwen3.6 27b

- Parameters: 27B (fits on 2× A100 64GB, use 4× for throughput)
- Context window: 128K tokens
- Strong at reasoning, code analysis, tool use
- OpenAI-compatible API via vLLM
- HuggingFace: Qwen/Qwen3.6-27B (or similar identifier)
