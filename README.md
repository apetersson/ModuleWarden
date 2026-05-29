# ModuleWarden

Private agentic version-diff gate for npm packages.

ModuleWarden intercepts npm install requests, fetches upstream package metadata, audits version changes using static analysis and (optionally) PI agentic review, then serves only approved package versions. It catches compromised-package versions before they reach developers.

## Threat Model

ModuleWarden defends against one primary attack: **a legitimate popular package maintainer or maintainer account is compromised and publishes a malicious new version that should not spread into the organization.**

Non-goals:
- Generic package sovereignty or "replace npm"
- Auditing every package in the registry like a human reviewer
- Preventing novel zero-day exploits in benign packages
- Malicious package *authors* (first publish) — only *version updates* to packages already in the dependency graph

The defensible thesis: *private, agentic, version-diff review of package updates in the organization's used dependency graph.* A version diff against a last-known-good predecessor is a bounded, reviewable change. Static heuristics catch the obvious patterns. Agentic review catches behavioral changes, capability creep, and intent mismatches.

## Architecture Overview

```
┌──────────────┐     ┌──────────────────┐     ┌─────────────┐
│  npm client   │────▶│  ModuleWarden     │────▶│  Verdaccio   │
│  (pnpm/npm)   │     │  API Proxy        │     │  (registry)  │
└──────────────┘     │  (Fastify)        │     └─────────────┘
                     │  :8080            │
                     └────────┬─────────┘
                              │
                     ┌────────▼─────────┐     ┌──────────────────┐
                     │  Worker           │────▶│  Audit Container  │
                     │  (pg-boss jobs)   │     │  (Docker)         │
                     │                   │     │  - RPC bridge     │
                     │  ┌─────────────┐  │     │  - PI agent       │
                     │  │ Postgres    │  │     │  - Static checks  │
                     │  │ (Prisma)    │  │     └──────────────────┘
                     │  └─────────────┘  │
                     │                   │
                     │  ┌─────────────┐  │
                     │  │ Web UI      │  │
                     │  │ (React/Vite)│  │
                     │  └─────────────┘  │
                     └──────────────────┘
```

**Key design decisions:**
- **Approved-only metadata**: npm clients see only currently allowed versions. Dist-tags are rewritten to the newest approved version.
- **pg-boss for durability**: All job orchestration uses Postgres-backed pg-boss. No Redis.
- **Per-job Docker isolation**: Each audit runs in a disposable container with recorded-open egress (network allowed, metadata captured).
- **Agent-final**: PI can allow, block, or quarantine without mandatory human approval. Override only via security-admin tokens.
- **Private core prompts**: Hidden from developers, package authors, and package code. Never exposed through CLI, web UI, or audit artifacts.
- **Cold-start policy**: New packages (no predecessor) receive conservative full-package review. Missing or ambiguous evidence → quarantine.

## Verdict Semantics

### ALLOW
- The exact package version hash is approved for install.
- Any other hash for the same version string is NOT approved.
- The tarball is promoted from upstream npm to Verdaccio.
- npm clients can install this version.

### BLOCK
- The version is blocked by security policy.
- npm clients receive a clear error with status guidance.
- Only security-admin override can change this.

### QUARANTINE
- The version is suspicious but not confirmed malicious.
- Not served to developers.
- Human review recommended.
- Security-admin override available.

## Getting Started

```bash
# 1. Start the stack
cp .env.example .env
docker compose up -d

# 2. Import your project's lockfile
modulewarden preflight pnpm-lock.yaml

# 3. Check audit progress
modulewarden status

# 4. Configure npm/pnpm to use ModuleWarden
# (port 8080, set via MW_API_PORT)
npm config set registry http://localhost:8080/
pnpm config set registry http://localhost:8080/
```

## 60-Second Live Demo

No docker, no network, no API keys. Replay three confirmed npm
supply-chain incidents through the deterministic gate plus cited model
verdict, and have the Control Evidence Memo dropped on disk:

```bash
python -m demo.run_incident_replay --list
python -m demo.run_incident_replay --incident postmark-mcp-1.0.16   # BLOCK
python -m demo.run_incident_replay --incident postmark-mcp-1.0.12   # ALLOW
python -m demo.run_incident_replay --incident lodash-4.17.21        # ALLOW
ls demo/outputs/                                                     # 3 memos
```

See [`demo/README.md`](demo/README.md) for the full demo recipe.

## Conversational Underwriter Assistant

Same audit pipeline, conversational wrapper aimed at a cyber-policy
underwriter or claims analyst:

```bash
# Headless CLI (no UI deps)
python -m chat.cli "look up postmark-mcp@1.0.16"
python -m chat.cli "what are the gate rules?"

# Streamlit UI
pip install -r chat/requirements.txt
streamlit run chat/app.py
```

See [`chat/README.md`](chat/README.md) for the architecture and the
optional LLM-augmented path.

## Prerequisites

- Docker & Docker Compose
- Node.js 20+
- pnpm 9+

## Development

```bash
# Install
pnpm install

# Build (generates the Prisma client first, then compiles every package)
pnpm -r build

# Test
pnpm -r test

# Start stack
docker compose up -d

# Start worker (separate terminal)
cd packages/worker && npx tsx src/index.ts
```

Build notes (read this before concluding "it does not compile"):

- `pnpm -r build` is self-sufficient from a clean clone. The
  `@modulewarden/prisma-client` build runs `prisma generate` before `tsc`, so
  the worker and api-proxy get the generated `Prisma.*` types. If you run
  `tsc` in `packages/worker` or `packages/api-proxy` directly WITHOUT first
  generating the client, you will see spurious errors like
  `Prisma has no exported member 'InputJsonValue'` and many implicit-`any`s.
  Run `pnpm generate` (or `pnpm -r build`) first.
- `packages/web-ui` build needs `VITE_MW_API_BASE_URL` at build time. Docker
  Compose sets it automatically; for a standalone build use
  `VITE_MW_API_BASE_URL=http://localhost:8080 pnpm --filter @modulewarden/web-ui build`.

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `MW_API_PORT` | `8080` | API proxy port |
| `MW_POSTGRES_HOST` | `postgres` | Postgres hostname |
| `MW_RPC_TOKEN` | (required) | Run-scoped RPC token for audit bridge |
| `MW_AUTH_ADMIN_TOKENS` | (required) | Comma-separated admin override tokens |
| `MW_AUTH_DEV_TOKENS` | (required) | Comma-separated developer tokens |
| `MW_MODEL_ENDPOINT_BASE_URL` | — | OpenAI-compatible model endpoint for PI audits |
| `MW_AUDIT_IMAGE` | `modulewarden-audit-runner` | Docker image for audit containers |

## Package Structure

| Package | Description |
|---------|-------------|
| `packages/shared` | Shared types, config, services |
| `packages/prisma-client` | Postgres schema and data access |
| `packages/api-proxy` | npm proxy, admin, status, internal RPC endpoints |
| `packages/worker` | pg-boss job handlers, container runner |
| `packages/audit-runner` | Docker image for per-job audit containers |
| `packages/audit-rpc-server` | In-container RPC bridge for PI tool endpoints |
| `packages/cli` | Developer CLI |
| `packages/web-ui` | React/Vite admin dashboard |

## License

MIT
