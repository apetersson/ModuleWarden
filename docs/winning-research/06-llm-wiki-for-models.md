# LLM-Wiki Knowledge Graph for ModuleWarden Models

**Date:** 2026-05-29
**Scope:** Design for two living knowledge graphs - one for the auditor model, one for Decepticon - grounded in the actual repo state as of this date.

---

## 1. Baseline: What Exists and What Is Weak

The auditor model (Qwen2.5-0.5B QLoRA, `finetune/corpus/sft-records.attck.jsonl`, 386 train records) has a documented failure:

- Verdict-match: 73.9% on test split by defaulting to the majority class (quarantine).
- Block-recall: 0/5 (0%) on the 5 held-out block cases.

The root cause is not the model size alone. It is also that the SFT corpus is frozen at training time. Every audit is re-derived from first principles. There is no mechanism for a confirmed block (e.g., postmark-mcp@1.0.16) to propagate its pattern into the next audit of a package that shares three of its four capability signals. The model cannot compound experience.

The Decepticon mapper (`finetune/python/decepticon/mapper.py`) is a pure dictionary lookup: 9 capability keys map to 8 ATT&CK techniques. It is deterministic and correct, but static. New attack patterns (e.g., a package that poisons a Node.js resolver without any of the 9 known capability signals) are silent failures: depth=0, no warning.

`curated-threat-chains.json` has 10 package entries with rich attack-chain narratives written in prose. Right now that prose is only used for chat responses via `agent.py`. It is not wired back into training.

The LLM-wiki pattern closes these gaps. The plan below is grounded in what the repo actually has today and what can be built in a hackathon window.

---

## 2. Auditor-Model Wiki

### 2.1 Purpose

A living knowledge graph the auditor model reads at inference via RAG, and that feeds forward into the SFT corpus to close the learn-from-production loop. Not a vector database. A structured directory of markdown files with a deterministic indexing script.

### 2.2 Location

```
finetune/wiki/
  auditor/
    _index.md            <- master node list (one line per node, used by indexer)
    _schema.md           <- node format spec, field definitions
    packages/
      <pkg-name>.md      <- one file per notable package
    advisories/
      <advisory-id>.md   <- one file per confirmed advisory
    patterns/
      <pattern-slug>.md  <- one file per capability pattern
    false-positives/
      <pkg-name>-<ver>.md  <- confirmed false positives with correction reasoning
```

This is a repo directory, not an Obsidian vault. The reason: it must be readable by the pipeline scripts without Obsidian plugins. Wikilinks (`[[pkg-name]]`) work for navigation but the indexer reads raw markdown.

### 2.3 Node Schema

Every node is a markdown file with a YAML front-matter block, followed by a prose body. The schema for a package node:

```yaml
---
node_type: package          # package | advisory | pattern | false_positive
name: event-stream          # canonical name
version: "3.3.6"            # specific version (omit for package-level nodes)
verdict: block              # allow | quarantine | block | contested | unknown
confidence: high            # high | medium | low
advisory_ids:               # list of GHSA/OSV/SSVE ids
  - GHSA-xxx
capability_signals:         # subset of the 9 capability keys from mapper.py
  - lifecycle_script
  - dynamic_code_execution
  - credential_or_env_access
  - network_access
attack_chain_depth: 4       # from mapper.py kill_chain_narrative().depth
maintainer_node: right9ctrl # link to maintainer node (optional)
threat_actor_class: supply_chain_pivot
last_seen: "2024-11-26"
verdict_source: incident_replay  # incident_replay | sft_feedback | manual_golden
sft_record_ids:             # audit_ids from sft-records.jsonl that cite this
  - audit_event-stream_abc123
linked_nodes:               # wikilinks
  - "[[pattern/lifecycle-plus-dynamic-eval]]"
  - "[[advisory/GHSA-xxx]]"
---

## Summary

One paragraph written by the pipeline or a human. What happened, what signals
confirmed it, what the verdict was.

## Key Evidence

Bullet list of evidence_ref ids and what they showed. Matches the structure
of `evidence_index` in the dossier schema.

## Correction Notes

Empty for confirmed blocks. If verdict was later revised, explain why here.
This is the false-positive correction mechanism.

## SFT Derivation

Whether this node was used to generate an SFT record and under which source
label (incident_replay, manual_golden, etc.).
```

### 2.4 How the Auditor Reads the Wiki at Inference

The existing `chat/agent.py` already loads pinned evidence from `demo/incidents/` before calling the model. The same pattern applies at audit time:

1. `dossier_builder.py` produces a dossier with `capability_deltas`.
2. Before the model call, a new function `wiki_query(capability_signals, package_name)` runs a BM25 or simple TF-IDF search over `finetune/wiki/auditor/_index.md` and returns the top-3 matching nodes.
3. The matching node bodies are injected into the system prompt as a `<wiki_context>` block, between the base system prompt (currently in `sft_pair_builder.py`'s `_BASE_SYSTEM_PROMPT`) and the dossier.
4. The model sees prior confirmed cases with the same capability signals before judging the new dossier.

The wiki context is read-only from the model's perspective. The model cannot write to the wiki. Only the pipeline can.

Implementation: `finetune/wiki/query.py` - ~80 lines of Python using `rank_bm25` (already in the ecosystem; add to `requirements.txt`). No vector database. Hackathon-feasible.

### 2.5 The Learn-from-Production Loop

This is the closing of the feedback cycle. Each audit produces a dossier and a report. After human review (or after the deterministic gate fires with high confidence), a wiki node is created or updated:

```
dossier + report + human verdict
         |
         v
wiki_writer.py (new script, ~120 lines)
         |
         v
finetune/wiki/auditor/packages/<pkg>-<ver>.md  (node created or updated)
         |
         v
sft_pair_builder.py: source="wiki_derived"     (new source label)
         |
         v
finetune/corpus/sft-records.jsonl              (new training row)
```

The `sft_pair_builder.py` already accepts a `source` parameter with a controlled vocabulary. Adding `"wiki_derived"` to `_VALID_SOURCES` is a one-line change. The wiki node becomes both a retrieval artifact (RAG context) and a training artifact (SFT row). This is the Karpathy ingest pattern applied to security audits.

The loop does not require a retraining run on every new node. Nodes accumulate until enough have been added to justify a retraining batch. The RAG path provides the immediate benefit; retraining provides the weight-level benefit.

### 2.6 Seeding the Wiki

The starting seed comes from `curated-threat-chains.json` (10 entries), the `demo/incidents/` dossiers (postmark-mcp-1.0.16, postmark-mcp-1.0.12, lodash-4.17.21), and the existing `corpus/golden-cases.json`. A one-time `seed_wiki.py` script converts these into the node format. Estimated output: 15-20 nodes on day one.

---

## 3. Decepticon's Own Wiki

### 3.1 Purpose

A separate offensive knowledge graph that Decepticon owns and accumulates. It stores attack patterns, TTP nodes, threat-actor profiles, and package-compromise chains. The defensive auditor consumes it. The offense-feeds-defense loop is the structural innovation.

### 3.2 Location

```
finetune/wiki/
  decepticon/
    _index.md
    _schema.md
    techniques/
      T1195.002.md         <- one file per ATT&CK technique in use
      T1059.007.md
      T1552.001.md
      T1041.md
      T1027.md
      T1005.md
      T1059.md
      T1106.md
    chains/
      supply-chain-pivot.md   <- named attack chain patterns
      credential-thief.md
      crypto-miner.md
      typosquat-operator.md
    threat-actors/
      right9ctrl.md           <- maintainer/actor profiles
    package-patterns/
      postinstall-exfil.md    <- named TTP patterns (cross-technique)
      obfuscated-loader.md
      ci-token-harvest.md
```

### 3.3 Node Schema

A technique node (`techniques/T1041.md`):

```yaml
---
node_type: technique
technique_id: T1041
technique_name: "Exfiltration Over C2 Channel"
tactic: Exfiltration
mapper_capability_key: network_access   # the key in mapper.py that maps to this
observed_packages:                      # wikilinks to package nodes in auditor wiki
  - "[[../../auditor/packages/event-stream-3.3.6]]"
  - "[[../../auditor/packages/eslint-scope-3.7.2]]"
observed_chains:
  - "[[../chains/supply-chain-pivot]]"
  - "[[../chains/credential-thief]]"
detection_gaps:                         # where the mapper currently has blind spots
  - "Packages using WebSocket for exfil (no HTTP pattern match)"
  - "Packages that exfil only under specific env var conditions"
variant_count: 3
last_updated: "2026-05-29"
---

## Technique Description

ATT&CK prose (cited from mitre.org; not generated).

## Observed Package Instances

For each observed package: what capability signal fired, what the
network pattern looked like, whether it evaded static detection.

## Detection Gaps

Where the current mapper.py lookup table misses this technique.
This field feeds back into mapper.py extension PRs.

## Procedure Variants

Known variations not covered by the current procedure template in mapper.py.
```

A chain node (`chains/supply-chain-pivot.md`):

```yaml
---
node_type: chain
chain_name: supply-chain-pivot
threat_actor_class: supply_chain_pivot
technique_sequence:
  - T1195.002
  - T1059.007
  - T1552.001
  - T1041
depth: 4                    # matches kill_chain_narrative().depth
observed_packages:
  - "event-stream@3.3.6"
  - "flatmap-stream@0.1.1"
estimated_blast_radius_usd: 15000000   # from curated-threat-chains.json
insurance_rider: cyber_extortion_and_data_breach
preconditions:              # what must be true for this chain to trigger
  - "Maintainer account accessible to attacker"
  - "Package has >1M weekly installs (supply-chain leverage)"
  - "Downstream consumer matches specific env pattern"
---

## Chain Narrative

Derived from curated-threat-chains.json prose, structured by phase.

## Preconditions for Auditor

Fields the auditor model should look for to elevate suspicion when
this chain is partially matched.
```

### 3.4 Connection to mapper.py

The Decepticon wiki has a tight feedback loop with `mapper.py`:

- The `detection_gaps` field in each technique node records where the mapper is blind.
- A new script `decepticon/gap_reporter.py` reads all technique nodes and produces a structured gap list.
- When a new capability key is confirmed (e.g., a new attack uses WebSocket exfil without matching any of the 9 current keys), a human or agent adds a new entry to `_CAPABILITY_TO_ATTACK` in `mapper.py` and creates the corresponding technique node.

This makes the mapper extensible without breaking the determinism guarantee: every entry in `_CAPABILITY_TO_ATTACK` is still a fixed lookup; the wiki documents what the lookup covers and what it misses.

The `decepticon_augmentor.py` already reads from `mapper.py`. After wiki nodes are added, the augmentor can be extended to also inject the chain node's `preconditions` list into the SFT target, giving the model richer context for why a given kill chain is dangerous.

### 3.5 Seeding Decepticon Wiki from curated-threat-chains.json

`curated-threat-chains.json` already has structured attack-chain phases and threat-actor classes for all 10 packages. A `seed_decepticon_wiki.py` script converts each entry into:

- One chain node (from `attack_chain` phases).
- Package cross-links in the relevant technique nodes.
- Threat-actor class entries where the `threat_actor` field is not `"none"`.

This is a one-time 100-line script. The chains for the 5 malicious packages (event-stream, eslint-scope, ua-parser-js, rc, coa) map directly to 4 named chain types. Lodash/react/axios/express/moment become `benign_high_reputation` reference nodes the auditor wiki holds (benign ground truth).

---

## 4. The Offense-Feeds-Defense Loop

This is the structural claim of the design. Here is the concrete data flow:

```
[Decepticon Wiki]
  chain/supply-chain-pivot.md
  techniques/T1552.001.md (detection_gap: "WebSocket exfil not matched")
         |
         v
  gap_reporter.py produces gap_list.json
         |
         v
  human/agent extends mapper.py _CAPABILITY_TO_ATTACK
         |
         v
  decepticon_augmentor.py re-runs on sft-records.jsonl
         |
         v
  sft-records.attck.jsonl gains new kill-chain annotations
         |
         v
  [Auditor Wiki] picks up new pattern nodes via wiki_writer.py
         |
         v
  Next audit with that capability signal gets enriched wiki context
```

The loop has three control points:

1. **Decepticon wiki gap field** - records what is not detected (offensive knowledge).
2. **mapper.py** - the authoritative lookup that stays deterministic.
3. **Auditor wiki** - records what has been confirmed (defensive knowledge).

The auditor model does not reason about the Decepticon wiki directly. It only sees the auditor wiki nodes that were derived from it. The separation maintains the verdict-pinning discipline: the model narrates; the mapper and the gate decide.

---

## 5. Concrete Build Plan

### 5.1 File and Directory Changes

| Path | Type | Status |
|------|------|--------|
| `finetune/wiki/` | new directory | create |
| `finetune/wiki/auditor/_index.md` | new file | create |
| `finetune/wiki/auditor/_schema.md` | new file | create |
| `finetune/wiki/auditor/packages/` | new directory | create |
| `finetune/wiki/auditor/patterns/` | new directory | create |
| `finetune/wiki/auditor/advisories/` | new directory | create |
| `finetune/wiki/auditor/false-positives/` | new directory | create |
| `finetune/wiki/decepticon/_index.md` | new file | create |
| `finetune/wiki/decepticon/techniques/` | new directory | create |
| `finetune/wiki/decepticon/chains/` | new directory | create |
| `finetune/wiki/decepticon/threat-actors/` | new directory | create |
| `finetune/wiki/decepticon/package-patterns/` | new directory | create |
| `finetune/wiki/seed_wiki.py` | new script | create |
| `finetune/wiki/seed_decepticon_wiki.py` | new script | create |
| `finetune/wiki/query.py` | new script | create |
| `finetune/wiki/wiki_writer.py` | new script | create |
| `finetune/decepticon/gap_reporter.py` | new script | create |
| `finetune/python/pipeline/sft_pair_builder.py` | extend | add `"wiki_derived"` to `_VALID_SOURCES` |
| `finetune/python/pipeline/decepticon_augmentor.py` | extend | inject chain preconditions |

### 5.2 Graph Format Choice

**Markdown with YAML front-matter, no graph database.**

Rationale:
- The existing harness reads markdown (Obsidian, CLAUDE.md, memory files). No new dependency.
- Front-matter is machine-readable by a 20-line Python parser. No ORM, no schema migration.
- Wikilinks (`[[...]]`) work as traversal references for the indexer without a graph store.
- SQLite is overkill for <1,000 nodes at hackathon scale; networkx adds a runtime dependency for no gain over a flat directory index.
- If the wiki grows past 1,000 nodes post-hackathon, migrating YAML front-matter to SQLite is a straightforward one-time script.

**For the auditor RAG query:** `rank_bm25` over the `_index.md` flat node list. One dependency, fast, no server.

### 5.3 Leverage Ranking

| Item | Hackathon leverage | Hours |
|------|-------------------|-------|
| Seed auditor wiki from existing demo/incidents + curated-threat-chains.json | High - immediate demo story | 2 |
| Seed Decepticon wiki from curated-threat-chains.json | High - 10 chain nodes ready to show | 2 |
| `query.py` BM25 RAG injected into system prompt | High - auditor reads precedents at inference | 3 |
| Technique nodes with detection_gaps for mapper.py | Medium - offense-feeds-defense story | 2 |
| `wiki_writer.py` for post-audit node creation | Medium - closes the loop | 2 |
| `gap_reporter.py` for mapper extension | Low - future work story, demo narrative only | 1 |
| Retrain with wiki_derived SFT rows | Low - requires new training run, not hackathon-feasible | 0 (narrate) |

Total build-now: ~12 hours.

### 5.4 Compose with Existing Files

- `curated-threat-chains.json` is the primary seed. The 5 malicious entries become chain nodes in Decepticon wiki and package nodes in auditor wiki. The 5 benign entries become benign-reference nodes in auditor wiki.
- `demo/incidents/*.dossier.json` + `*.report.json` become the first 3 auditor wiki package nodes with real evidence_index references.
- `mapper.py` technique ids (T1195.002, T1059.007, T1106, T1027, T1552.001, T1005, T1059, T1041) seed the 8 initial technique nodes in the Decepticon wiki.
- `finetune/docs/finding-taxonomy.md` controlled vocabulary maps to auditor wiki pattern nodes (one node per category in the taxonomy).

---

## 6. Build-Now vs Narrate

### Build now (hackathon window, ~12 hours)

- `finetune/wiki/` directory structure with `_index.md` and `_schema.md` files.
- Seeded auditor wiki: 15-20 package and advisory nodes from existing demo data.
- Seeded Decepticon wiki: 8 technique nodes + 4 chain nodes from `curated-threat-chains.json`.
- `query.py` BM25 RAG function injected into the system prompt at inference.
- One-liner extension to `sft_pair_builder.py` (`"wiki_derived"` source).
- Demo narrative: "auditor looked up 3 similar incidents before issuing its verdict."

### Narrate only (do not claim as built)

- `wiki_writer.py` auto-creating nodes from production audits. This requires a post-audit hook that does not exist yet. Design it, don't claim it runs.
- Retraining on `wiki_derived` SFT rows. Requires a new training run (~4 hours on RTX 5090). Not hackathon-feasible; frame it as the next iteration.
- `gap_reporter.py` feeding mapper.py extensions. The gap fields exist in the node schema; the automation does not run until after the hackathon.
- Full offline MITRE ATT&CK STIX graph ingestion. The technique nodes above cover the 9 capability keys already in use. Importing all 600+ ATT&CK techniques would require a STIX parser and produce mostly dead nodes. Not useful until the mapper covers more ground.

### The honest framing for judges

The wiki pattern is demonstrably real: the auditor wiki nodes exist on disk, the BM25 query runs, and the system prompt at inference cites "2 prior confirmed cases with matching capability signals." The learn-from-production loop is designed and the schema supports it; the automation (wiki_writer.py) is the work that comes next.

---

## 7. Connection to the Chat Underwriter

`chat/agent.py` already injects the kill-chain narrative from `mapper.py` into the underwriter memo via `_kill_chain_attack()`. After the Decepticon wiki is built, the chain nodes add two fields the chat can surface:

- `insurance_rider` (already in `curated-threat-chains.json`, now structured in the chain node).
- `estimated_blast_radius_usd` (already in `curated-threat-chains.json`).

The underwriter memo rendering in `_render_underwriting_memo()` can add a one-line "Chain pattern: supply-chain-pivot (observed blast radius: $15M)" line by reading the chain node that matches the kill-chain depth and technique set. This is a ~20-line change to `agent.py`. It ties the Decepticon wiki directly into the existing demo flow without restructuring anything.

---

## Sources

- Karpathy LLM wiki pattern: https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f
- MITRE ATT&CK technique catalogue (technique ids verified against mapper.py): https://attack.mitre.org/techniques/
- rank_bm25 Python package (BM25 indexing, no server): https://pypi.org/project/rank-bm25/
- `finetune/python/decepticon/mapper.py` (all 9 capability keys, 8 technique entries, verified)
- `demo/curated-threat-chains.json` (10 package entries, structured attack_chain phases)
- `finetune/MODEL_CARD.md` (block-recall 0/5 on test; the documented weakness this design addresses)
- `finetune/python/pipeline/sft_pair_builder.py` (_VALID_SOURCES controlled vocabulary)
- `chat/agent.py` (_kill_chain_attack, _render_underwriting_memo - existing injection points)
