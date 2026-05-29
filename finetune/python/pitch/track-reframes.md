# Track Reframes: ModuleWarden for UNIQA, Infineon, Sybilion

Each track gets one page. The core pitch does not change. What changes is
the framing on slides 1, 8, and 12, and the buzzwords we drop into slides
3 and 4. Pick the right reframe at Case Reveal Friday night.

Prior on track fit, in descending order: UNIQA, Infineon, Sybilion.
Reasoning at the bottom.

---

## UNIQA Insurance ("AI in Insurance") - PRIMARY TARGET

**One-line value prop:** "ModuleWarden is the twelfth section of UNIQA's
underwriting questionnaire. The other eleven do not ask whether the
policyholder gates npm installs."

**Sponsor-domain buzzwords to drop in:**
- "Actuarial" (use it when describing the score: "actuarial probability
  of a malicious payload")
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

They care about: methodological rigor (calibration plot must look right),
explainability (every score ships with an evidence list), regulatory
framing (Solvency II treats unquantified risk poorly), claims-process
fit (evidence must drop into a claim file without translation).

They do NOT care about ML novelty for its own sake.

**Slide swaps:**
- Slide 1 add: "Your underwriting questionnaire has eleven sections. None
  of them ask whether your policyholder gates npm installs. Verizon DBIR
  puts 74 percent of breaches on the human element. AI-assisted coding
  amplifies the insider vector. ModuleWarden is the twelfth section."
- Slide 4 emphasize: the three-layer stack. Deterministic gate, our
  fine-tuned model in an isolated Docker container, DeepSeek V3 second
  opinion on the QUARANTINE band. This is the reinsurance pattern.
- Slide 6 emphasize: the calibration plot. Lead with it instead of the
  AUROC. Underwriters trust calibration more than discrimination.
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
  we picked a tractable scope to prove the methodology. The methodology
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

**One-line value prop:** "Industrial OT and embedded systems pull software
from package registries too. ModuleWarden is the install gate for the OT
software supply chain, where a compromised dependency takes down a fab
line, not a web app."

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

## Sybilion Forecasting ("AI in Forecasting") - LONG REACH

**One-line value prop:** "ModuleWarden is a worked example of calibrated
probabilistic classification in a high-stakes operational decision. The
same methodology, conformal prediction over fine-tuned transformers,
applies to industrial procurement risk forecasting."

**Sponsor-domain buzzwords to drop in:**
- "Conformal prediction" (drop it early and often)
- "Probabilistic forecasting" (the literal track name)
- "Operational decision-making under uncertainty" (the academic framing
  of the procurement problem)

**Likely judge profile:** Two very different judges to satisfy. A
methodology-rigor judge will probe conformal coverage guarantees and
exchangeability assumptions. A commercial-credibility judge wants to
know whether the tool actually helps a procurement officer make a
decision.

**Slide swaps:**
- Slide 1 rewrite (hardest): frame npm supply chain attacks as a
  forecasting problem: "given a candidate dependency, forecast the
  probability that adopting it will result in a security incident within
  12 months." That is genuinely a forecasting question and connects to
  Sybilion's domain language.
- Slide 2 emphasize: the honest measurement, not a calibration claim we
  cannot back. Lead with the three measured numbers (0.54 cold-package
  floor, 0.60 same-package delta, 0.98 standalone-malware but size-driven)
  and the reason the signal is in the version delta, which is why the
  deterministic delta-gate is the verdict authority. We have a
  split-conformal implementation in the calibrate driver, but on a 0.54
  classifier its coverage is uninformative, so we do NOT pitch conformal
  as a win. Say that plainly; a methodology judge rewards the honesty.
- Slide 6 lead with: the floor-and-ceiling measurement and the delta
  finding. Show the reliability diagram only with the caveat that the
  underlying static classifier is weak; the real probabilistic layer is
  the delta embedding (GPU-deferred, scaffold ready).
- Slide 12 rewrite: ask becomes "research collaboration on conformal
  methods for time-series supply-chain risk forecasting. Our model is
  a tractable instance; your industrial domain is the harder version."

**Track-specific risks:**
- The biggest risk is that Sybilion judges see npm-security as off-topic
  for industrial procurement. The reframe above is honest but stretched.
  If a judge presses on relevance, the right move is to concede the gap
  and pivot to methodology transfer: "the model is npm. The methodology
  is general. Here is the formal mapping."
- The methodology judge will probe the calibration claim hard. Coverage
  validity, distribution shift, exchangeability. The escalation matrix
  in `q-and-a-prep.md` covers this: concede the open question, point at
  the mitigation, do not bluff.
- The commercial judge will ask the practical question. The right
  answer is to drop into the UNIQA reframe: cyber-insurance underwriting
  is a real adjacent market with real budget, and the bridge from the
  demo to that market is clear.

---

## How to pick the track Friday night

After Case Reveal at 20:30 Friday:

1. Read all three briefs. Score each on three axes: domain fit, judge
   fit, demo fit.
2. Domain fit: how far is the reframe stretch? UNIQA is short, Infineon
   is medium, Sybilion is long.
3. Judge fit: which judges are in the room for each track, and how well
   does our pitch land for them?
4. Demo fit: does the live postmark-mcp demo translate? UNIQA yes
   (cyber risk is the demo). Infineon yes if we cast it as OT supply
   chain. Sybilion only metaphorically.
5. If two tracks tie on the above, pick the one with the smallest prize
   spread. EUR 2K vs EUR 1K is much closer than EUR 0 vs EUR 500.

Default pick if briefs do not change the picture: UNIQA Insurance,
Infineon as fallback, Sybilion only if the briefs explicitly mention
software risk forecasting (unlikely).

---

## UNIQA-specific intelligence (verified May 2026)

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
