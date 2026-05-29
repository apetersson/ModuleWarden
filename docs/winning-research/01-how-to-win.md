# ModuleWarden - Zero-One Hack Vienna 2026: Track 02 Win Analysis

**Date:** 2026-05-29
**Track:** 02 - Conversational AI and Model Integration (UNIQA)
**Submission deadline:** Sunday, May 31 10:00 AM; final pitches 13:30

---

## 1. Hackathon Format and Judging Criteria

### Official criteria (extracted from zero-one.lumos-consulting.at)

Track-specific rubrics are released at Case Reveal, so no enumerated weights are public yet. What is published and load-bearing:

- **"A real, trained model is the bar."** Literal quote from organizers. A slide deck without a running model does not clear judging.
- **"A small model, fine-tuned on real data, with a live demo beats a big model that half-runs."** This is the stated judging philosophy - ModuleWarden's QLoRA Qwen2.5-Coder fine-tune is exactly what they are asking for.
- General criteria stated: technical depth, model quality, real-world impact, final pitch.

### Inferred weights (from hackathon judging norms, well-sourced)

Based on TAIKAI, Devpost, and observed hackathon outcomes (see sources), the distribution for an AI-in-insurance track at a supercompute hackathon is typically:

| Criterion | Inferred weight | Why it matters for ModuleWarden |
|-----------|----------------|----------------------------------|
| Technical depth | ~30% | Real fine-tune, real proxy, real MITRE mapping = strong here |
| Live demo / functional MVP | ~25% | Must run end-to-end in front of judges |
| Innovation | ~20% | "Red-team underwriter" has no prior art - differentiating |
| Real-world impact / track fit | ~15% | Must map to a UNIQA product, not a generic security tool |
| Pitch / presentation | ~10% | 6-min window per norms; judges weight it less than the demo |

**Key insight:** The GitLab AI Hackathon 2026 winner was specifically praised with "This feels like a product, not a hackathon project" - unit tests, polish, and production-quality code pushed them over comparable technical entries. ModuleWarden needs to project that same signal.

---

## 2. What Wins AI/Security Hackathons - Concrete Patterns

### Patterns from winning projects (2025-2026 sourced)

**Pattern 1: Deterministic analysis paired with LLM narration (not LLM deciding)**

The Semgrep hackathon winner "Darwin" pitted models against each other using deterministic security scan outputs to rank quality. The LLM narrated; deterministic logic decided. ModuleWarden already does this - the 5-rule gate decides, the fine-tuned model narrates. This needs to be the explicit story in the pitch.

**Pattern 2: Multi-agent architecture with named roles**

GitLab 2026 winners ran 8 specialized agents with routing logic. AgentSafe audited MCP server security posture before execution. The TRACK02-DESIGN.md already frames this (Analyst, Orchestrator, Soundwave, etc.). Make the agent names visible in the demo UI - even if they are partially hardcoded, named agents signal architecture sophistication.

**Pattern 3: Security-as-enabler, not security-as-blocker**

"CommitDNA" (Semgrep hackathon) framed security as a developer productivity tool and won. ModuleWarden should frame the gate as "underwriters bind policies faster with evidence they trust", not "we stop bad packages". Insurance angle = the gate *generates revenue*, not just reduces risk.

**Pattern 4: Working integration beats architectural completeness**

The "RiskWise: Supply Chain Risk Analysis System" won Microsoft's AI Agents Hackathon 2025 "Best Overall Agent" at $20,000. It was a supply chain risk analysis system - identical problem space. It won on working integration. ModuleWarden needs at minimum Flow A (supply-chain risk query) fully functional end-to-end.

**Pattern 5: Show the model card**

Every supercompute hackathon judges want to see training artifacts. The zero-one.lumos-consulting.at organizers are emphatic that training happened. Show loss curves, show the held-out accuracy jump (0% to 46.7%), show the dataset size (386 GHSA records, 4,212 total corpus). This is the "a real model" proof.

**Pattern 6: Quantified business impact**

Winning pitches answer "what does this cost/save in euros?" ModuleWarden already has this: p(loss) drops 0.34 to 0.02, premium loading delta of -18pp. Put these numbers in the first 60 seconds of the demo.

---

## 3. Open-Source GitHub Resources to Pull NOW

### Resource 1: OSSF Malicious Packages Feed

- **URL:** https://github.com/ossf/malicious-packages
- **License:** Apache-2.0
- **What it is:** Repository of OSV-format JSON reports for confirmed malicious packages across npm, PyPI, and other ecosystems. Updated daily. As of 2025, 454,648 malicious npm packages were documented in a single year. The September 2025 Shai-Hulud campaign compromised chalk, debug, and 16 others with 2.6 billion combined weekly downloads.
- **How it plugs into ModuleWarden:**
 - Augments the 4,212-record GHSA corpus with confirmed MAL-YYYY-NNNNN records
 - Each MAL record is OSV JSON with `affected[].package.ecosystem = "npm"`, CWE classifications, and evidence strings
 - The `evidence` field maps directly to ModuleWarden's 5-rule gate inputs (install scripts, outbound calls, env reads)
 - Provides ground-truth positives for the demo: pull `MAL-2025-46974` (debug), `MAL-2025-46985` (color@5.0.1) as live demo cases - real attacks, real names judges will recognize
- **Rough effort:** 2-3 hours. Clone the repo, filter `osv/malicious/npm/`, parse JSON, join on package name against the gate's input. A 30-line Python script produces a lookup table.
- **Demo value:** HIGH. "We tested against the Shai-Hulud campaign packages" is a concrete claim judges can verify.

### Resource 2: MITRE ATT&CK STIX Data

- **URL:** https://github.com/mitre-attack/attack-stix-data
- **License:** ATT&CK terms of use (free for commercial and academic use with attribution)
- **What it is:** STIX 2.1 JSON bundles for the full ATT&CK Enterprise matrix. Download `enterprise-attack.json` for the complete technique/tactic/group/software graph. Supply-chain-relevant techniques already mapped in TRACK02-DESIGN.md (T1195.001, T1059, T1041, T1567) are all present with full descriptions.
- **How it plugs into ModuleWarden:**
 - The existing MITRE kill-chain mapper reads technique IDs; replacing hardcoded strings with STIX-sourced descriptions adds credibility
 - `cti-python-stix2` library lets you query `attack-pattern` objects by ID in 3 lines of Python
 - For the demo: when the gate blocks a package, auto-lookup T1195.001 from STIX data and render the official MITRE description in the chat response - this turns a hardcoded string into a live query
 - For the kill-chain graph (P1 goal): STIX `relationship` objects map techniques to tactics to groups - the Neo4j/D3 visualization can be pre-seeded from this data in under an hour
- **Rough effort:** 1-2 hours. Download `enterprise-attack.json` (~13MB), index by external_id, replace hardcoded technique strings with STIX lookups. Already architecturally wired.
- **Demo value:** MEDIUM-HIGH. Shows the product is grounded in an authoritative framework, not made-up labels.

### Resource 3: GitHub Advisory Database (GHSA)

- **URL:** https://github.com/github/advisory-database
- **License:** CC-BY-4.0
- **What it is:** OSV-format JSON for every GHSA record. Currently 5,000+ npm advisories. Malware-specific advisories are exclusive to npm, published by the npm security team. The database is clonable: `git clone https://github.com/github/advisory-database` (~2GB). Alternatively, query via GitHub GraphQL API: `securityAdvisories(ecosystem: NPM, first: 100)`.
- **How it plugs into ModuleWarden:**
 - The existing 4,212-record corpus was built from GHSA - this is the live upstream. Cloning gives you the full set with 26 normalized fields per record: GHSA ID, paired CVE, CVSS scores, CWE list, affected version ranges, first-patched version.
 - Key field for the gate: `database_specific.cwe_ids` - CWE-506 (Embedded Malicious Code) flags are already in ModuleWarden's rule set.
 - For the demo: the GraphQL endpoint lets the Streamlit app query GHSA live for a given package name - show "we checked GHSA and found N active advisories" in the chat response. This replaces a static lookup with a real API call.
 - REST endpoint: `GET https://api.github.com/advisories?ecosystem=npm&type=malware` - no auth required for public advisories, rate limit 60/hr unauthenticated.
- **Rough effort:** 1 hour for the API integration. 3-4 hours if you want to diff the local corpus against the live database and show "N new advisories since our training data."
- **Demo value:** HIGH. Live API call that returns real data is the most convincing demo artifact at any hackathon.

### Resource 4: agent-service-toolkit (LangGraph + FastAPI + Streamlit)

- **URL:** https://github.com/JoshuaC215/agent-service-toolkit
- **License:** MIT
- **What it is:** Production-ready toolkit wiring LangGraph agents, FastAPI, and Streamlit into a single deployable app with streaming, chat history, and multi-agent routing.
- **How it plugs into ModuleWarden:**
 - Provides the scaffolding for the Orchestrator/Analyst/Soundwave agent names without building from scratch
 - The streaming response pattern is critical for demo polish - watching agents "think" in real time is more impressive than a loading spinner followed by a wall of text
 - Drop-in replacement for the bespoke Streamlit chat scaffold in the TRACK02-DESIGN.md build plan
- **Rough effort:** 2-4 hours to adapt to ModuleWarden's gate backend. Saves 6-8 hours vs building agent streaming from scratch.
- **Demo value:** MEDIUM. Infrastructure only; the value is in demo polish, not judging criteria.

---

## 4. What is Genuinely Missing from a Winning Track-02 Submission

### Gap 1 (CRITICAL - biggest single gap): The underwriter chat UI does not exist yet

TRACK02-DESIGN.md confirms this: "There is no UI, no assistant, no underwriter-facing anything." The track is literally called "Conversational AI and model integration." Without a working chat UI that connects to the gate, ModuleWarden cannot be judged on Track 02 criteria at all - the fine-tune and the proxy are invisible to judges.

**What "missing" means concretely:** A judge cannot type a question and get a natural language answer backed by the real gate. This is the P0 deliverable in TRACK02-DESIGN.md and it has not been built.

### Gap 2 (HIGH): No live demo script / scripted walkthrough

Winning hackathon demos run on a 6-minute clock. Without a scripted walkthrough that hits the three flows (supply chain risk query, evidence memo, simulation) in order with pre-seeded data, the demo will stall or overrun. The TRACK02-DESIGN.md has the flows designed but not a demo-day run sheet.

### Gap 3 (HIGH): No insurance-native narrative in the pitch

The current ModuleWarden framing is "npm firewall for developers." Track 02 judges are UNIQA product people who care about policy binding, premium loading, and loss ratios. The TRACK02-DESIGN.md has the reframe ("dependency risk scoring for cyber underwriters") but the landing page and deck still lead with the developer narrative. Every judge-facing artifact needs the insurance frame, not the DevSecOps frame.

### Gap 4 (MEDIUM): The model card is not demo-ready

The Qwen2.5-Coder QLoRA fine-tune achieved 46.7% held-out verdict reproduction. This is the "real model" proof. But to show it in the demo, there needs to be a visible model card page (loss curves, confusion matrix, a sample GHSA record in vs. verdict out). The TRACK02-DESIGN.md calls for this in P2 (hour 28-30) but it is the one artifact that validates the technical depth criterion - consider moving it to P1.

### Gap 5 (LOW but exploitable): No real-time adversarial signal

The OSSF malicious-packages feed sees 1,200+ new npm MAL records per month in 2025-2026. Showing a "last 24 hours: N new malicious packages detected" ticker in the Streamlit UI, fed from the OSSF feed, costs 1 hour and creates a "live threat intelligence" story that no competing team is likely to have.

---

## 5. Build Priority for the Remaining 24-36 Hours

### NOW (before any other work):
1. Scaffold the Streamlit chat UI - `st.chat_message`, sidebar applicant selector, one working flow (Flow A)
2. Wire the existing gate's `/score` endpoint into the chat response
3. Add the GHSA REST API call for live advisory lookup - 60 minutes max

### NEXT (hours 4-16):
4. Replace hardcoded MITRE strings with STIX JSON lookups
5. Add OSSF malicious-packages lookup for demo packages (debug, color, event-stream)
6. Build the model card page - loss curve PNG + sample inference

### THEN (hours 16-30):
7. PDF evidence memo generation (fpdf2, 30 lines)
8. Flow B and C (evidence memo + simulation) with partial hardcoding accepted
9. Demo run sheet: scripted 6-minute walkthrough with pre-seeded applicant data

### LAST (hours 30-36):
10. Pitch deck: 5 slides, insurance frame, euros not CVEs
11. Deploy to Streamlit Cloud or keep on localhost - judges at the venue do not need a public URL

---

## 6. Sources

- [Zero One Hack - official event page](https://zero-one.lumos-consulting.at/) - track brief, judging philosophy, GPU specs
- [Zero One Hack Docs](https://docs.zero-one.lumos-consulting.at/) - live docs; track details released at Case Reveal
- [Luma event listing](https://luma.com/nruo77gj?locale=en-GB) - partner list, confirmed UNIQA as track sponsor
- [Semgrep: What a Hackathon Reveals About AI Agent Trends 2026](https://semgrep.dev/blog/2025/what-a-hackathon-reveals-about-ai-agent-trends-to-expect-2026/) - winning patterns: Darwin multi-LLM, AgentSafe, CommitDNA
- [GitLab AI Hackathon 2026 Winners](https://about.gitlab.com/blog/gitlab-ai-hackathon-2026-meet-the-winners/) - "feels like a product" signal; multi-agent wins; UX polish as differentiator
- [OSSF Malicious Packages](https://github.com/ossf/malicious-packages) - Apache-2.0, OSV JSON, npm malware feed
- [MITRE ATT&CK STIX Data](https://github.com/mitre-attack/attack-stix-data) - enterprise-attack.json, STIX 2.1, cti-python-stix2
- [GitHub Advisory Database](https://github.com/github/advisory-database) - CC-BY-4.0, 5000+ npm advisories, OSV format, REST API
- [GitHub Blog: A Year of Open Source Vulnerability Trends 2025](https://github.blog/security/supply-chain-security/a-year-of-open-source-vulnerability-trends-cves-advisories-and-malware/) - 454,648 malicious npm packages in 2025, Shai-Hulud campaign data
- [agent-service-toolkit](https://github.com/JoshuaC215/agent-service-toolkit) - MIT, LangGraph + FastAPI + Streamlit streaming agent scaffold
- [TAIKAI: Hackathon Judging Criteria](https://taikai.network/en/blog/hackathon-judging) - standard judging weight norms
- [Devpost: Understanding Hackathon Submission and Judging Criteria](https://info.devpost.com/blog/understanding-hackathon-submission-and-judging-criteria) - 6-min demo format, scoring structure
- [Munich Re: Cyber Insurance Risks and Trends 2026](https://www.munichre.com/en/insights/cyber/cyber-insurance-risks-and-trends-2026.html) - supply chain as #1 cyber risk, aggregation risk framing
- [Xceedance: Modernizing Cyber Insurance Underwriting for AI-Era Risk](https://www.xceedance.com/the-way-forward-modernizing-cyber-insurance-underwriting-for-ai-era-risk/) - continuous API-driven risk assessment, dynamic premium adjustment
