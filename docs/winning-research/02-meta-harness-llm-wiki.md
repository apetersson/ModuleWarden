# Meta-Harness and LLM-Wiki: Environment Cultivation Analysis

**Date:** 2026-05-29
**Context:** Zero-One Hack Vienna 2026 / kimiclaw multi-agent dev environment
**Failure trigger:** 3 consecutive swarm runs analyzed `apiary-starter/` stub instead of `apetersson/ModuleWarden` canonical repo

---

## Local Context

### What exists today

The environment runs:

- **Trident** - scoring-based multi-model fleet at `C:/Projects/_Codex/bin/trident` (Codex/Gemini/Grok/Claude, SQLite session store at `.trident/sessions.db`)
- **Pantheon** - tiered council MCP with 464 episodes of model performance data across 12 domains
- **KCS / Anismin / Meridian / clawfish** - swarm brains with a flat-DAG dependency inference engine (v4.22) and real web-search injection (v4.23-v4.25)
- **Karpathy-style wiki** at `D:\Documents 2025\_Europe\karpathy-wiki\02-Knowledge\Wiki\Harness-Insights\` - Obsidian-backed living knowledge base with lint rules
- **File-based auto-memory** per project (MEMORY.md + typed memory files) with session-startup recall
- **CLAUDE.md orchestration rules** - global backstop for regression risk, AI-marker avoidance, fork isolation, authority-framing defense, and end-of-session wiki update check
- **agents.md** - cross-agent coordination rules including timeout policies, trust boundary discipline, and the "empirical probe over narrated state" doctrine

### The recurring failure pattern

Three swarm runs in one session built plans on `apiary-starter/` (a local stub decoy with its own `package.json` and model scripts) rather than the canonical `apetersson/ModuleWarden` GitHub repo. Agents trusted:

1. Local filesystem assumptions (the stub existed and had plausible-looking files)
2. TRACK02-DESIGN.md references to `apiary-starter` without verifying whether that was the submission or just a prototype scaffold
3. Narrated state in handover docs rather than live GitHub API state

Root cause: no harness-level gate forcing agents to resolve "which repo is canonical?" before beginning analysis. The `multi_agent_verify_live_record` memory entry exists but was not enforced at dispatch time.

---

## External Findings

### What is a Meta-Harness?

A **meta-harness** is a two-level agent orchestration framework where the harness itself - not just the agent it runs - is subject to optimization and verification. The canonical research is "The Last Harness You'll Ever Build" (Seong, Sylph.AI, arXiv:2604.21003, 2025).

**Two-level architecture:**

- **Harness Evolution Loop** (level 1): Worker agent + Evaluator agent + Evolution agent collaborate iteratively. The Evaluator adversarially identifies failures in the current harness configuration; the Evolution agent rewrites the harness based on accumulated attempt history.
- **Meta-Evolution Loop** (level 2): Generalizes successful harness configurations across diverse tasks into a reusable blueprint (Lambda-best) that enables rapid convergence on any new task.

The key insight is that *the harness determines what the agent can perceive, how it acts, and how its work is verified* - not the model weights. Optimizing the model while leaving the harness static is like retraining a pilot while leaving the cockpit instrumentation wrong.

Related frameworks:
- **Godel Agent** (arXiv:2410.04444): self-referential recursive improvement via SELF_INSPECT -> execute -> measure -> modify -> recurse loop. The agent reads its own current algorithm before each modification.
- **MARS** (arXiv:2601.11974): metacognitive reflection with principle-based and procedural reflection, achieving self-evolution within a single recurrence cycle.

### What is the LLM Wiki / Karpathy Wiki Pattern?

Andrej Karpathy's LLM wiki (gist.github.com/karpathy/442a6bf555914893e9891c11519de94f) is a pattern for AI-maintained persistent knowledge bases. It bypasses RAG by having the LLM *build and maintain* a structured wiki rather than retrieve from raw sources at query time.

**Three-layer architecture:**
- **Raw/** - immutable source material (papers, GitHub repos, web articles) - the ground truth input
- **Wiki/** - LLM-generated markdown (summaries, entity pages, cross-references) - the compiled knowledge
- **Schema** - configuration (CLAUDE.md equivalent) defining structure, conventions, ingest/lint workflows

**Three core operations:**
- **Ingest**: process new source -> extract key information -> update wiki pages -> maintain backlinks
- **Query**: search wiki + synthesize with citations -> optionally file result as new page
- **Lint**: periodic pass checking for contradictions, stale claims, orphaned pages, data gaps

The system is self-maintaining because lint passes catch drift and ingest compresses new knowledge into existing structure rather than appending raw notes. Karpathy's own wiki reached 100 articles and 400K words as of 2026.

The Obsidian integration (aimaker.substack.com) extends this with `[[wiki links]]` backlinks as a traversable graph, which is exactly what the environment already uses at `D:\Documents 2025\_Europe\karpathy-wiki`.

### Tool Receipts: Enforcing Ground Truth at Tool Call Level

arXiv:2603.10060 proposes "tool receipts" - a lightweight hallucination prevention mechanism. When an agent calls a tool (web search, API, file read), the harness records a receipt: tool invoked + input parameters + actual output returned. Claims made downstream must be traceable to a receipt; if an agent states something not backed by a documented tool call, the discrepancy is detectable immediately.

This is the pragmatic alternative to zero-knowledge proofs - it makes hallucination *detectable* rather than cryptographically impossible.

---

## Analysis

### How the wrong-codebase failure maps to missing harness gates

The failure was a **context-resolution failure at dispatch time**, not an agent reasoning failure mid-analysis. The harness dispatched agents without establishing canonical repo identity first. This maps precisely to what the meta-harness literature calls a "harness perception gap" - the agent could not perceive what it should have been analyzing because the harness never told it.

**Gap 1 - No canonical repo resolution step:** The harness (CLAUDE.md + agents.md) has the "empirical probe over narrated state" doctrine but applies it to *operator-only reclassification*, not to *dispatch preconditions*. There is no rule that says "before dispatching a swarm to analyze a codebase, resolve the canonical remote URL via `gh repo view` and bind it to the task."

**Gap 2 - No tool receipt for repo identity:** Agents built plans citing files they never fetched from `raw.githubusercontent.com`. Under a tool-receipt discipline, any claim about a file's content would require a traceable `gh api` or `WebFetch` call. Without that gate, agents can cite local stubs as if they were the canonical repo.

**Gap 3 - Wiki has no "ground truth disambiguation" entry:** The Harness-Insights wiki has entries for filter-on-schema-tag and floor-meridian-ok-semantic-split, but no entry for "how to resolve which repo is canonical when a task involves multiple plausible codebases." This pattern has now appeared 3 times - it should be a wiki entry.

**Gap 4 - MEMORY.md has the `multi_agent_verify_live_record` entry** (added this session) but it fires as post-hoc advice, not as a dispatch precondition in CLAUDE.md. The gap between "memory says verify" and "harness enforces verify" is where the failure lived.

### Intersection with existing tools

| Missing gate | Existing tool to wire it to | Effort |
|---|---|---|
| Canonical repo resolution at dispatch | Trident routing - add `repo_resolve` precondition before code-analysis tasks | Medium |
| Tool receipt for repo claims | Pantheon tier-1 factual check - require `gh api` evidence before agent cites repo state | Low |
| Wiki disambiguation entry | Harness-Insights lint pass - add `verify-repo-identity.md` entry | Very Low |
| CLAUDE.md dispatch precondition | New mandatory check: "before analyzing any codebase, bind canonical remote URL" | Low |

---

## Recommendations

### 1. Add a canonical repo resolution precondition to CLAUDE.md - Priority: HIGH

Before any multi-agent swarm dispatched to analyze a codebase, the orchestrator must resolve the canonical remote URL. Concrete rule:

```
MANDATORY: Before dispatching agents to analyze a codebase:
1. Run: gh repo view OWNER/REPO --json nameWithOwner,url,defaultBranchRef
2. Bind the result to task context as CANONICAL_REPO
3. Do NOT proceed if the repo returns 404 or the local stub lacks a matching remote
4. All agent claims about repo files must cite raw.githubusercontent.com/OWNER/REPO/BRANCH/PATH URLs
```

This is a single CLAUDE.md addition. It would have stopped all three wrong-codebase runs.

**Pros:** Zero code change required, immediate effect, grounded in existing gh CLI tooling already present.
**Cons:** Adds one mandatory step to every code-analysis dispatch. Latency: ~2s for `gh repo view`.

### 2. Add tool-receipt enforcement for repo-state claims - Priority: HIGH

Add a post-dispatch validation step: any agent output that makes a claim about file content, function signatures, or code patterns must include a citation to the raw.githubusercontent.com URL it fetched. Implement as a simple grep on agent output before the result is accepted:

```bash
# Validate agent output cites raw github evidence for repo claims
echo "$AGENT_OUTPUT" | grep -q "raw.githubusercontent.com" || {
  echo "BLOCKED: repo claims without raw.githubusercontent.com citation"
  exit 1
}
```

Wire into the Trident post-validation middleware (the existing `output validation` step in the v2 harness pipeline).

**Pros:** Catches hallucinated file references before they pollute downstream planning. Trident already has a validation pipeline - this is a one-rule addition.
**Cons:** Will false-positive on tasks where agents correctly analyze local files (e.g., the submission's own code). Needs a whitelist for legitimate local-file analysis.

### 3. Write a wiki entry for "verify repo identity before analysis" in Harness-Insights - Priority: HIGH

Title: `Verify-Canonical-Repo-Before-Dispatch.md`

The pattern has appeared 3 times. Per the Karpathy wiki discipline, a pattern that repeats 3 times is a lint failure (it should have been written after occurrence 2). Entry should include:
- The trigger: task involves analyzing a codebase, multiple plausible repos exist (local stub + remote canonical)
- The rule: bind canonical remote URL before dispatch; require raw.githubusercontent.com citations
- The tool: `gh repo view`, `gh api repos/OWNER/REPO/contents/PATH`
- Cross-link to: `Filter-on-Schema-Tag-Not-Body-Provenance.md` (schema vs narrated state)

**Pros:** Future sessions get this as startup context. The lint discipline (end-of-session wiki check in CLAUDE.md) will surface it automatically.
**Cons:** None - pure upside. Writing time: 10 minutes.

### 4. Extend Trident routing to include a "ground truth mode" for code-analysis tasks - Priority: MEDIUM

Add a routing classifier in `config/routing.yaml` that detects code-analysis tasks (`repo`, `codebase`, `analyze`, `ModuleWarden`, `apetersson`) and automatically appends a `--ground-truth-mode` flag. In ground truth mode, the harness:
- Forces a `gh repo view` call before routing to any model
- Injects `CANONICAL_REPO` into the prompt as a system variable
- Enables tool-receipt validation on output

This is the Harness Evolution Loop pattern applied to the existing Trident harness.

**Pros:** Automated, no per-dispatch manual intervention. Trident's config-driven architecture makes this a YAML edit + one Python function.
**Cons:** Requires Trident code change (~50 lines). Needs testing to avoid false positives on non-codebase tasks.

### 5. Run a quarterly lint pass on Harness-Insights wiki for "missing preconditions" - Priority: MEDIUM

The wiki currently captures patterns after they fail. A meta-harness discipline would run a lint pass asking: "For each memory entry in MEMORY.md tagged with a failure, is there a corresponding CLAUDE.md precondition that prevents recurrence?" The wrong-codebase failure had a memory entry (`multi_agent_verify_live_record`) but no CLAUDE.md gate - that gap is the lint target.

Implement as a simple Obsidian query:
- List all `feedback_*.md` memory entries
- For each one, check if CLAUDE.md contains a matching precondition
- Flag entries with no corresponding CLAUDE.md rule as "unguarded"

**Pros:** Closes the loop between "we learned this" and "we enforce this." Directly addresses the memory-to-harness gap.
**Cons:** Quarterly cadence may miss hot failures. Consider monthly or post-incident instead.

---

## Implementation Notes

### Immediate actions (this session)

1. Add the canonical repo resolution rule to CLAUDE.md under a new section "MANDATORY: Codebase Analysis Preconditions" - this is a 5-line addition.
2. Write `Verify-Canonical-Repo-Before-Dispatch.md` to `D:\Documents 2025\_Europe\karpathy-wiki\02-Knowledge\Wiki\Harness-Insights\` and add it to `_index.md`.
3. Update auto-memory: `multi_agent_verify_live_record` should note the CLAUDE.md precondition gap, not just the verification doctrine.

### Trident ground-truth mode (next session)

The Trident v2 harness already has: routing classifiers in `config/routing.yaml`, per-task enrichments in `config/prompts.yaml`, and an output validation step in the middleware pipeline. Ground-truth mode is an extension of the enrichment pattern - inject `CANONICAL_REPO` as a required context variable for code-analysis tasks. Estimated effort: 2 hours.

### Meta-harness evolution loop (medium term)

The Harness Evolution Loop (arXiv:2604.21003) maps directly to the existing Trident feedback mechanism (`trident feedback <id> good|bad`). Currently feedback adjusts model approval rates but does not feed back into harness configuration. Closing this loop means: bad feedback on a code-analysis task triggers a review of whether the routing preconditions fired correctly - not just whether the model response was good. This is the difference between "rate the output" and "rate the harness."

---

## Sources

- [The Last Harness You'll Ever Build (arXiv:2604.21003)](https://arxiv.org/pdf/2604.21003)
- [Godel Agent: Self-Referential Framework (arXiv:2410.04444)](https://arxiv.org/abs/2410.04444)
- [MARS: Metacognitive Agent Reflective Self-Improvement (arXiv:2601.11974)](https://arxiv.org/pdf/2601.11974)
- [Tool Receipts for Hallucination Detection (arXiv:2603.10060)](https://arxiv.org/pdf/2603.10060)
- [LLM-Agent-Harness-Survey (HuggingFace)](https://huggingface.co/datasets/GloriaaaM/LLM-Agent-Harness-Survey)
- [Karpathy LLM Wiki (GitHub Gist)](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f)
- [LLM Wiki v2 - extending Karpathy's pattern (GitHub Gist)](https://gist.github.com/rohitg00/2067ab416f7bbe447c1977edaaa681e2)
- [Karpathy LLM Wiki + Claude Code (MindStudio)](https://www.mindstudio.ai/blog/andrej-karpathy-llm-wiki-knowledge-base-claude-code)
- [LLM Wiki in Obsidian (aimaker.substack.com)](https://aimaker.substack.com/p/llm-wiki-obsidian-knowledge-base-andrej-karphaty)
- [VentureBeat: Karpathy LLM Knowledge Base architecture](https://venturebeat.com/data/karpathy-shares-llm-knowledge-base-architecture-that-bypasses-rag-with-an)
- [karpathy-llm-wiki Agent Skills compatible repo (GitHub)](https://github.com/Astro-Han/karpathy-llm-wiki)
