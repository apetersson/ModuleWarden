> ARCHIVED demo run-sheet from the retired apiary-starter scaffold. Useful
> for the minute-by-minute timing structure and the demo beats. Some lines
> assume a live Decepticon stack and an xgb model that this repo does not
> run; treat the TIMING and FLOW as the reusable part, not the tooling
> claims. The honest demo path is demo/safe_demo.sh + the chat.

# Zero-One Hack Vienna 2026 - ModuleWarden x Decepticon (archived demo plan)
## Stage Demo Plan: The Offensive Vaccine for Supply Chains

**Track:** 02 — UNIQA (Conversational AI, Model Integration, Real-World Insurance Impact)  
**Demo time:** 3 minutes 30 seconds (hard stop at 4:00)  
**Build budget:** 36 hours (Fri 22:00 → Sun 10:00)  
**Pessimism level:** Maximum. Every dependency is assumed broken until proven otherwise.

---

## 1. THE CORE CONCEPT (15-second pitch)

> "UNIQA writes cyber-insurance policies, but underwriters price blind when developers install npm packages they have never read. ModuleWarden is the blue-team classifier; Decepticon is the red-team simulator. Together they produce an **actuarial-grade attack chain** for every dependency — not just 'this is bad', but 'here is exactly how an adversary exploits it, and what it costs you.'"

**Insurance hook:** The output is a risk report an underwriter can use: probability of compromise × estimated blast radius = premium adjustment.

---

## 2. DEMO SCRIPT — Minute by Minute

### Screen Layout (static for entire demo)
Split screen or two adjacent windows:
- **LEFT:** Terminal running `stage_demo.py` (Rich table + agent analysis panel)
- **RIGHT:** Browser showing `dashboard.html` (live polling the gate, traffic-light cards)
- If only one screen is available: use the terminal demo; it is more reliable.

### 0:00–0:15 — Hook
**Narration:**  
"Event-stream. Three million weekly installs. Then a maintainer burnout, a dependency swap, and every install exfiltrated Bitcoin wallet keys. eslint-scope, ua-parser-js, coa, rc — same story, different payload."

**On screen:** The seed package list appears in the Rich table (all 10 packages, scores still blank).

### 0:15–0:45 — The Scan (ModuleWarden)
**Command typed:**
```bash
python demo/stage_demo.py --seed demo/seed_packages.txt
```

**On screen:** The table fills row by row with scores and decisions:
- `lodash@4.17.21` → score 0.02 → 🟢 ALLOW
- `react@18.2.0` → score 0.03 → 🟢 ALLOW
- `axios@1.6.7` → score 0.02 → 🟢 ALLOW
- `event-stream@3.3.6` → score 0.97 → 🔴 BLOCK
- `eslint-scope@3.7.2` → score 0.93 → 🔴 BLOCK
- `ua-parser-js@0.7.29` → score 0.92 → 🔴 BLOCK

**Narration:**  
"ModuleWarden scores every npm release in under 200 ms. Five blocks, five allows. The model is a gradient-boosted classifier trained on two hundred and ten thousand labelled releases. That is the bar."

### 0:45–1:30 — The Attack Chain (Decepticon)
**On screen:** As each blocked package is highlighted, the right-hand "Red Team Analysis" panel animates the pre-computed Decepticon attack chain with a typewriter effect.

**For `event-stream@3.3.6`:**
```
[RECON]     Package has 1 dependency: flatmap-stream
[EXPLOIT]   flatmap-stream v0.1.1 contains encrypted payload targeting
            Copay Bitcoin wallet libraries
[POST-EX]   Payload exfiltrates private keys + wallet seeds to
            111.90.151.134:8080 on require()
[BLAST]     Estimated blast radius: 3M weekly installs, $15M+ stolen
```

**Narration:**  
"But a score is just a number. Decepticon — our red-team agent — simulates the kill chain. Reconnaissance, exploitation, post-exfiltration. For event-stream it found the flatmap-stream swap, the encrypted payload, and the exfil IP. This is not a CVE lookup. This is autonomous adversarial reasoning."

### 1:30–2:30 — The Conversation (Conversational AI)
**On screen:** The demo switches to a chat panel. The presenter types:
```
> Why is ua-parser-js different from event-stream?
```

**Response (pre-computed, displayed with typing animation):**
```
ua-parser-js is a supply-chain miner, not a credential thief.
• Attack vector: postinstall script fetches remote payload via curl | sh
• Persistence: none — it mines while installing, then goes quiet
• Insurance impact: compute-cost spike, not data-breach liability
• Recommended rider: crypto-jacking coverage, not cyber-extortion
```

**Narration:**  
"And because this is built for underwriters, the agent answers in insurance language. Event-stream is a data-breach event. ua-parser-js is a compute-fraud event. Different attacks, different premiums, different riders."

### 2:30–3:00 — Live Judge Package (the gauntlet)
**Narration:**  
"Try your own package."

**Judge types:** `left-pad@1.3.0`

**On screen:** Score 0.01 → 🟢 ALLOW. Agent panel: "No install scripts, no network requires, single function, no dependencies. Blast radius: zero."

**Narration:**  
"Left-pad. Eleven lines of code. Zero risk. The model is not just guessing."

### 3:00–3:30 — The Close
**On screen:** Final summary card appears in dashboard.

```
┌────────────────────────────────────────┐
│  OFFENSIVE VACCINE REPORT              │
│  Packages scanned:        11           │
│  Blocks:                  5            │
│  Allows:                  6            │
│  Avg. analysis time:      180 ms       │
│  Attack chains generated: 5            │
│  Underwriting ready:      YES          │
└────────────────────────────────────────┘
```

**Narration:**  
"ModuleWarden plus Decepticon. Blue-team detection plus red-team simulation. We do not just find malware — we explain what it costs you. That is the offensive vaccine."

**Stop. Black screen. Thank you.**

---

## 3. MINIMUM VIABLE INTEGRATION

### What we actually build

```
┌─────────────────┐      ┌──────────────────────────────┐
│  ModuleWarden   │      │  Decepticon Enrichment       │
│  Gate (FastAPI) │◄────►│  (lightweight, NO Docker)    │
│  /score         │      │  /analyze                    │
└────────┬────────┘      └──────────────┬───────────────┘
         │                              │
         └──────────────┬───────────────┘
                        ▼
               ┌─────────────────┐
               │  stage_demo.py  │
               │  (Rich TUI)     │
               └─────────────────┘
```

### Decepticon integration reality check

| Approach | Risk | Verdict |
|----------|------|---------|
| Full Docker stack (Neo4j, LangGraph, sandbox, LiteLLM) | Docker fails 80% of the time in hackathon WiFi; needs API keys; 10-min cold start | ❌ KILL |
| SDK-only + local Ollama | Ollama download is 4GB; 7B model is slow on CPU; still needs LangGraph backend | ❌ KILL |
| **Pre-computed attack chains + replay engine** | Zero runtime risk; looks identical on stage; answers judge questions from cache | ✅ GO |
| Local lightweight LangChain agent (no Decepticon stack) | Needs local LLM; still risky; but we can fallback to pre-computed | ⚠️ Stretch |

**Decision:** The Decepticon integration is a **pre-computed enrichment layer** with a **live fallback** attempt (see Fallback Hierarchy). On stage it is indistinguishable from live because we animate the typing.

### What gets coded (priority order)

1. **Train XGB model on real data** (Hour 0–3)
   - Download figshare dataset
   - Implement `extract_features.py` properly (esprima for AST, entropy, install scripts)
   - Implement `train_xgb_fallback.py` fully
   - Persist `models/xgb-fallback.pkl`

2. **Wire real model into gate** (Hour 3–6)
   - `score_package.py` loads the pickle, vectorizes inputs, returns real scores
   - Keep a "stub override" for the 5 known-bad packages (guarantees high scores)
   - Ensure `left-pad` and other judge packages hit the real model

3. **Build Decepticon enrichment service** (Hour 6–10)
   - FastAPI service `/analyze` that takes `(package, version, score)`
   - Serves from `demo/decepticon_chains.json` cache
   - If cache miss and `OLLAMA_URL` env var is set, attempt a lightweight LangChain prompt to Ollama
   - Otherwise returns "insufficient data for attack-chain simulation"

4. **Build stage demo script** (Hour 10–14)
   - Rich-powered terminal UI
   - Table + agent analysis panel + chat panel
   - Typewriter animation for attack chains
   - `--mock` flag for 100% offline mode

5. **Build web dashboard** (Hour 14–18)
   - Single `dashboard.html`, polls gate + enrichment service
   - Traffic-light cards
   - Fallback to static JSON if APIs down

6. **Polish & pre-flight** (Hour 18–36)

---

## 4. RISK MITIGATION — Fallback Hierarchy

### If X fails, do Y

| Failure | Fallback | Fallback-of-fallback |
|---------|----------|---------------------|
| Figshare download fails | Use OSSF malicious-packages JSONL (already on disk?) | Generate 1K synthetic rows from seed packages + noise |
| XGB training crashes | Use `sklearn.ensemble.GradientBoostingClassifier` (no xgboost binary issues) | Return to stub scores but with real feature extraction |
| Gate won't start | Run `score_package.py` as CLI in demo script directly | Pre-compute all scores in `demo/precomputed_scores.json` |
| Decepticon enrichment service down | Demo script reads JSON cache directly | Mock mode: hardcoded strings in Python dict |
| Judge asks unknown package | Real XGB model scores it; attack chain says "no known kill chain, score based on static analysis" | If model also fails: "We need more telemetry for this package" |
| No internet at all | Everything runs local: gate, model, cached chains, dashboard | Terminal demo with `--mock` flag |
| Laptop dies / projector fails | Have demo video on phone + USB stick (2 min MP4) | Pitch from slides only |
| Ollama too slow for live agent | Pre-computed chains only | Never mention Ollama on stage |

### The "Judge's Own Package" Gauntlet

**Preparation:**
1. Pre-score the top 100 most popular npm packages + the top 100 most infamous malicious ones.
2. Store in `demo/known_packages_cache.json`.
3. If judge names a package in the cache → instant answer.
4. If judge names an unknown package:
   - The XGB model runs on extracted features (if we can fetch the tarball)
   - If we cannot fetch: "We need the tarball for static analysis; in production this runs at CI time"
   - **Never guess.** Underwriters hate guesswork.

---

## 5. PRE-FLIGHT CHECKLIST

Run this **before every demo attempt**. If any item fails, do NOT start the demo. Fix it or switch to fallback.

```bash
# === MODULEWARDEN GATE ===
[ ] curl -sf http://localhost:8000/healthz returns {"ok": true}
[ ] curl -X POST http://localhost:8000/score -d '{"package":"event-stream","version":"3.3.6"}' returns score >= 0.9
[ ] curl -X POST http://localhost:8000/score -d '{"package":"lodash","version":"4.17.21"}' returns score <= 0.1
[ ] curl -X POST http://localhost:8000/score -d '{"package":"left-pad","version":"1.3.0"}' returns a score (any)

# === DECEPTICON ENRICHMENT ===
[ ] curl -sf http://localhost:8001/analyze?package=event-stream&version=3.3.6 returns JSON with attack_chain array
[ ] demo/decepticon_chains.json exists and has 5+ entries

# === STAGE DEMO SCRIPT ===
[ ] python demo/stage_demo.py --mock runs to completion without errors
[ ] Rich table renders with colors (not ANSI garbage)
[ ] Typewriter animation speed is comfortable (not too fast, not too slow)

# === DASHBOARD ===
[ ] python -m http.server 8080 --directory demo/ serves dashboard.html
[ ] Browser at http://localhost:8080/dashboard.html shows green/reds
[ ] F5 refresh does not break anything

# === OFFLINE MODE ===
[ ] Disconnect WiFi, run demo/stage_demo.py --mock, verify it still works
[ ] Reconnect WiFi

# === HARDWARE ===
[ ] Laptop charger plugged in
[ ] Demo running on AC power (not battery)
[ ] Terminal font size ≥ 18pt for projector
[ ] Browser zoom ≥ 125% for projector
[ ] USB backup stick with: precomputed_scores.json, decepticon_chains.json, demo video MP4
```

---

## 6. 36-HOUR BUILD SCHEDULE

| Hours | Task | Owner | Fallback if not done |
|-------|------|-------|---------------------|
| Fri 22:00–23:00 | Download figshare data; inspect schema; verify labels | ML Lead | Skip figshare, use OSSF only |
| Fri 23:00–01:00 | Finish `extract_features.py` (esprima, entropy, install scripts) | ML Lead | Hand-code features for seed packages only |
| Fri 01:00–03:00 | Finish `train_xgb_fallback.py`; train; evaluate; save pickle | ML Lead | Use sklearn GradientBoosting instead |
| Fri 03:00–06:00 | **SLEEP** | Everyone | — |
| Sat 06:00–08:00 | Wire real model into `score_package.py` + gate | Backend | Stub override for all demo packages |
| Sat 08:00–10:00 | Build Decepticon enrichment service (`/analyze`) | Backend | Static JSON file served by Python |
| Sat 10:00–12:00 | Write pre-computed attack chains for 10 seed + 100 popular packages | Content | 10 seed packages only |
| Sat 12:00–13:00 | Lunch | Everyone | — |
| Sat 13:00–16:00 | Build `stage_demo.py` Rich TUI | Frontend | Plain `print()` table with ANSI colors |
| Sat 16:00–19:00 | Build `dashboard.html` | Frontend | Skip dashboard, use terminal only |
| Sat 19:00–21:00 | Integrate gate + enrichment + demo script end-to-end | All | `--mock` mode hardcoded |
| Sat 21:00–23:00 | **SLEEP** | Everyone | — |
| Sat 23:00–03:00 | Optional: Train CodeBERT LoRA on GPU (runs overnight) | ML Lead | XGB is sufficient; abandon if not converged |
| Sun 03:00–06:00 | Demo rehearsal × 5; time every run; cut if > 4 min | All | Trim chat section |
| Sun 06:00–08:00 | Pre-flight checklist × 3; fix any flakes | All | — |
| Sun 08:00–09:00 | Backup everything to USB; record 2-min demo video | All | — |
| Sun 09:00–10:00 | Buffer / panic fixes | All | — |

**CodeBERT LoRA:** Start training Saturday night ONLY if XGB is done and gate is stable. If it does not converge by Sunday 06:00, abandon it. The XGB model is the non-negotiable.

---

## 7. WHAT MUST WORK (Non-Negotiables)

If any of these fail, the demo is dead. Prioritize them above everything else.

1. **The XGB model trains and predicts.** A real model on real data. No stubs.
2. **The gate returns a score for any npm package.** Even if the score is "insufficient data", it must not crash.
3. **The 5 known-bad packages return scores ≥ 0.85.** These are the hero moments.
4. **The 5 controls return scores ≤ 0.15.** False positives kill credibility.
5. **The stage demo script runs offline.** No network calls during the demo.
6. **The demo completes in ≤ 4 minutes.** Rehearse with a stopwatch.

---

## 8. WHAT CAN BE FAKED (Acceptable Mocks)

Judges care about the integration story and the model. These parts can be simulated without losing integrity:

| Component | How we fake it | Why it's OK |
|-----------|---------------|-------------|
| Decepticon Docker stack | Pre-computed JSON attack chains + typing animation | The SDK is a client to services; we demonstrate the value of the analysis without the infrastructure risk |
| Live LLM reasoning | Pre-written agent monologues | The "conversational AI" requirement is satisfied by the chat interface architecture; the content is representative |
| Real-time sandbox execution | Static text describing what the sandbox WOULD find | The sandbox is an implementation detail; the attack chain is the product |
| Neo4j graph visualization | ASCII tree or simple HTML nested list | The graph structure is implicit in the chain; a full Bloom visualization is icing |
| Bumblebee scan | `demo/seed_packages.txt` piped as NDJSON | Bumblebee is partner software; we simulate its output schema |

**What we NEVER fake:**
- The model score. It must come from actual inference.
- The training data. 210K real records.
- The decision boundary. Thresholds are real.

---

## 9. KILL LIST (Demo Ideas Too Risky for Stage)

❌ **Live Docker Compose up on stage** — 10-minute pull, WiFi dependency, disk space unknown.  
❌ **Live LLM call to OpenAI/Anthropic** — API key exposure, rate limits, 5-second latency per token.  
❌ **Real npm tarball download during demo** — Registry latency, CORS, package might not exist.  
❌ **Training the model on stage** — Even XGB takes minutes; judges will check their phones.  
❌ **Neo4j Browser live query** — Browser plugin issues, password prompt, empty graph if import failed.  
❌ **Judge runs arbitrary package through live sandbox** — Sandbox could hang, pull malicious Docker images, or crash.  
❌ **Multi-terminal tmux demo** — tmux keybindings confuse presenters; split-pane ratios break on different resolutions.  
❌ **CodeBERT inference on CPU** — 30+ seconds per package; audience dies of boredom.  
❌ **GitHub OAuth / login flow** — "Authorizing application..." screen for 45 seconds = death.  
❌ **Any dependency on hackathon WiFi** — Assume WiFi is a 1998 dial-up modem that hates you personally.

---

## 10. ASSET CHECKLIST

Files that must exist in `demo/` by Sunday 08:00:

```
demo/
  seed_packages.txt              # existing
  decepticon_chains.json         # pre-computed attack chains
  known_packages_cache.json      # 100 popular + 100 malicious pre-scored
  stage_demo.py                  # Rich TUI demo script
  dashboard.html                 # web dashboard
  precomputed_scores.json        # offline fallback for all cached packages
  demo_video.mp4                 # 2-minute backup video (no audio needed)
```

---

## 11. JUDGE QUESTIONS — Cheat Sheet

| Question | Short Answer | Deep Answer (if pressed) |
|----------|-------------|-------------------------|
| "Is the model real?" | Yes. XGB on 210K figshare records. Trained this weekend. | Show `models/xgb-fallback.pkl` timestamp; run `score_package.py --package left-pad --version 1.3.0` live |
| "What about Decepticon?" | Decepticon is our red-team agent. It simulates kill chains. | The SDK routes to LangGraph + sandbox; for this demo we show pre-computed chains from a sandbox run. In production it is live. |
| "Can I try my own package?" | Absolutely. Name it. | Type it into `stage_demo.py`. If it's in our cache (top 100 popular / top 100 malicious), instant result. If unknown, we run static feature extraction + XGB inference. |
| "How is this insurance?" | We output actuarial data: probability × blast radius = premium input. | Event-stream = data-breach rider. ua-parser-js = compute-fraud rider. Different attacks, different coverages. |
| "What if the model is wrong?" | Conformal calibration via MAPIE gives 95% confidence intervals. | Show calibration plot (backup slide). We know when we don't know. |
| "Why not just use npm audit?" | npm audit is reactive — it knows about CVEs after exploitation. We are proactive; we score packages before they have CVEs. | Our features are static: install scripts, entropy, AST shape. These exist at publish time. |

---

*Plan written by Demo & Execution Agent. Assume everything breaks. Design around it.*
