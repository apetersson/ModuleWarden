# ModuleWarden

ModuleWarden is a planned self-hosted npm ingress gate for organizations that want package updates reviewed before they enter the internal dependency supply chain.

The core idea is narrow on purpose: ModuleWarden is not trying to be a generic "AI scans all open source packages" product. It is designed around a sharper threat model:

> A legitimate, already trusted npm package maintainer or maintainer account is compromised, and a malicious new version is published under a real package name.

That scenario is dangerous because normal trust signals still look good. The package is popular. The maintainer is real. The version may contain an actual bug fix. Static malware rules may miss the payload, especially if the attacker knows common public heuristics. ModuleWarden focuses on catching the malicious version bump before it spreads inside an organization.

## Status

This repository currently contains the product backlog and implementation plan for ModuleWarden. The service implementation has not started yet.

The detailed backlog is in [`backlog/tasks`](./backlog/tasks). The current v1 epic is `TASK-1`.

## Product Thesis

Most dependency security systems are strongest at known vulnerabilities, known malware patterns, package reputation, typosquatting, and vendor intelligence. Those are valuable, but they do not fully address the compromised-maintainer case.

ModuleWarden's thesis is:

> For packages an organization already uses, each new version should be reviewed as a semantic diff against the last allowed version before it becomes installable.

This is a smaller and more tractable problem than auditing a whole package from scratch. The audit question becomes:

> Does this version introduce behavior that is inconsistent with the package's purpose, prior behavior, changelog, or expected capability surface?

Examples of suspicious version deltas:

- A formatting library adds network access.
- A utility package starts reading environment variables.
- A patch release adds a lifecycle script.
- A dependency update redirects through a new maintainer-controlled package.
- A readable codebase suddenly includes obfuscated payloads.
- A benign-looking helper adds `child_process`, `eval`, dynamic imports, native binaries, or WASM.
- The tarball diverges materially from the advertised source or release notes.

## Why Private Agentic Review?

ModuleWarden does not rely on the vague claim that "LLMs find vulnerabilities like humans." The stronger claim is more specific:

- The input is a bounded version diff, not the entire public npm ecosystem.
- The auditor gets structured evidence, not just raw package files.
- The prompts and review rubric are private from package authors, attackers, developers, and ordinary users.
- Attackers can test against public static rules, but they cannot cheaply test against each organization's exact private prompt suite and tool behavior.

The private part is not primarily about data residency. npm packages are public. The defensive value is that the attacker does not get oracle access to the precise semantic review process.

## What ModuleWarden Is Not

ModuleWarden is not:

- A replacement for SCA, CVE feeds, SBOMs, or dependency inventory.
- A guarantee that an allowed package is safe forever.
- A claim that LLMs can reliably find all novel vulnerabilities in arbitrary package code.
- A standalone artifact repository meant to replace Artifactory, Nexus, or Verdaccio.
- A Redis-backed queue system.

The intended product is an adapter, proxy, and audit control plane in front of a real npm repository.

## V1 Scope

V1 is npm-only and focuses on the compromised-maintainer version-bump threat model.

The planned stack:

- TypeScript and Node.js
- Fastify API and npm proxy
- React/Vite web UI
- Node-based CLI
- Postgres as the system of record
- Prisma for application database access
- pg-boss for durable jobs, events, retries, schedules, and worker coordination
- Verdaccio as the first backing npm repository
- Docker Compose for local/self-hosted deployment
- Per-audit Docker containers for isolated agentic research runs
- PI in RPC mode as the agentic audit harness
- A local OpenAI-compatible model endpoint operated by the user

Redis is intentionally not part of v1. ModuleWarden already requires Postgres for decision provenance, so asynchronous work is planned around pg-boss.

## High-Level Architecture

Developers do not talk directly to the backing repository. They configure npm, pnpm, or yarn to use ModuleWarden as the registry.

```text
developer npm client
        |
        v
ModuleWarden npm proxy
        |
        +--> Postgres via Prisma
        +--> pg-boss jobs and schedules
        +--> audit workers
        +--> Verdaccio backing repository
```

Only ModuleWarden can promote package tarballs into Verdaccio. Developers read through ModuleWarden. Verdaccio is the artifact store; ModuleWarden is the gate.

## Package Flow

1. A project lockfile is imported into ModuleWarden.
2. ModuleWarden discovers the full used dependency graph, including transitive packages.
3. Existing package versions are audited before they become allowed baselines.
4. ModuleWarden subscribes to upstream metadata for packages in the used graph.
5. New upstream versions are proactively enqueued for audit.
6. The audit compares the new version against the last allowed predecessor.
7. The agent returns `allow`, `block`, or `quarantine`.
8. Allowed versions are promoted into Verdaccio and become visible to developers.
9. Blocked and quarantined versions remain unavailable unless a security admin overrides them.

## npm Client Behavior

ModuleWarden uses approved-only metadata.

That means npm clients see only versions that ModuleWarden currently allows. Dist-tags such as `latest` are rewritten to the newest approved version, not blindly copied from upstream.

This is a deliberate developer-experience choice. Flexible semver ranges should resolve to approved versions instead of randomly failing because upstream published a new unreviewed release.

If a developer or CI job requests an exact unapproved version, ModuleWarden should fail clearly, enqueue or dedupe the review job, and point the user at status and explanation commands.

## Audit Runner

Each agentic audit run is isolated in its own Docker container built from a custom audit-runner image.

The audit container is expected to include:

- Node.js, npm, pnpm, and yarn
- git
- ripgrep
- jq
- static-rule tooling
- deobfuscation helpers
- network capture or proxy tooling
- PI runtime
- minimal shell utilities needed for package inspection

Each audit gets:

- A fresh container
- A run-specific temporary workspace
- A run-scoped RPC token
- Package artifacts and evidence inputs
- No shared mutable state

The container must not receive:

- Core prompt files
- Model API credentials
- Postgres credentials
- Verdaccio service credentials
- Long-lived admin tokens

After the audit finishes, times out, or crashes, the worker preserves declared evidence artifacts and destroys the container.

## Network Model

V1 uses recorded-open egress for audit containers.

That means the container can reach the network, but DNS and connection metadata are captured as evidence. This supports realistic research tasks while making unexpected network behavior visible.

The package under review should never receive secrets worth exfiltrating. Network behavior is evidence, not a trusted side effect.

## Agentic Audit Model

PI runs in RPC mode inside the audit container. ModuleWarden exposes controlled tools over RPC.

Planned tool categories:

- Fetch package metadata and tarballs
- Unpack package versions
- Retrieve predecessor diffs
- Inspect lifecycle scripts
- Compare dependency changes
- Run static capability checks
- Run sandbox install/import experiments
- Capture network behavior
- Search public web, advisory, and source metadata from controlled contexts
- Store evidence artifacts
- Submit structured verdicts

The agent is expected to use shell access inside the isolated container, but it only accesses ModuleWarden state through run-scoped RPC tools.

## Evidence Model

Every decision should be backed by a reproducible dossier.

Useful evidence includes:

- Package name, version, registry source, and tarball hash
- Previous allowed version and hash
- File-level diff summaries
- Dependency diff
- Lifecycle script changes
- Capability deltas
- Obfuscation indicators
- Native/WASM additions
- Changelog and README context
- Repository/source links
- Sandbox install/import traces
- Network egress traces
- PI session metadata
- Prompt and model versions
- Scores and reviewer summaries

An allowed decision means:

> This exact package version hash is currently allowed until revoked.

It does not mean the package is safe forever.

## Verdicts

V1 uses three main verdicts:

- `allow`: promote and serve the exact package version hash.
- `block`: do not serve or promote the version.
- `quarantine`: do not serve or promote until a later agent run or security-admin override changes the decision.

The agent can make final allow, block, or quarantine decisions. Security admins can override quarantined or blocked versions.

Unknown or poorly explained risk should quarantine rather than silently allow.

## Prompt and Model Policy

ModuleWarden uses private core prompts plus optional admin-added custom prompts.

Core prompts should be hidden from:

- Package authors
- Compromised maintainers
- Developers
- Ordinary users
- Package code running inside audit containers

V1 does not claim prompts are hidden from root infrastructure administrators.

The planned review strategy is two-stage:

1. A broad first pass optimized for low false negatives.
2. A high-capability escalation pass with more precise prompts, used when the first pass finds suspicious evidence or uncertainty.

Prompt, model, and known-pattern changes should schedule re-audits for allowed versions in the active used graph.

## Jobs and Events

ModuleWarden has many asynchronous workflows:

- Upstream package metadata polling
- Lockfile import processing
- Package review enqueueing
- Audit container execution
- PI session tracking
- Model escalation
- Evidence post-processing
- Verdaccio promotion
- Re-audit campaigns

V1 uses pg-boss for these jobs and events.

Important constraints:

- Jobs should be idempotent.
- Duplicate package-version audits should collapse to one active job.
- Retries must not promote stale decisions.
- Expensive container and model work needs configurable concurrency limits.
- Job IDs should correlate with Prisma-owned review and audit rows.

## Developer Workflow

The intended developer workflow should feel close to normal package management.

```bash
npm install
pnpm install
yarn install
```

For approved versions, installs should work normally.

For unapproved exact versions or blocked dependencies, ModuleWarden should fail clearly and point to the CLI:

```bash
modulewarden status
modulewarden explain <pkg@version>
modulewarden request <pkg@version>
modulewarden preflight
modulewarden doctor
```

The goal is not to make developers wait for an AI review on every install. The goal is for the first review of a package version to create a reusable decision artifact for everyone else.

## Admin Workflow

Security admins should get an evidence-first review queue.

The UI should show:

- Reviewing, quarantined, blocked, and recently allowed versions
- Used-by projects and dependency reach
- Risk summaries
- Capability deltas
- PI run metadata
- Evidence artifacts
- Network traces
- Prompt and model versions
- Decision history
- Override actions
- Re-audit campaigns

The UI is an operational console, not a marketing surface.

## Evaluation

The first proof standard is attack replay.

ModuleWarden should be evaluated against real compromised-package or malicious-version incidents plus adjacent benign package versions as controls.

The initial success bar:

- Catch every high-confidence critical replay attack in the seed corpus.
- Preserve explainable evidence for each catch.
- Measure false positives, quarantine rate, escalation rate, and missed detections.
- Avoid overclaiming broad novel-vulnerability discovery until measured.

This evaluation harness is part of the product, not a side experiment.

## Backlog

The current implementation plan is captured as Backlog.md tasks:

- `TASK-1`: v1 epic
- `TASK-1.1` through `TASK-1.16`: architecture, scaffold, Prisma schema, pg-boss jobs, npm proxy, lockfile subscriptions, audit runner, PI harness, prompts, capability extraction, verdict policy, CLI, UI, evaluation, security tests, and docs

List tasks with:

```bash
backlog task list --plain
```

View a specific task with:

```bash
backlog task view TASK-1 --plain
```

## Near-Term Build Order

A sensible implementation order is:

1. Architecture and threat model contract
2. TypeScript monorepo and Docker Compose scaffold
3. Prisma/Postgres schema
4. pg-boss job orchestration
5. Approved-only npm proxy and Verdaccio promotion
6. Lockfile import and used-graph subscriptions
7. Per-job Docker audit runner
8. PI RPC audit harness
9. Capability-delta evidence preparation
10. Private prompts, escalation, and re-audit scheduling
11. Verdict policy and overrides
12. CLI and web UI
13. Replay evaluation and security tests

## Guiding Principle

ModuleWarden should be boring where security infrastructure needs to be boring: durable state, explicit evidence, reproducible decisions, clear failure modes, and no hidden queue magic.

The unusual part is the private agentic diff review. Everything around it should make that review more trustworthy, more measurable, and less disruptive to developers.
