# ModuleWarden Slide Deck

12 slides. Built for a 5 to 7 minute pitch with 2 to 3 minutes of Q&A.
Markdown for now; convert to Google Slides or Pitch once the visual
language is locked.

Speaker rotation: Andrew presents slides 1 to 4 and slide 6 (live demo).
Andreas presents 5, 7, 8, 9, 10. Either takes 12 (the ask). Slide 11
only comes out if a judge asks about model methodology.

This deck targets the Zero-One Hack FORECAST track, partner Sybilion:
probabilistic forecasting and the agent layer that acts on it. The product
one-liner: ModuleWarden forecasts the probability that a dependency a
developer is about to pull into the company codebase is a supply-chain
attack vector, and an agent acts on it at submission time. The threat model
is internal: the lazy submitter who pulls an unaudited package because
Copilot suggested it, and the disgruntled submitter who slips a poisoned
version into a PR on purpose.

The deck is structured around ModuleWarden v2: an agentic version-DELTA
gate for npm dependencies. The thing we forecast is the change between the
version already in the lockfile and the version the developer just asked
for, not the cold package. Every install routes through the registry proxy;
every gate decision pairs an `AuditDossier` (deterministic evidence) with an
`AuditReport` (model narration + cited findings + a probability); every allow
is scoped to the exact tarball hash. The deterministic DELTA-gate is the
verdict authority; the fine-tuned auditor model narrates the forecast, it
never decides. That split is forced by the data: a static classifier on the
cold package floors at AUROC 0.54 on this corpus, so the signal is in the
delta and the gate, not the model, holds authority. The story is the gate as
a verifiable, attestable forecasting control with an agent acting on the
forecast, not any single model.

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
comes from inside the firewall. That is the threat model we forecast
against: the lazy submitter who asked Copilot for a CSV parser and got
three unaudited packages, and the disgruntled submitter who slips a
poisoned version into a PR on purpose. So we frame it as a forecasting
problem. A developer is about to pull a dependency version into the
company codebase. Forecast the probability that this specific version
delta is a supply-chain attack vector, then have an agent act on the
forecast before the tarball lands. Verizon DBIR puts 74 percent of
breaches on the human element. AI-assisted coding amplifies the insider
vector. ModuleWarden forecasts at the submission boundary and acts on
the forecast."

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
- The decision is a submit-time forecast: probability the version delta is
  an attack vector, then an agent acts on it before the tarball lands

**Judges' question this answers:** "Why does this problem matter right now?"

---

## Slide 2 - Three classes of supply-chain risk

**Speaker note:** "Most tools answer 'is this package vulnerable?' after
the install. ModuleWarden forecasts 'should this install happen at all?'
before the tarball reaches a developer machine. Here is the honest finding
that shaped the whole architecture. We trained a static classifier on the
cold package, the way you would expect, and it floors at AUROC 0.54 on this
corpus. That is barely above a coin flip. The reason is the benchmark setup:
benign is the first-patched release of the same package, so the classifier
has to separate a malicious version from its own clean sibling on cold
features alone. That is hard on purpose, and it is the point. The signal is
not in the cold package. The signal is in the DELTA between versions. So we
forecast the delta, and the deterministic delta-gate, not the model, holds
verdict authority. The decisions still split into three classes. Class A:
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
  0.54 on this corpus. This is WHY we forecast the delta, not the package.
- Class A: compromised maintainer, lifecycle script hijack, exfil pattern
- Class B: CVE-introducing or CVE-fixing diff between two real versions
- Class C: cold-start package with no predecessor for diffing
- Each class has its own dossier shape and its own default verdict
- The model narrates the rubric over the delta; the gate decides

**Judges' question this answers:** "Why not just use Snyk?"

---

## Slide 3 - Architecture

**Speaker note:** "Three layers, one architecture, and the agent acts on
the forecast at the end. Top layer: the deterministic 5-rule delta-gate
handles roughly 80 percent of decisions with zero LLM involvement. Release
age, lifecycle script triage, SRI checksum, source-match, allowlist. Free
and fast. This is the verdict authority. The gate decides; the model
narrates. We do not let the model decide, because on the held-out severe
cases the model's block-recall is 0 percent, so the deterministic gate has
to hold authority. Middle layer: our fine-tuned auditor model runs the
remaining 20 percent inside a per-job Docker container with run-scoped RPC
tokens and prompt secrecy guaranteed. It produces the narrated forecast and
a probability, never a binding verdict. The audit container never sees DB credentials, Verdaccio
credentials, or the audit prompts; the client never sees the prompts
either. Bottom layer: DeepSeek V3 hosted is consulted as a second
opinion on QUARANTINE-band decisions only, about 5 percent of total.
When the two models disagree, the supersedes pointer captures the
escalation and routes to admin override. This is the reinsurance
pattern: primary writes the policy, secondary provides the second
opinion on borderline cases. Self-hosted, on-premise, no SaaS round
trip on the primary path. And the agent layer acts on the forecast at
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

## Slide 6 - The agent layer that acts on the forecast

**Speaker note (about 30 seconds):** "A forecast nobody acts on is a chart.
Here is one downstream actor who acts on it: a cyber underwriter. This is
the agent layer reading the forecast and the evidence memo. Take a real
underwriting profile. An 18M EUR Austrian SME, around 80 developers,
JavaScript and Python stack. Their cyber premium today sits at 142k a year.
The expected loss ratio on the account is 41 percent, anchored to NAIC and
Munich Re 2024 figures. After ModuleWarden is deployed, every install routes
through the gate and every decision ships with a Control Evidence Memo. The
underwriter acts on the forecast: apply Coalition's published control-class
credit of 12.5 percent, plus the reduction in supply chain exposure that
Verizon and Sonatype both pin at the install layer. Year 1 premium drops to
121k. Loss ratio drops to 27 to 30 percent. The customer renews and the
carrier picks up 11 to 14 points of margin on the account. The forecast is
the product; the underwriting application is one worked example of acting
on it."

**Visual layout:**

Two columns separated by a wide arrow pointing right.

| Pre-ModuleWarden (left column) | Post-ModuleWarden (right column) |
|---|---|
| Premium: 142k EUR per year | Premium: 121k EUR per year |
| Expected loss ratio: 41 percent | Expected loss ratio: 27 to 30 percent |
| Supply chain exposure: uncontrolled | Supply chain exposure: gated, attested |
| Evidence on renewal: asserted | Evidence on renewal: queryable |

Bottom strip below the arrow:

**Margin uplift: +11 to +14 percentage points per account**

**Bullets (small, under the visual):**
- 142k baseline anchored to Austrian SME band (Stoik, Finlex)
- 41 percent loss ratio anchored to NAIC 2024 cyber report
- 12.5 percent control-class credit anchored to Coalition MDR program
- 15 percent supply chain breach share anchored to Verizon DBIR 2024
- This is the agent layer acting on the forecast, one downstream application

**Judges' question this answers:** "Who acts on the forecast, and why pay?"

---

## Slide 7 - Why the carrier wins too

**Speaker note (about 20 seconds):** "When a carrier acts on the forecast,
three things change. The at-risk account renews instead of churning to a
cheaper insurer. Margin on the account goes up by 11 to 14 points on the
eligible segment, 2 to 4 points across the full book once you weight for
eligibility. And the same control class scales. Every JavaScript-heavy
account in the book is addressable with the same memo template, the same
evidence schema, and the same actuarial tier. One forecasting control,
hundreds of accounts."

**Visual layout:**

Three large bullets, each with an icon and a one-line caption. Stacked
vertically, equal weight.

1. **Retention.** Tech-heavy SMEs are the most actively shopped segment
   in the European cyber market. The control credit is a switching-cost
   increase.
2. **+11 to +14 pt account margin, +2 to +4 pt book margin.**
   Per-account math from Slide 6. Book math weighted for eligibility.
3. **Scales across the book.** One forecasting control, one evidence
   schema, one actuarial tier. Reusable from the first account onward.

**Footer (small text):** "All numbers anchored to NAIC, Coalition,
Verizon, Sonatype, Munich Re 2024 reports. See
`pitch/underwriter-economics.md` for citations."

**Judges' question this answers:** "Is this a product or a feature?"

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
with Sybilion. Our delta-gate is a tractable instance of submit-time risk
forecasting with an agent acting on the forecast, and the honest signal is
in the delta, not the cold object (which floors at AUROC 0.54 here). We want
to take the forecasting methodology to the harder surfaces in your domain.
Second, a structured 6-to-8 week pilot with a downstream actor who acts on
the forecast: a cyber underwriting team on a defined cohort of
software-reliant insureds, with explicit KPIs: block precision, override
burden, evidence usefulness for underwriting review, and feasibility of
attaching control language to a renewal questionnaire. This is the worked
application of acting on the forecast. Third, outcome-based pilot funding or
compute support tied to scaling the model on block-recall, the metric that
matters and the one the 27B Leonardo run earns. None of this is generic.
Each ask is what we need to turn ModuleWarden from a hackathon prototype
into a production submit-time forecasting control with an agent acting on
the forecast."

**Visual:** Three icons with one-line asks underneath. Handshake (pilot),
clipboard (product partnership), gears (outcome funding).

**Bullets:**
- Forecasting research collaboration: take the delta-gate methodology to
  Sybilion's harder forecasting surfaces
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
