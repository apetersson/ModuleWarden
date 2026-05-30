# Track Reframes: ModuleWarden for Sybilion, UNIQA, Infineon

Each track gets one page. The core pitch does not change. What changes is
the framing on slides 1, 8, and 12, and the buzzwords we drop into slides
3 and 4. Pick the right reframe at Case Reveal Friday night.

Prior on track fit, in descending order: Sybilion, UNIQA, Infineon.
Reasoning at the bottom.

The product one-liner, unchanged across tracks: ModuleWarden uses the Sybilion
forecast to rank a team's dependencies by forecasted growth and blast-radius
trajectory, so a security team reviews the ones climbing toward critical first,
while they are still small enough to vet. The deterministic gate detects; the
forecast sets the review order; an agent acts on the verdict at submission time.
The threat model is internal: the lazy submitter who pulls an unaudited package
because Copilot suggested it, and the disgruntled submitter who slips a poisoned
version into a PR on purpose.

---

## Sybilion Forecasting ("Zero-One Hack FORECAST") - PRIMARY TARGET

**One-line value prop:** "ModuleWarden uses the Sybilion forecast to rank a
team's dependencies by forecasted growth and blast-radius trajectory, so the
security team reviews the ones climbing toward critical first, while they are
still small enough to vet. The deterministic gate detects; an agent acts on
the verdict at submission time. Probabilistic forecasting, and the agent layer
that acts on it."

**The forecast ranks by trajectory; it does not detect.** This is the
load-bearing point for this track, and it is honest by construction. The
Sybilion forecast does not output "is package X dangerous" and it does not
output an attack-vector probability. We backtested that claim on 12 real
packages and the band and slope do not separate dangerous or declining packages
from healthy ones, so we dropped it and we show the data. What the forecast does
cleanly is tell a rising dependency from a fading one (react +144 percent,
express +89 percent on confident rising curves; deprecated ones flat or fading),
so its honest job is to order the review queue by where blast radius is heading.
The detector is the deterministic DELTA-gate: it diffs the version already in
the lockfile against the version the developer just asked for and decides on its
own rules. The model narrates the evidence, it never decides. That split falls
out of the data: a static classifier on the COLD package floors at AUROC 0.54 on
this corpus (GHSA pairs, benign = the first-patched release). The signal is in
the delta. So the architecture is gate-detects, model-narrates, forecast-ranks,
because that is where each honest signal lives.

**Sponsor-domain buzzwords to drop in:**
- "Probabilistic forecasting" (the literal track name; the forecast returns
  real quantile bands over a dependency's adoption demand, and we rank by the
  forecasted trajectory of those bands)
- "Quantile bands" (the 0.05-to-0.95 interval is real, confirmed on the live
  API; the band width routes an unforecastable package to a human)
- "Backtest" (MAPE 10.6 percent on a real package, Sybilion's own reliability
  number, so the ranking is grounded not asserted)
- "Agent layer" (the agent acts on the gate verdict at submission time: block,
  quarantine, or admit with an evidence memo)
- "Operational decision-making under uncertainty" (the academic framing of
  the submit-time gate)
- "Distribution shift" (acknowledge it: net-new attack patterns are out of
  distribution, and we say so rather than claim coverage we did not measure)

**Likely judge profile:** Two very different judges to satisfy. A
methodology-rigor judge will probe whether the forecast genuinely separates
rising from fading packages, whether the negative result (no direct detection)
is conceded honestly, and whether the AUROC floor is a real finding or a setup
artifact. A commercial-credibility judge wants to know whether the ranked review
order actually changes what a developer or a security admin does at submission
time.

They care about: forecast honesty (the measured separation is real and the
negative result is stated, no borrowed headline accuracy), the delta framing
(why the cold-package floor is the reason for the gate's architecture, not an
embarrassment), and the agent action (a forecast nobody acts on is a chart, not
a control; here it sets the review queue and the gate verdict drives the agent).

**Slide swaps:**
- Slide 1 lead: frame the npm supply-chain problem as a prioritization
  problem. "You have hundreds of dependencies you cannot review. Which one is
  about to become the load-bearing package nobody questions? Rank them by
  forecasted growth and blast-radius trajectory, review the rising-critical
  ones first while they are still small enough to vet, and have the gate detect
  the known-bad and act before the tarball lands." Keep the postmark-mcp
  timeline, but the framing is rank-then-act, not scan-after-install.
- Slide 2 lead: the honest finding. A static classifier on the cold package
  is AUROC 0.54 on this corpus. That is barely above a coin flip, and it is
  WHY the gate detects on the delta and why the deterministic gate, not the
  model, holds verdict authority. This slide wins or loses the methodology
  judge. Do not bury it. Lead with it.
- Slide 3 emphasize: gate-detects, model-narrates. The deterministic
  DELTA-gate is the verdict authority. The fine-tuned model produces the
  narrated evidence report, but it never has block authority. Frame the agent
  layer here: the agent acts on the gate verdict at submission time.
- Slide 4 emphasize: the AuditDossier-AuditReport contract is how the
  narration stays honest. Every cited finding maps to an evidence id in the
  dossier; invented references are zero by construction. The verdict is
  auditable, not a black-box score.
- Slide 6 reframe: this is the downstream application slide. The
  conversational agent plus the evidence memo is "the agent layer that acts
  on the forecast." The insurance/underwriting economics live here as one
  worked application of acting on the forecast, not as the headline.
- Slide 11 lead with the honest numbers: base model produces no parseable
  verdict (0 percent), fine-tuned reproduces the gold verdict 46.7 to 73.9
  percent depending on split, block-recall is 0 percent on the held-out
  blocks, and the deterministic gate is what catches the severe cases. The
  lift from fine-tuning proves the data and pipeline work end to end; the
  model is the narrator, the gate is the authority.
- Slide 12 rewrite: ask becomes a forecasting research collaboration. "Your
  forecast already separates a rising dependency from a fading one, which is
  what lets us rank by trajectory. The new surface is the software-ecosystem
  drivers your commodity/macro lake does not carry yet. We want to build those
  with you and take the ranking signal to the harder dependency surfaces in
  your domain."

**Track-specific risks:**
- A methodology judge will press on the AUROC 0.54 floor: "is that a real
  finding or did you set the benchmark up to fail?" The honest answer is
  that benign is defined as the first-patched release of the same package,
  so the classifier is being asked to separate a malicious version from its
  own clean sibling on cold features alone. That is hard on purpose, and it
  is exactly the regime where the delta carries the signal. Concede it is a
  hard setup; that is the point, not a bug.
- "If the forecast does not detect danger, why is it in the loop at all?" The
  honest answer: it earns its place on prioritization, not detection. With
  hundreds of dependencies and a small review team, the order you review in is
  the whole game, and the forecast separates rising from fading cleanly enough
  to set that order. The detection is the gate's job, and the model narrates
  the gate's evidence; on the held-out severe cases the model's block-recall is
  0 percent, which is exactly why the deterministic gate, not the model, holds
  verdict authority. We do not let a 0-percent-recall narrator decide.
- The commercial judge will ask the practical question: does anyone act on
  the forecast? Yes. The agent layer acts at submission time: block,
  quarantine to admin review, or admit with an evidence memo. The insurance
  application on Slide 6 is one worked example of a downstream actor (an
  underwriter) consuming the forecast and the memo. Drop into that example
  if the commercial judge wants a concrete buyer.

---

## UNIQA Insurance ("AI in Insurance") - FALLBACK

UNIQA is a fallback reframe, not the entry. The insurance economics are a
downstream application of acting on the forecast, not the headline. Use this
page only if the case briefs point at an insurance track.

**One-line value prop:** "ModuleWarden gates every npm install on its own
deterministic rules and uses a demand forecast to rank which dependencies a
team should review first. One downstream actor who acts on the gate verdict
and its evidence memo is a cyber underwriter: the install-layer control class
that none of the eleven sections of UNIQA's questionnaire currently ask
about. ModuleWarden is the twelfth section."

**Sponsor-domain buzzwords to drop in:**
- "Actuarial" (use it when describing the evidence trail: "actuarial-grade
  audit memo on every gated install")
- "Underwriting control" (frame ModuleWarden as a control class, not a
  competing product)
- "Cyber risk quantification" (the term of art UNIQA's cyber product
  team uses)
- "Claims-grade evidence" (the audit dossier as a claim-file artifact)
- "Solvency II" (mention once when discussing model validation rigor)
- "Reinsurance" (when describing the DeepSeek V3 second-opinion layer)

**Likely judge profile:**
- **Andreas Wimmer** (Teamleiter Haftpflicht / Financial Lines / Cyber).
  Highest probability of being the track sponsor in the room.
- **Amela Agovic** (Cyber Underwriting). Likely the actual technical
  evaluator.
- (Backup) Barbara Liebich-Steiner CDO, Malte Bartels Data and AI
  Platform Engineer.

They care about: forecast honesty (the reported number must match the
held-out result), explainability (every forecast ships with an evidence
list), regulatory framing (Solvency II treats unquantified risk poorly),
claims-process fit (evidence must drop into a claim file without translation).

They do NOT care about ML novelty for its own sake.

**Slide swaps:**
- Slide 1 add: "Your underwriting questionnaire has eleven sections. None
  of them ask whether your policyholder gates npm installs. Verizon DBIR
  puts 74 percent of breaches on the human element. AI-assisted coding
  amplifies the insider vector. ModuleWarden is the twelfth section."
- Slide 4 emphasize: the three-layer stack. Deterministic delta-gate, our
  fine-tuned model in an isolated Docker container, DeepSeek V3 second
  opinion on the QUARANTINE band. This is the reinsurance pattern.
- Slide 6 emphasize: the forecast feeds the underwriting application. Lead
  with the evidence memo and the control-class credit, not a borrowed
  accuracy headline. Underwriters trust an auditable forecast they can act on.
- Slide 8 rewrite: top roadmap item becomes "underwriting questionnaire
  integration as the twelfth section." PyPI moves to row two.
- Slide 12 rewrite: structured 6-to-8 week pilot with UNIQA cyber
  underwriting + product owner + claims/risk engineering, with measurable
  KPIs (block precision, override burden, evidence usefulness).

**Track-specific risks:**
- A pure underwriter judge may push hard on regulatory compliance
  (Solvency II, EIOPA guidelines on model risk management). The honest
  answer: we are at hackathon stage; a production underwriting input
  would need full SR 11-7 style model validation. We can credibly
  position as a research collaboration that feeds into a future
  production system.
- "Why npm and not the whole IT estate?" is a real question. Answer:
  we picked a tractable scope to prove the forecasting methodology. It
  generalizes to any quantifiable risk signal a carrier wants to
  underwrite against (PyPI Q3, Cargo Q4, RubyGems 2027).
- "Do you replace T-Systems Austria / Schoenherr / Pantarhei?" is a
  trap. Answer: no. UNIQA already has the expert response network. We
  add the install-layer control class that does not exist in the
  current questionnaire.

**bsurance context:**
- UNIQA launched an embedded insurance platform with bsurance in April
  2026. The jury may be primed for embedded-insurance UX framing.
- If the case brief leans toward embedded UX: emphasize that the
  underwriter view ships as a route in the production admin dashboard,
  not a separate product.

---

## Infineon Industry ("AI in Industry") - FALLBACK

A second fallback. Use only if the briefs point at an industrial track.

**One-line value prop:** "Industrial OT and embedded systems pull software
from package registries too. ModuleWarden detects the known-bad at the install
gate on its own deterministic rules and ranks the rest by forecasted
trajectory, so the review queue starts where a compromised dependency takes
down a fab line, not a web app."

**Sponsor-domain buzzwords to drop in:**
- "OT security" (operational technology)
- "Software bill of materials" (SBOM, mandated by NIS2 and the EU Cyber
  Resilience Act)
- "Fab line uptime" (Infineon-specific, frame the cost of a supply chain
  compromise in terms of downtime)
- "Air-gap compatible" (our offline demo and Docker isolation prove this)

**Likely judge profile:** An Infineon engineering lead or a security
architect for industrial customers. They care about: deterministic
behavior under failure, fitness for OT environments (latency, air-gap
compatibility), CE/EU regulatory alignment (NIS2, CRA). They are
skeptical of consumer-grade tooling repackaged for industrial use.

**Slide swaps:**
- Slide 1 add: "EU Cyber Resilience Act requires SBOM and vulnerability
  tracking for all networked industrial equipment by 2027. The OT
  software supply chain has fewer tools than the IT supply chain has,
  not more."
- Slide 4 emphasize: the deterministic policy engine runs locally with
  no external dependencies. The audit container is air-gap compatible.
  The fine-tuned model can ship as a fixed weights file and run on
  CPU-only hardware for periodic re-audits.
- Slide 8 add: "Embedded firmware update pipelines as the third
  ecosystem after PyPI. Same architecture, smaller language models."
- Slide 12 rewrite: ask becomes "pilot in an Infineon OT line: we
  deploy the gate in front of an embedded update pipeline, you measure
  caught versus missed."

**Track-specific risks:**
- "How does this run in an air-gapped environment?" is a hard real
  question. Answer: the deterministic policy engine is offline. The
  per-job Docker container can run a local fine-tuned model with no
  egress. DeepSeek V3 second opinion is optional and disabled in
  air-gap mode. The threshold engine never needs to phone home. We
  have not tested this end-to-end and would not pretend otherwise.
- "Are you ISO 27001 certified?" is asked early in any industrial
  pitch. Answer: no, hackathon stage; a real OT deployment would need
  a full certification path. We can credibly say the architectural
  choices (no telemetry by default, deterministic decisions, local-first,
  prompt secrecy) align with the industrial requirements.

---

## How to pick the track Friday night

After Case Reveal at 20:30 Friday:

1. Read all the briefs. Score each on three axes: domain fit, judge
   fit, demo fit.
2. Domain fit: how far is the reframe stretch? Sybilion is the native frame
   (the forecast ranks the team's own dependencies by trajectory), UNIQA is a
   downstream application, Infineon is a registry swap.
3. Judge fit: which judges are in the room for each track, and how well
   does our pitch land for them?
4. Demo fit: does the live postmark-mcp demo translate? Sybilion yes (the
   ranked-list slide plus the gate detecting on a real delta). UNIQA yes (the
   underwriter acts on the verdict). Infineon yes if we cast it as OT supply
   chain.
5. If two tracks tie on the above, pick the one with the smallest prize
   spread.

Default pick if briefs do not change the picture: Sybilion FORECAST,
UNIQA as fallback, Infineon as a second fallback.

---

## Sybilion-specific framing notes

- The forecast ranks by trajectory; it does not detect. Say this early and
  keep saying it. The forecast separates rising from fading (react +144
  percent, express +89 percent vs flat/deprecated), so it orders the review
  queue; it does not output an attack-vector probability, and we concede that
  on stage with the backtest data.
- The detector is the deterministic delta-gate. It diffs the lockfile version
  against the requested version on its own rules. The cold-package classifier
  floors at AUROC 0.54 on this corpus; the delta is where the detection signal
  lives, and the gate, not the model, decides.
- The agent layer is not decoration. It is the half of the value prop that
  turns the gate verdict into an action: block, quarantine, or admit with an
  evidence memo, at submission time.
- Do NOT quote any headline accuracy not measured on this corpus. No
  borrowed AUROC, no third-party F1, no calibrated-coverage percentage we
  did not produce. The honest floor (0.54 cold) plus the honest fine-tune
  lift (0 to 46.7-to-73.9 verdict-match, 0 block-recall) plus the conceded
  forecast negative result is the credibility, not a polished number.

---

## UNIQA-specific intelligence (verified May 2026)

Kept for the fallback reframe.

- **Cyber product name:** Cyberversicherung (no separate brand)
- **SME cap:** EUR 100k per insured
- **Industrial cap:** up to EUR 20M
- **2024 GWP:** exceeded EUR 7B
- **Strategy signal:** modular SME cyber packages, "quote in minutes"
  digital portal
- **Expert response network already wired:** T-Systems Austria
  (forensics), Schoenherr Rechtsanwalte (legal), Pantarhei (PR/crisis).
  Do NOT pitch adding a partner network.
- **Existing UW questionnaire factors observed:** dependency management
  practices, vulnerability scanning, SCA tools, developer training,
  build pipeline security, supply-chain incident response.
- **Gap exploitable:** the questionnaire has NO install-layer control
  class. ModuleWarden is the twelfth section.
- **Recent partnership:** April 2026 bsurance integration for embedded
  insurance. Jury may be primed for embedded-UX angle.
