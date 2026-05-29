# ModuleWarden v1 Architecture & Threat Model Contract

> This document is the implementation contract for ModuleWarden v1. Every subsequent
> feature task must conform to the architecture, trust boundaries, and non-goals
> defined here. Scope drift beyond this contract requires a formal amendment.

---

## 1. Threat Classification

Supply-chain security incidents fall into three distinct classes. ModuleWarden v1
optimizes for one of them.

### Class A — Compromised-Maintainer Version Bumps

A legitimate, already-trusted npm package maintainer or maintainer account is
compromised, and a malicious new version is published under a real package name.

Normal trust signals remain intact: the package is popular, the maintainer is
real, the version may contain an actual bug fix, and static malware rules may
miss the payload (especially if the attacker knows common public heuristics).

**This is ModuleWarden v1's primary target.**

### Class B — Supply-Chain Malware (Typosquatting, Dependency Confusion)

An attacker publishes a malicious package under a name similar to a popular
package or exploits ambiguous dependency resolution. These attacks are valuable
but are better addressed by name-squatting detection, registry heuristics, and
vendor telemetry. ModuleWarden v1 does not optimize for this class.

### Class C — Novel Vulnerability Discovery

An attacker finds and exploits a zero-day vulnerability in a package. ModuleWarden
v1 may include exploit-discovery prompts and known-pattern checks, but the market
claim is **compromise catcher**, not a general novel-vulnerability oracle. The
defensible advantage is private semantic diff review over bounded version changes,
not unbounded vulnerability scanning.

---

## 2. Core Thesis

For packages an organization already uses, each new version should be reviewed
as a **semantic diff against the last allowed version** before it becomes
installable. This is a smaller and more tractable problem than auditing a whole
package from scratch.

**v1 optimizes for package-version diff review against a previously allowed
predecessor.** The audit question is:

> Does this version introduce behavior that is inconsistent with the package's
> purpose, prior behavior, changelog, or expected capability surface?

Examples of suspicious version deltas:
- A formatting library adds network access.
- A utility package starts reading environment variables.
- A patch release adds a lifecycle script.
- A dependency update redirects through a new maintainer-controlled package.
- A readable codebase suddenly includes obfuscated payloads.
- A benign-looking helper adds `child_process`, `eval`, dynamic imports, native
  binaries, or WASM.
- The tarball diverges materially from the advertised source or release notes.

---

## 3. Why Private Prompts?

Most dependency security systems rely on public static rules, heuristics, and
vendor intelligence. These are valuable but have a fundamental weakness:

> Attackers can test against public rules before publishing. They know which
> patterns trigger alarms and which do not.

**Private prompts change this calculus:**

1. Attackers cannot cheaply test against an organization's exact prompt suite
   and review rubric. Each organization's prompts are unknown to the attacker.
2. Even if the attacker knows the general prompt category, they cannot oracle
   the precise threshold, tool invocation order, or evidence-weighting rules.
3. The private surface is the review process itself, not just the data.
   Public tarballs are reviewed against private rubrics.

The defensive value is **not** about data residency — npm packages are public.
It is that the attacker does not get oracle access to the precise semantic
review process.

---

## 4. Prompt Secrecy Model

### What Is Hidden (v1)

- Core prompt files are hidden from:
  - Package authors and compromised maintainers
  - Developers using ModuleWarden
  - Ordinary organization users
  - Package code running inside audit containers
  - Any network actor without root infrastructure access

### What Is NOT Protected (v1)

- Root infrastructure administrators with direct access to the ModuleWarden
  control plane can read prompt files.
- The trusted model endpoint operator receives prompts as part of inference
  requests. Prompts are not promised to be secret from the model endpoint
  operator in v1.
- If prompt logging is enabled and unverified, the secrecy guarantee degrades:
  logs may expose prompt content to infrastructure operators who manage log
  storage or monitoring systems.

### Logging Controls

- Prompt logging must be configurable (enabled/disabled per deployment).
- When logging is enabled, operators must understand that prompt secrecy is
  reduced to the trust boundary of the logging infrastructure.
- No verified-secure logging mechanism (e.g., sealed-box audit logging) is
  required for v1, but the degradation must be documented.

---

## 5. Verdict Semantics

ModuleWarden v1 uses the following verdict vocabulary:

### allow

The exact package version hash is currently approved for promotion into Verdaccio
and installation by developers. **Currently allowed until revoked** — this is not
proof that a package is clean forever. Prompt, model, or pattern changes may
trigger a re-audit that revokes the allow.

### block

The package version is denied promotion and installation. Developers receive a
clear failure message explaining why. Blocked versions remain invisible to npm
clients.

### quarantine

The package version is not promoted or served pending further review. Unlike
block, quarantine is an explicit signal that uncertainty exists. Quarantine
may be resolved by:
- A more capable agentic escalation pass
- A security-admin override
- A re-audit campaign after prompt/model changes

### override

A security admin can override a quarantine or block to allow a specific version.
Overrides are recorded with admin identity, scope, reason, and timestamp.
Overrides can themselves be superseded by later re-audits.

### re-audit

A campaign that re-evaluates currently allowed versions after prompts, models,
or known-pattern definitions change. Re-audits may revoke previous allow
decisions and produce new verdicts (block, quarantine, or reaffirmed allow).

---

## 6. Persistence & Async Execution

### Prisma Owns DB Access

- All application database access in v1 goes through Prisma.
- No ad hoc SQL clients or alternative ORMs for normal product reads/writes.
- Prisma is the single source of truth for the application schema.
- Postgres is the system of record.

### pg-boss Owns Durable Jobs & Events

- All durable events, background jobs, retries, scheduling, and worker
  coordination use pg-boss.
- pg-boss runs on Postgres. No separate queue broker is required.
- Job IDs correlate with Prisma-owned review and audit rows.

### Redis Is Excluded

- Redis and Redis-backed queues (BullMQ, Sidekiq-style) are **out of scope**
  for v1.
- No Redis service appears in Docker Compose, documentation, or architecture.
- Postgres is already required for provenance and decisions, so jobs and events
  live in the same operational boundary.

---

## 7. Cold Start Definition

A cold start occurs when a project's lockfile is first imported into ModuleWarden
and no package versions have been reviewed yet.

### Cold Start Is an Audit Campaign, Not a Diff

- The initial review evaluates every imported package version from scratch.
  There is no "last allowed predecessor" for a cold start.
- The audit question shifts from "does this diff introduce risk" to "does this
  package version look clean based on available evidence."

### No Admin Baseline Allow Shortcuts

- v1 explicitly rejects "admin can mark everything as baseline allowed" shortcuts.
- Every package version must pass review before it becomes an allowed baseline.
- Cold-start verdicts are conservative:

### Cold-Start Verdict Semantics

- **Allow** requires: clean provenance metadata, no suspicious behavior indicators,
  clean install traces, heuristic evidence of non-malicious intent, and no
  obfuscation or unusual capability surface.
- **Uncertainty quarantines**: if evidence is ambiguous or incomplete, the version
  is quarantined rather than silently allowed.
- **Block** applies to versions with clear malicious indicators.

Cold starts are treated as a conservative initial audit campaign rather than
proof of the diff thesis. The system proves its value on version bumps after
baselines are established.

---

## 8. Trust Model

### Trust Boundaries

```
┌─────────────────────────────────────────────────────┐
│                  Organization Boundary               │
│                                                      │
│  Developer ──► ModuleWarden ──► Verdaccio            │
│  (npm client)       │               (backing repo)   │
│                      │                               │
│                      ├── Postgres (Prisma + pg-boss) │
│                      ├── Audit Workers               │
│                      │   └── PI Containers           │
│                      └── Model Endpoint Adapter      │
│                                                      │
└─────────────────────────────────────────────────────┘
         │
         │ (external, trusted)
         ▼
┌─────────────────────────────────────────────────────┐
│          Model Endpoint Operator (Trusted)           │
│                                                      │
│  OpenAI-compatible API (local or external H100)      │
│  Receives prompts as part of inference               │
│  Prompts not protected from this operator in v1     │
└─────────────────────────────────────────────────────┘
```

### Key Trust Assumptions

1. **Developers only talk to ModuleWarden.** They do not talk directly to the
   backing repository or the model endpoint. ModuleWarden is the gate.
2. **ModuleWarden is the only writer/promoter into Verdaccio.** Verdaccio is
   the artifact store; ModuleWarden is the gate.
3. **The model endpoint operator is trusted infrastructure.** Prompts are sent
   to the endpoint as part of inference. v1 does not promise prompt secrecy
   from the endpoint operator.
4. **Root infrastructure administrators** (those with direct access to the
   ModuleWarden control plane) can read prompts and configuration. This is
   documented as a known trust boundary.
5. **Audit containers are disposable and isolated.** They receive only
   run-specific data and never receive core prompts, model credentials,
   Postgres credentials, Verdaccio credentials, or long-lived admin tokens.

### Logging & Secrecy Degradation

- When prompt logging is enabled and logs are accessible to infrastructure
  operators, the prompt-secrecy guarantee degrades to the trust boundary of
  the logging infrastructure.
- v1 does not implement verified-secure logging (sealed-box audit logging),
  but this degradation is documented for operator awareness.

---

## 9. Recorded-Open Egress Model

Audit containers in v1 use **recorded-open egress**:

- The container can reach the public internet (DNS + TCP/UDP).
- DNS resolution and connection metadata are captured as evidence.
- The package under review should never receive secrets worth exfiltrating.
- Network behavior is evidence, not a trusted side effect.

### Blocked Destinations

Recorded-open egress means **public internet only**. The following are blocked:
- Host machine (Docker host)
- Internal Docker networks (other Compose services)
- Link-local metadata services (e.g., cloud metadata endpoints)
- Direct backing-service access (Postgres, Verdaccio, model endpoint)

This ensures audit containers can fetch public package metadata and source
repos while being unable to exfiltrate data to the ModuleWarden control plane
or its backing services.

---

## 10. In-Container PI Audit Execution

Each agentic audit run is isolated in its own disposable Docker container built
from a custom audit-runner image.

### What Each Run Gets

- A fresh disposable container
- A run-specific temporary workspace
- A run-scoped RPC token (short-lived, single-run scope)
- Package artifacts (tarball, unpacked contents)
- Last-known-good baseline (previous allowed version)
- Candidate patch/diff against the predecessor
- Prepared evidence (metadata, dependency diff, capability delta)
- Run-specific instructions (what to review, what to look for)
- Audit tools (Node.js, npm, pnpm, yarn, git, ripgrep, jq, source
  beautification helpers such as Prettier and js-beautify, static-rule
  tooling, network capture tools, PI runtime)

### What Each Run Does NOT Get

- Core prompt files
- Model API credentials or keys
- Postgres credentials
- Verdaccio service credentials
- Long-lived admin tokens or session tokens
- Access to other Compose services (except public internet with
  recorded-open egress)

### Lifecycle

1. Worker creates container from audit-runner image.
2. Worker injects run-scoped workspace, RPC token, and inputs.
3. PI runs inside container in RPC mode, calling ModuleWarden tools.
4. After audit finishes, times out, or crashes, worker preserves declared
   evidence artifacts.
5. Worker destroys the container (no shared mutable state).

---

## 11. Non-Goals (v1)

ModuleWarden v1 explicitly does **not** attempt to:

- Replace SCA, CVE feeds, SBOMs, or dependency inventory.
- Guarantee that an allowed package is safe forever.
- Find all novel vulnerabilities in arbitrary package code.
- Serve as a standalone artifact repository (replaces Artifactory/Nexus).
- Use Redis or Redis-backed queues.
- Provide a Kubernetes-native deployment (Docker Compose only).
- Protect prompts from root infrastructure admins or model endpoint operators.
- Perform cold-start reviews as proof of the diff thesis.

---

## 12. V1 Success Criteria

1. **Attack replay**: Catch every high-confidence critical replay attack in
   the seed corpus with explainable evidence.
2. **False positive management**: Measure false positives, quarantine rate,
   escalation rate, and missed detections.
3. **No overclaiming**: Avoid claiming broad novel-vulnerability discovery
   until measured by the evaluation harness.
4. **Developer workflow**: Approved versions install normally; unapproved
   versions fail clearly with CLI guidance.
5. **Audit isolation**: Every PI run is container-isolated with no cross-run
   contamination and no access to control-plane secrets.

---

## 13. Architecture Diagram (Data Flow)

```
npm/pnpm/yarn client
        │
        │ npm install (configured registry → ModuleWarden)
        ▼
┌──────────────────────────────┐
│   ModuleWarden npm proxy      │  ◇  Fastify HTTP server
│   (API + proxy)               │      - Approved-only metadata
│                                │      - Dist-tag rewriting
│                                │      - Tarball proxying from Verdaccio
└──────────────┬───────────────┘
               │
        ┌──────┴──────┐
        │              │
        ▼              ▼
┌──────────────┐  ┌──────────────────┐
│  Postgres     │  │   Verdaccio       │
│  (Prisma DB   │  │   (backing repo)  │
│   + pg-boss)  │  │                   │
└──────────────┘  │   Only ModuleWarden│
                  │   promotes into it │
                  └──────────────────┘
        │
        │ (pg-boss jobs)
        ▼
┌──────────────────────────────┐
│      Audit Workers            │
│                               │
│  ┌──────────────────────────┐│
│  │  PI Audit Container (#N)  ││  ← disposable, isolated
│  │                           ││
│  │  - Package tarball        ││
│  │  - Predecessor baseline   ││
│  │  - Diff / patch           ││
│  │  - Prepared evidence      ││
│  │  - Run instructions       ││
│  │  - PI runtime (RPC mode)  ││
│  │  - Audit tools            ││
│  │                           ││
│  │  ✗ No core prompts        ││
│  │  ✗ No model credentials   ││
│  │  ✗ No DB/Verdaccio creds  ││
│  └──────────────────────────┘│
└──────────────────────────────┘
        │
        │ (model inference via adapter)
        ▼
┌──────────────────────────────┐
│  OpenAI-compatible endpoint   │
│  (local or external H100)     │
└──────────────────────────────┘
```

---

## 14. Component Inventory (v1)

| Component              | Technology       | Role                                      |
|------------------------|------------------|-------------------------------------------|
| API / npm proxy        | Fastify (TS)     | Registry gate, approved-only metadata     |
| Worker                 | Node (TS)        | Audit orchestration, container lifecycle  |
| CLI                    | Node (TS)        | Developer commands (status, explain, ...) |
| Web UI                 | React/Vite       | Admin console for queue, evidence         |
| Shared types/config    | TypeScript       | Typed config, job payloads, API types     |
| Prisma schema/client   | Prisma + Postgres| Application DB access layer               |
| pg-boss jobs           | pg-boss          | Durable events, jobs, retries, scheduling |
| Audit-runner image     | Docker           | Isolated PI audit container               |
| Model endpoint adapter | Node (TS)        | Pluggable OpenAI-compatible client        |

---

## 15. Critique & Rationale

### Shared Vendor Telemetry Is Valuable

Vendor intelligence, CVE feeds, and static rules catch many real attacks.
ModuleWarden is additive, not a replacement. The thesis is that these signals
miss the compromised-maintainer version-bump scenario specifically.

### Static Rules Are Bypassable

Attackers who know common public heuristics can craft payloads that evade them.
Private semantic review with tool-assisted evidence collection raises the bar.

### LLMs Are Not Magic on Arbitrary Minified Tarballs

Unbounded "scan all open source" LLM products overclaim. ModuleWarden constrains
the problem: bounded version diffs, rich evidence collection, private rubrics,
and a two-stage escalation model.

### The Defensible Advantage

The defensible advantage is **private semantic diff review over bounded version
changes with rich evidence collection** — not general AI vulnerability scanning.

### Cold Starts Are Not Proof of the Diff Thesis

Cold-start reviews prove that ModuleWarden can evaluate arbitrary packages,
not that diff review works. The diff thesis is proven on version bumps after
baselines are established. Cold starts are a conservative campaign that
establishes baselines.

---

## Document Control

- **Created**: 2026-05-27
- **Status**: Ratified — implementation contract for v1
- **Amendments**: Any change to scope, trust boundaries, or technology choices
  requires a documented amendment signed off by the architecture owner.
