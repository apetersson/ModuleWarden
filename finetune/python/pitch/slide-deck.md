# ModuleWarden Slide Deck

12 slides. Built for a 5 to 7 minute pitch with 2 to 3 minutes of Q&A.
Markdown for now; convert to Google Slides or Pitch once the visual
language is locked.

Speaker rotation: Andrew presents slides 1 to 4 and slide 6 (live demo).
Andreas presents 5, 7, 8, 9, 10. Either takes 12 (the ask). Slide 11
only comes out if a judge asks about model methodology.

This deck targets the Zero-One Hack FORECAST track, partner Sybilion:
probabilistic forecasting and the agent layer that acts on it. The product
one-liner: ModuleWarden uses the Sybilion forecast to RANK a team's
dependencies by forecasted growth and blast-radius trajectory, so a security
team reviews the ones climbing toward critical first, while they are still
small enough to vet. The deterministic gate is the detector; the forecast
sets the review order. The threat model is internal: the lazy submitter who
pulls an unaudited package because Copilot suggested it, and the disgruntled
submitter who slips a poisoned version into a PR on purpose.

The deck is structured around ModuleWarden v2: an agentic version-DELTA
gate for npm dependencies. The Sybilion forecast does one job: it ranks a
team's dependencies by forecasted growth and blast-radius trajectory, so the
review queue starts with the ones climbing toward critical. The forecast does
NOT detect danger and does NOT output an attack-vector probability. The gate
detects, on its own deterministic rules, by diffing the version already in the
lockfile against the version the developer just asked for. Every install routes
through the registry proxy; every gate decision pairs an `AuditDossier`
(deterministic evidence) with an `AuditReport` (model narration + cited
findings); every allow is scoped to the exact tarball hash. The deterministic
DELTA-gate is the verdict authority; the fine-tuned auditor model narrates the
evidence, it never decides. That split is forced by the data: a static
classifier on the cold package floors at AUROC 0.54 on this corpus, so the
signal is in the delta and the gate, not the model, holds authority. And we
concede a second measured limit honestly: we tested whether the forecast can
detect a dying or dangerous package directly, it cannot, and we show the data.
The story is the gate as a verifiable, attestable detection control, with the
forecast setting the review order and an agent acting on the verdict, not any
single model.

---

## Slide 1 - The problem

**Speaker note:** "npm is the largest software registry on the planet,
and the most attacked. Three million packages, two hundred thousand new
versions every week. In September 2025 a maintainer's account for
postmark-mcp got taken over and a credential exfiltration payload
shipped to fifteen hundred organizations before anyone noticed.
event-stream in 2018, ua-parser-js in 2021, the eslint-scope
compromise, the Lottiefiles incident. The pattern is the same: trusted
maintainer, one bad version, thousands of installs in the window
between push and patch. And most of the time, the install request
comes from inside the firewall. That is the threat model we work
against: the lazy submitter who asked Copilot for a CSV parser and got
three unaudited packages, and the disgruntled submitter who slips a
poisoned version into a PR on purpose. So we frame it as a forecasting
problem, but not the obvious one. The question worth forecasting is which
of your hundreds of dependencies is about to become that load-bearing
package nobody questions. We rank them by forecasted growth and the
trajectory of their blast radius, so the security team reviews the ones
climbing toward critical first, while they are still small enough to vet.
The gate detects the known-bad on its own rules; the forecast sets the
order. Verizon DBIR puts 74 percent of breaches on the human element.
AI-assisted coding amplifies the insider vector. ModuleWarden catches the
next critical package on the way up and acts at the submission boundary."

**Visual:** Timeline. X-axis: 2018 to 2026. Each named incident as a
labeled dot, sized by estimated affected installs. postmark-mcp on the
right with a red ring around it.

**Bullets:**
- 3M packages, 200K new versions per week
- postmark-mcp@1.0.16: 1,500 orgs, September 2025
- event-stream, ua-parser-js, eslint-scope: same pattern, different year
- The window between push and patch is the attack surface
- Sonatype: 512K malicious packages logged in 2024, 98.5 percent
  concentrated in npm
- 74 percent of breaches involve human element (Verizon DBIR 2024);
  AI-assisted coding (Copilot, Cursor, Claude Code) amplifies the
  insider vector
- Internal threat model: the lazy submitter (unaudited Copilot suggestion)
  and the disgruntled submitter (deliberate poisoned PR)
- The forecast ranks dependencies by forecasted growth and blast-radius
  trajectory, so the team reviews the rising-critical ones first; the gate
  detects and an agent acts on the verdict before the tarball lands

**Judges' question this answers:** "Why does this problem matter right now?"

---

## Slide 2 - Three classes of supply-chain risk

**Speaker note:** "Most tools answer 'is this package vulnerable?' after
the install. ModuleWarden's gate answers 'should this install happen at all?'
before the tarball reaches a developer machine, and the forecast tells the
team which packages to put in front of that gate first. Here is the honest
finding that shaped the detection side. We trained a static classifier on the
cold package, the way you would expect, and it floors at AUROC 0.54 on this
corpus. That is barely above a coin flip. The reason is the benchmark setup:
benign is the first-patched release of the same package, so the classifier
has to separate a malicious version from its own clean sibling on cold
features alone. That is hard on purpose, and it is the point. The signal is
not in the cold package. The signal is in the DELTA between versions. So the
deterministic delta-gate detects on the delta, and the gate, not the model,
holds verdict authority. The decisions still split into three classes. Class A:
compromised maintainer publishes a malicious version of a legitimate
package. Class B: a CVE-style vulnerability ships in an upgraded version.
Class C: a brand-new package with no predecessor to diff against. Each class
needs a different evidence pipeline and a different default verdict."

**Visual:** Top strip: the honest floor. "Cold-package static classifier:
AUROC 0.54 on this corpus (GHSA pairs, benign = first-patched release). The
signal is in the DELTA." Below that, three columns. Class A "compromised
maintainer" with postmark-mcp icon. Class B "CVE diff" with a patch icon.
Class C "cold start" with a question-mark icon. Below each: the default
verdict (block / quarantine / quarantine).

**Bullets:**
- Honest finding: a static classifier on the COLD package floors at AUROC
  0.54 on this corpus. This is WHY the gate detects on the delta, not the package.
- Class A: compromised maintainer, lifecycle script hijack, exfil pattern
- Class B: CVE-introducing or CVE-fixing diff between two real versions
- Class C: cold-start package with no predecessor for diffing
- Each class has its own dossier shape and its own default verdict
- The model narrates the rubric over the delta; the gate decides

**Judges' question this answers:** "Why not just use Snyk?"

---

## Slide 3 - Architecture

**Speaker note:** "Three layers, one architecture, and the agent acts on
the gate verdict at the end. Top layer: the deterministic 5-rule delta-gate
handles roughly 80 percent of decisions with zero LLM involvement. Release
age, lifecycle script triage, SRI checksum, source-match, allowlist. Free
and fast. This is the verdict authority. The gate decides; the model
narrates. We do not let the model decide, because on the held-out severe
cases the model's block-recall is 0 percent, so the deterministic gate has
to hold authority. Middle layer: our fine-tuned auditor model runs the
remaining 20 percent inside a per-job Docker container with run-scoped RPC
tokens and prompt secrecy guaranteed. It produces the narrated evidence
report, never a binding verdict. The audit container never sees DB credentials, Verdaccio
credentials, or the audit prompts; the client never sees the prompts
either. Bottom layer: DeepSeek V3 hosted is consulted as a second
opinion on QUARANTINE-band decisions only, about 5 percent of total.
When the two models disagree, the supersedes pointer captures the
escalation and routes to admin override. This is the reinsurance
pattern: primary writes the policy, secondary provides the second
opinion on borderline cases. Self-hosted, on-premise, no SaaS round
trip on the primary path. And the agent layer acts on the gate verdict at
submission time: block, quarantine to admin review, or admit with an
evidence memo."

**Visual:** Three stacked horizontal bands. Top band (80 percent of
decisions): deterministic 5-rule gate. Middle band (20 percent): MW
fine-tuned auditor (Qwen2.5-Coder now; 27B target) in per-job Docker
container with prompt-secrecy boundary marked. Bottom band (5 percent of total, QUARANTINE only):
DeepSeek V3 second opinion, with supersedes-pointer arrow to admin
override workflow. Verdaccio promote-only backing on the right.
Postgres lineage on the left.

**Bullets:**
- Layer 1: deterministic 5-rule gate, ~80 percent of decisions, no LLM.
  This is the verdict authority.
- Layer 2: MW fine-tuned auditor model in `packages/audit-runner` Docker
  container, prompt secrecy guaranteed. It produces the structured audit
  report for the ambiguous ~20 percent. Today a small QLoRA (Qwen2.5-Coder)
  trained on real GHSA cases; the 27B is the Leonardo scale-up target, not
  yet trained.
- Layer 3: DeepSeek V3 hosted, QUARANTINE-band only (~5 percent of
  total), captured in supersedes pointer if disagreement
- `AuditDossier`-`AuditReport` contract: stable evidence references,
  cited findings, no invented refs
- Self-hosted primary path; no developer or CI data leaves the perimeter
- Reinsurance pattern: primary writes, secondary provides borderline
  second opinion

**Judges' question this answers:** "How does this fit into a developer's
workflow?"

---

## Slide 4 - The audit contract

**Speaker note:** "The model never sees raw tarballs. ModuleWarden
preprocessors prepare a deterministic `AuditDossier`: package metadata,
release context, diff summary, dependency changes, capability deltas,
dynamic observations, and an evidence_index that lists every reference
the model is allowed to cite. The model returns an `AuditReport`:
verdict, confidence, risk_level, primary_findings, benign explanations
considered, recommended agent checks, developer-safe summary, security
admin summary, and an output integrity self-check. Every claim cites an
evidence_ref that exists in the dossier. The model that invents a
reference loses one accuracy point in eval; the model that cites a
stale reference does not."

**Visual:** Two boxes side by side. Left: `AuditDossier` with its
required fields stacked. Right: `AuditReport` with its required fields
stacked. Arrow between them labeled "model". A small inset box: the
JSON Schema files in `finetune/contracts/`.

**Bullets:**
- `AuditDossier`: deterministic evidence, prepared by ModuleWarden
- `AuditReport`: verdict + cited findings, returned by the model
- Schema-enforced contract: `finetune/contracts/audit-dossier.schema.json`
  and `finetune/contracts/audit-report.schema.json`
- Findings cite only evidence ids that appear in the dossier
- Output integrity self-check: invented refs are zero by construction

**Judges' question this answers:** "How do you stop the model from
making things up?"

---

## Slide 5 - Live demo: postmark-mcp incident replay

**Speaker note:** "This is the gate replaying the September postmark-mcp
incident. Faithful reconstruction of version 1.0.16, the one that
shipped credential exfiltration. We run it through the deterministic
policy first, then ask the fine-tuned auditor for the `AuditReport`,
then show the PI agentic harness confirming the verdict with real
tool calls inside the audit container. Watch the rule table, the
report, and the evidence memo that drops out."

The speaker runs the demo. `python -m demo.run_incident_replay
--incident postmark-mcp-1.0.16`. Show the colored rule table, the
BLOCK verdict, the generated Control Evidence Memo, and the agentic
tool-call timeline. Then run the clean baseline (`postmark-mcp-1.0.12`)
and the popular-package baseline (`lodash-4.17.21`) to prove the gate
is not just stamping BLOCK on everything. Total demo time: 90 seconds.

**Visual:** The slide IS the terminal split with a memo pane. Project
the laptop screen full-screen. Backup slide carries a screenshot of the
expected output in case the network fails (the demo itself is fully
offline).

**Bullets (only visible on the backup slide):**
- `python -m demo.run_incident_replay --incident postmark-mcp-1.0.16`
  -> BLOCK with cited findings
- Memo written to `demo/outputs/postmark-mcp-1.0.16__2026-05-28.md`
- `--incident postmark-mcp-1.0.12` -> ALLOW (last known clean release)
- `--incident lodash-4.17.21` -> ALLOW (popular package baseline)

**Judges' question this answers:** "Show me it actually works."

---

## Slide 6 - Review by trajectory

**Speaker note (about 30 seconds):** "A forecast you do not act on is a
chart. Here is the act. This is a real team's dependency list, ranked by the
Sybilion forecast: each dependency scored on growth and blast-radius
trajectory, sorted so the ones climbing toward critical surface at the top.
A reviewer reads top-down. The deps near the top are the ones to vet now,
while they are still small enough to read in an afternoon. The gate flags
which of these to block, quarantine, or allow on the next install delta. The
forecast does not decide and does not detect; it prioritizes the queue. The
gate detects the known-bad and owns the verdict. So a security team spends
its limited review hours on the dependencies most likely to matter, not on
the alphabetical first ten."

**Visual layout:**

A single ranked table. One row per dependency, sorted by forecasted
trajectory, climbing-toward-critical at the top.

| Dependency | Forecast band | Trajectory | Gate on last delta |
|---|---|---|---|
| (top dep) | climbing to critical | steep up | review now |
| (next dep) | elevated | rising | watch |
| ... | ... | ... | ... |
| (bottom dep) | stable | flat | clear |

Right edge: a small sparkline per row showing the growth/blast-radius
trajectory the rank is keyed off.

**Bullets (small, under the visual):**
- Rank is forecasted trajectory, not a danger score; the forecast
  prioritizes, it does not detect
- The deterministic gate detects the known-bad and decides the verdict
- The reviewer works top-down, vetting the climbers first
- Band and slope come from the Sybilion forecast on the version delta

**Judges' question this answers:** "What does the forecast actually do?"

---

## Slide 7 - Honest about uncertainty

**Speaker note (about 30 seconds):** "Here is the result we could have
hidden and did not. We tested whether the forecast can detect a dying or
compromised package on its own, straight from band and slope. It cannot. A
package that is quietly dying and a healthy one do not separate on the
trajectory signal; the bands overlap. And on the cold package, a static
classifier floors at AUROC 0.54 on this corpus, which is barely above a coin
flip. We show the data rather than dress it up. This is exactly why the
architecture is gate-decides, forecast-prioritizes, model-narrates. We do
not let the forecast pretend to be a detector. False certainty is worse than
honest uncertainty, because a confident wrong verdict is the one a reviewer
trusts and a real attacker walks past."

**Visual layout:**

Two small charts side by side, plus a one-line takeaway strip.

| Left chart | Right chart |
|---|---|
| Trajectory band overlap: dying vs healthy distributions sit on top of each other, no clean separation | Cold-package static classifier ROC, AUROC 0.54, sitting on the diagonal |

Takeaway strip below both:

**The forecast ranks. It does not detect. The gate detects.**

**Bullets (small, under the visual):**
- Negative result, shown on purpose: band and slope do not separate dying
  from healthy
- Cold-package static classifier floors at AUROC 0.54 on this corpus
- This is why verdict authority sits in the deterministic gate, not the
  model
- False certainty is worse than honest uncertainty

**Judges' question this answers:** "What does your forecast NOT do?"

(If a commercial judge presses on who buys this, the archived cyber-insurance
economics in `pitch/archive-insurance/` are the one-line downstream-application
fallback.)

---

## Slide 8 - Roadmap

**Speaker note:** "What ships next. The PI agentic harness already runs
arms 3 and 4 of the eval matrix; we want federated learning across
customer audit decisions so the model improves without anyone shipping
us their code. PyPI is the obvious second ecosystem because the proxy
pattern is identical and the OSV dataset already exists. RubyGems is
quarter after that. And SOC 2 Type II is the artifact that turns the
gate into a billable enterprise control instead of a pilot."

**Visual:** Three columns. Q3 2026: federated audit, PyPI proxy.
Q4 2026: RubyGems, custom-rule SDK. 2027: SOC 2 Type II, registry
mirror integration.

**Bullets:**
- Federated audit: customer decisions improve the model, code stays local
- PyPI: next ecosystem, same proxy architecture, Q3 2026
- RubyGems: Q4 2026
- Custom-rule SDK so customers can ship their own deterministic checks
- SOC 2 Type II: turns the gate into a billable enterprise control

**Judges' question this answers:** "Where does this go after the hackathon?"

---

## Slide 9 - Team

**Speaker note:** "Andrew is the ML lead. Built the v1 classifier, the
training pipeline, and ran the Leonardo job. Andreas is the systems
engineer. Built the registry proxy, the policy engine, the
`AuditDossier`-`AuditReport` contract, and the PI agentic harness. We
have been collaborating on supply chain tooling for three years and
have shipped together before."

**Visual:** Two photos, name, one-line description. No long CVs.

**Bullets:**
- Andrew Demczuk: ML engineering, training pipeline, eval matrix
- Andreas Petersson: systems engineering, registry proxy, policy engine,
  PI agentic harness
- Three years of collaboration on supply chain tooling

**Judges' question this answers:** "Can you actually build this past
Sunday?"

---

## Slide 10 - What is and is not shipped

**Speaker note:** "Honest scope. The registry proxy, the policy engine,
the `AuditDossier`-`AuditReport` contract, the corpus walker, the
abliteration and SFT training pipeline, the PI agentic harness, the
4-arm eval matrix runner, and the postmark-mcp incident replay all
work end to end and are in the repo. One thing we knowingly punted:
the federated audit feedback loop is sketched in the roadmap but
deliberately out of scope for the hackathon submission."

**Visual:** Two-column table. Left: "Ships in v2.0". Right: "Knowingly
deferred". Each side has a bulleted list. No padding or bluffing.

**Bullets (left):**
- Registry proxy with metadata rewrite and tarball serving
- Deterministic policy engine
- `AuditDossier`-`AuditReport` contract with schema enforcement
- Corpus walker: scraped-cases.jsonl -> sft-records.jsonl
- Abliteration + SFT LoRA (Qwen2.5-Coder trained now; Qwen3.6-27B target)
- PI agentic harness (`packages/audit-runner`)
- 4-arm eval matrix runner
- postmark-mcp incident replay with Control Evidence Memo

**Bullets (right):**
- Federated audit feedback loop across customer deployments
- PyPI proxy beyond a stub

**Judges' question this answers:** "What is real and what is hand-waved?"

---

## Slide 11 - Eval methodology (held in reserve)

**Speaker note:** Only show this slide if a judge asks about the model
side, and be precise about what is trained versus planned. "We have a real
trained model: a QLoRA fine-tune of Qwen2.5-Coder on 386 real GHSA
dossier-to-report records, evaluated on a held-out split. Honest current
result on the 0.5B: base produces no parseable verdict (0 percent),
fine-tuned reproduces the gold verdict 46.7 percent of the time - the lift
shows the data and pipeline work end to end, and the model is a narrator,
not the verdict authority (the deterministic gate is). The 1.5B local run is
VRAM-bound on this box; the 27B is the Leonardo scale-up. The planned 4-arm
matrix (base vs fine-tuned, one-shot vs PI agentic harness) reports malicious
catch rate, benign false quarantine/block rate, JSON validity, evidence
citation accuracy, missed deltas, runtime, tool call count.
Output ships as a JSON document per run; we can show the per-arm
breakdown to confirm the model is not just memorizing the synthetic
distribution."

**Visual:** Data flow diagram. Boxes: scraped-cases.jsonl, corpus
walker, train (70 percent), val (15 percent), test (15 percent), then
the 4-arm matrix. Arrows between. Model card style.

**Bullets:**
- 70 / 15 / 15 split BY PACKAGE NAME (no package leaks across splits)
- 4-arm matrix per `finetune/README.md`
- 7 metrics tracked per arm and per case
- Per-case results ship in `finetune/python/eval/results/matrix-{timestamp}.json`
- The agentic arms degrade to `status=unavailable` when the audit-runner
  binary is not built, so silent failure cannot happen

**Judges' question this answers:** "How do I know your model numbers
are not overfit?"

---

## Slide 12 - Ask

**Speaker note:** "Three asks. First, a forecasting research collaboration
with Sybilion. Your forecast already separates a rising dependency from a
fading one, which is what lets us rank by trajectory. The security-native
drivers, the signals that tell software adoption apart from commodity demand,
that is the new surface to build together; your driver lake came back
commodity and macro for npm. We want to take that ranking signal to the
harder dependency surfaces in your domain. Second, a structured 6-to-8 week
pilot with a downstream actor: a cyber underwriting team on a defined cohort
of software-reliant insureds, with explicit KPIs: block precision, override
burden, evidence usefulness for underwriting review, and feasibility of
attaching control language to a renewal questionnaire. This is the worked
application of acting on the gate verdict and the memo. Third, outcome-based
pilot funding or compute support tied to scaling the model on block-recall,
the metric that matters and the one the 27B Leonardo run earns. None of this
is generic. Each ask is what we need to turn ModuleWarden from a hackathon
prototype into a production submit-time detection control, with the forecast
ranking the review queue and an agent acting on the verdict."

**Visual:** Three icons with one-line asks underneath. Handshake (pilot),
clipboard (product partnership), gears (outcome funding).

**Bullets:**
- Forecasting research collaboration: build software-ecosystem drivers so the
  trajectory ranking sharpens past the commodity/macro driver lake
- Structured 6-8 week pilot with a downstream actor (cyber underwriting);
  explicit KPIs; paid if scoped against measurable outcomes
- Outcome-based pilot funding or compute support, tied to scaling the model
  on block-recall (the 27B Leonardo run)

**Judges' question this answers:** "What do you want from us?"

---

## Backup material (not slides, in the back of the deck)

- Per-arm metric breakdown from the most recent `matrix-{timestamp}.json`
- Latency benchmark at varying cache hit rates (proxy and gate)
- Comparison table: ModuleWarden vs Verdaccio vs Snyk vs Socket.dev vs
  npm audit, positioned on the gate / scan / audit axis
- Sample Control Evidence Memo rendered to PDF
- Per-rule audit log JSONL sample
- Cost-of-attack estimate: average cost per malicious install based on
  IBM Cost of a Data Breach 2024 (USD 4.91M per supply chain compromise,
  267-day mean time to identify and contain)
