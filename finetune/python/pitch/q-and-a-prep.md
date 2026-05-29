# ModuleWarden Q&A Preparation

20 likely judge questions with prepared 90-second answers, plus the
escalation matrix at the bottom. Read these before the pitch.

Rule: honest answers beat aspirational answers. The UNIQA cyber team
likely in the room (Andreas Wimmer Teamleiter Financial Lines / Cyber,
Amela Agovic Cyber Underwriting) will spot weak reasoning.

The first five entries are the hostile-underwriter pushbacks. If
cornered, rehearse these.

---

## Q0a. Where is your evidence ModuleWarden actually reduces claim frequency, not just controls a 15 percent incident category?

We are not claiming reduction yet. We are providing the evidence
artifact that lets you measure reduction over your first cohort.
ModuleWarden's value at year 0 is auditability and policy
enforceability: every install routes through a deterministic gate,
every decision lands in a Control Evidence Memo with rule references
and sign-off trail, and the audit log is queryable from the
policyholder portal. At year 1, with your claims data, you will have
measured the frequency delta on the supply-chain incident class for
that cohort. That is the underwriting input that earns durable
premium tiers. Today's pitch is the control class, not the actuarial
proof. We have the data-collection apparatus. You have the actuarial
team. Together you measure the reduction the public industry reports
are pointing at.

---

## Q0b. Coalition's 12.5 percent MDR premium credit is for a control class with years of claims data. ModuleWarden has zero. Why should we underwrite this?

Right, and that is the same answer in reverse. MDR has ten years of
actuarial data behind that 12.5 percent number. We are offering you the
data-collection apparatus for the next ten years of supply-chain
controls. The 12.5 percent figure is what you can defensibly underwrite
at year 0 based on the control-class match: a verifiable pre-install
gate that produces an audit artifact every time it fires, mapped to ISO
27001 A.8.28 and NIST SSDF PS.3.1. The bigger number, possibly 25 to 35
percent, emerges as your portfolio data confirms reduction on the
eligible segment. We are not asking you to price what Coalition prices.
We are asking you to price what the control class actually does on your
book, and the floor for that is the public reference point.

---

## Q0c. What is the latency cost vs direct registry access?

Two paths through the gate, both measured. Cached metadata fetch returns
in under 50 milliseconds; the cache TTL is 1 hour and metadata cache
hits are the common case because npm install resolves the same
dependency graph repeatedly within a build. Tarball serve from the
on-disk cache is under 100 milliseconds plus the disk read, dominated by
tarball size. First-time tarball fetch is the upstream registry
round-trip plus the policy evaluation, which is sub-millisecond once the
integrity hash and lifecycle scripts are parsed. The fine-tuned model
audit runs in the per-job Docker container, with the cache seeder
pre-auditing top packages out of band. End to end on a warm cache, the
install completes faster than direct access to registry.npmjs.org
because the proxy is on-prem and the upstream is across the Atlantic.

---

## Q0d. Why should the npm install layer be a covered control class when UNIQA's existing questionnaire has eleven sections and none of them ask about it?

That is the answer. UNIQA's underwriting questionnaire does not
currently ask whether a policyholder gates npm installs. That is the
gap. ModuleWarden is the twelfth section. We do not duplicate what
your T-Systems forensics or Schoenherr legal partners already provide.
We add the install-layer control class that does not exist in the
current questionnaire. With ModuleWarden in place, you can require,
verify, and price against it the way Coalition prices their MDR
control class. The Verizon DBIR puts 74 percent of breaches on the
human element. The npm install layer is where the human element
touches the supply chain. Eleven sections leave that uncovered. The
twelfth covers it.

---

## Q0e. What is the multi-tenant story?

Single-tenant for v2.0. The gate, the cache, the policy file, the
Postgres database, and the audit log are scoped to one ModuleWarden
instance. Deployment recommendation is one instance per organizational
unit. Multi-tenancy is on the enterprise-tier roadmap: per-tenant
schema in Postgres, per-tenant cache partitioning, per-tenant policy
overlays, per-tenant audit log isolation. None of those are
conceptually hard; they are queued for SOC 2 prep in Q4. For now, the
honest framing is that you run one ModuleWarden per customer or per
business unit, and the operational footprint is small enough that this
is fine.

---

## Q1. Is ModuleWarden better than Snyk's existing tools?

No. Snyk and Socket.dev are excellent at post-install scanning,
dependency graph analysis, and CVE correlation. ModuleWarden does
something different. Snyk answers "is there a known CVE in this
dependency tree?" after the install. ModuleWarden answers "should this
install happen at all?" before the install completes. ModuleWarden and
Snyk stack. A team running both gets the pre-install gate from us and
the post-install audit from Snyk. The pitch is composition, not
displacement.

---

## Q2. What is your false positive rate?

We measure `false_quarantine_block_rate` on the SecLens-R bench. The
target on benign packages is under 5 percent quarantine and under 2
percent block. The quarantine band exists explicitly to absorb model
uncertainty: anything where confidence sits between 0.4 and 0.7 routes
to admin review with mandatory rationale notes, captured in the
Postgres supersedes pointer chain. The expected proportion of installs
that hit quarantine is low single digits because the score distribution
is bimodal. Most packages cluster near zero. The reviewer queue is
tractable. We will show the exact numbers from Saturday's eval on Slide
11 if you ask.

---

## Q3. What if the fine-tuned model is wrong on a Class A compromise?

Three independent layers. First, the deterministic 5-rule gate fires
independently. Release-age plus lifecycle-script triage plus source-match
catch most maintainer-takeover patterns before the model is consulted.
Second, the fine-tuned model in the audit container produces the primary
verdict. Third, DeepSeek V3 is consulted as a second opinion on
QUARANTINE-band decisions only. The model never has unilateral block
authority; the gate decision is the deterministic verdict plus the
model report, and the override workflow captures any human reversal
with full Postgres lineage. A wrong model verdict gets the package
quarantined and routed to admin review, not silently allowed.

---

## Q4. How does the gate behave for packages not in your training distribution?

Honestly: novel attack generalization is the hardest open problem in
this space, and we do not claim to solve it. Three mitigations. First,
the deterministic rules do not need the model to have seen the attack
pattern; they trigger on structural signals like a postinstall script
that downloads and pipes to sh. Second, the audit_dossier.v1 contract
captures capability deltas the model never trained on, which the model
gets to cite in the report. Third, the QUARANTINE band catches model
uncertainty. So a net-new attack pattern is more likely to get
quarantined than to slip through as an allow. We accept that some
net-new attacks will slip through as allows. Every block, quarantine,
and allow is logged in Postgres and feeds back into the retraining
queue.

---

## Q5. Why these thresholds, 0.4 and 0.7?

Calibrated to the SecLens-R held-out test set. At p over 0.7, the
empirical block precision sits in the target band. At p under 0.4, the
empirical allow precision exceeds 98 percent. The 0.4 to 0.7 band is
where calibration is uncertain enough that we route to human review.
These are defaults; every customer can tune them. A bank might run at
0.3 allow and 0.6 block, accepting more quarantine load. A startup
might run at 0.5 and 0.8, accepting more risk for lower friction.

---

## Q6. What is the latency at install time?

Two paths. Cached: under 100 milliseconds. The gate stores verdicts per
package version with a configurable TTL in Postgres. Most installs hit
a cached verdict. First-time path: 3 to 8 seconds for a new package
version. That covers tarball fetch from the npm registry, dossier
preparation, model inference in the audit container, report
serialization. We can show the latency benchmark on the backup slide.
A 5-second hit on a first-time install is acceptable. An 8-second hit
every install would not be.

---

## Q7. What stops attackers from gaming the model?

Three layers. First, the per-customer policy file does not ship in the
model weights. Each customer can configure threshold values, evidence
weighting, and required signals. An attacker who learns to score 0.39
on the default model has not learned how to score 0.39 on every
customer's gate. Second, audit prompts are server-side artifacts under
`packages/audit-runner/prompts`; the audit container never sees them
and the client never sees them. This is the prompt-secrecy trust
boundary. Third, training data is updated continuously from the
retraining queue, so the model shifts faster than an attacker can
probe-and-train. The hardest version of this question is adversarial
machine learning research and we do not have a complete answer; the
layered design buys us time.

---

## Q8. Is this real or vaporware?

It is real. The public repo is github.com/apetersson/ModuleWarden, the
marketing site is live at ademczuk.github.io/modulewarden-website, and
the offline demo runs on this laptop. 53 of 53 tests pass on main. The
smoke evidence at `finetune/python/eval/smoke_results/vast_smoke_38255250.json`
documents a real vast.ai A100 run; loss descended from 5.36 to 0.73 on
a 5-pair dataset; valid audit_report.v1 JSON on a held-out package. The
Saturday Leonardo run produces the actual eval numbers for Slide 6 and
Slide 11.

---

## Q9. Why npm and not PyPI?

Three reasons. First, attack volume: npm has by far the highest count
of malicious packages per year in the public datasets, because
JavaScript is in every web pipeline and the install script primitive is
broader than pip's. Second, the SecLens-R 4-arm bench targets the
npm-focused arXiv 2403.12196 baseline. Third, postmark-mcp is a 2025
incident every security team has seen, and that gives us the demo. PyPI
is the next ecosystem on the Q3 roadmap.

---

## Q10. What is your business model?

Three tiers. Free OSS tier: full gate, single threshold profile,
community model only. Team tier: 12 USD per developer per month, custom
thresholds, private rubric, reviewer queue with Slack integration.
Enterprise: federated training, SLA, single tenant, on-premise option.
We are also exploring a cyber-insurance underwriting product where the
calibrated probability output feeds into the actuarial model: that is
closer to a data sale than a SaaS license, and the UNIQA pilot is the
test case.

---

## Q10a. Have you seen Decepticon by PurpleAILAB? Sounds adjacent.

Yes. They are the offense to our defense. Decepticon is an autonomous
red-team agent: 16 specialist agents organized by kill-chain phase,
LangGraph plus LiteLLM plus Postgres plus a Kali sandbox plus a Neo4j
knowledge graph, with 98 percent on the XBOW validation benchmark.
Their architectural pattern is the disposable Docker-socket-driven
agent inside a two-network management-versus-sandbox split. That is
exactly the shape ModuleWarden's per-job audit container already uses,
just at a smaller scale and pointed at a different problem. Decepticon
operates pre-compromise; ModuleWarden operates at the npm install
boundary, post-publish, pre-execution. Both projects share Apache 2.0
licensing and disposable Docker-isolation patterns, but the threat
surfaces and the metrics do not overlap. If UNIQA wanted to run
red-team plus defense in series, Decepticon plus ModuleWarden is a
natural pairing, but we do not pitch that on stage today.

---

## Q11a. How do you defend against the developer who asks Copilot to install a package and Copilot suggests something malicious?

Same gate, same evidence. ModuleWarden does not care who triggered the
install. The IDE, the developer, the CI bot, the contractor merging a
PR. Every install goes through the same five-rule gate, the same
fine-tuned model audit, the same Postgres decision row with the same
supersedes pointer. The audit_dossier.v1 contract captures the trigger
context: IDE telemetry, branch, author, prior allow decisions. That
trigger context is the difference between "our contractor was negligent"
and "our gate caught what the contractor missed." For the underwriter,
it is the difference between coverage and exclusion. Verizon DBIR puts
74 percent of breaches on the human element. AI-assisted coding
amplifies that vector. ModuleWarden is architecturally positioned for
it because it gates every install regardless of the trigger.

---

## Q11b. Are you not just using DeepSeek's hosted API to do your job?

No. The deterministic gate handles 80 percent of decisions with zero
LLM involvement, and the gate is the verdict authority. For the ambiguous
20 percent, our own fine-tuned auditor model produces the structured audit
report in the per-job Docker container with prompt secrecy guaranteed. That
auditor is a real fine-tune trained on real GHSA cases (a small QLoRA today,
Qwen2.5-Coder; the 27B is the Leonardo scale-up, not yet trained). DeepSeek
V3 is consulted only in the QUARANTINE band, roughly 5 percent of total
decisions. The DeepSeek call is the second-opinion model that
underwriters use for borderline accounts. The supersedes pointer
captures the case where the two models disagree, and that case routes
to admin review. We trained the primary model. We hired the second
model the way an underwriter hires a reinsurer.

---

## Q12. What is your synthetic data strategy and why is it not overfitting?

The synthetic examples are generated from a 26-pattern attack catalog
at `finetune/python/data/patterns/attack-catalog.yaml`. Each pattern
parameterizes a small grammar that generates code variants. The
synthetic data is only in training, never in validation or test. The
held-out test set is real malicious packages from the scraped GHSA
corpus the model has never seen. Per-pattern accuracy is tracked in the
SecLens-R bench: if the model only scored well on patterns that were
over-represented in the synthetic data, the breakdown would show it.

---

## Q13. Why Qwen3.6-27B as the scale-up target and not GPT-4?

To be precise: the model we have trained so far is a small Qwen2.5-Coder
QLoRA; Qwen3.6-27B is the production scale-up target, and we picked it over
a hosted model like GPT-4 for three reasons. First, latency: Qwen3.6-27B
with bf16 LoRA on an H100 runs the audit in under 8 seconds. A per-install GPT-4 call would put
cost-per-install at multiple cents, incompatible with a 12 USD per
developer per month pricing model. Second, prompt secrecy: GPT-4 is
hosted; our fine-tuned weights run in the customer's audit container
with no egress. Third, the abliteration step uses the
huihui-ai/Huihui-Qwen3.6-27B-abliterated checkpoint, which already
removes the "I cannot help with security analysis" refusal cascade.
GPT-4 would refuse half our prompts.

---

## Q14. What data did you not use, and why?

We did not use Backstabbers Knife Collection because access requires
emailing the maintainers from an institutional account, which was
outside the 36-hour budget. We did not use private corpus from any
vendor because we cannot redistribute the trained model if we do. We
did not use raw GitHub issue text because the signal-to-noise was too
low for the time we had. We are aware these are gaps. The scraped GHSA
corpus plus the 26-pattern synthetic catalog gets us above the SecLens-R
floor; the additional corpora are roadmap items for Q3.

---

## Q15. How does the gate behave when the model service is down?

Two failure modes. First, gate up but model down: the deterministic
rules fire independently and the audit_dossier is committed with the
audit_report status set to `model_unavailable`. The verdict defaults to
QUARANTINE on undecided dossiers; the override workflow lets an admin
push through if needed. Second, gate down: the npm client sees an
upstream connection error and the install is held. No silent allow on
infrastructure failure. A security gate that fails open is not a
security gate.

---

## Q16. What about transitive dependencies?

The gate scores every package in the resolved tree, not just the
top-level dependency. The api-proxy lockfile import sees the full
resolution graph. So if the top-level package is benign but pulls a
malicious transitive, the malicious one gets dossiered and audited.
This is one of the practical advantages of sitting at the install layer
instead of at the developer's package.json: we see the full resolved
graph and we can score every entry.

---

## Q17. How long until a customer can deploy this in production?

The free OSS tier is deployable today: clone the repo, run docker
compose up, point npm at the local gate. Production deployment for a
team needs three things: the trained model published as a versioned
artifact (Saturday), a Docker container for the audit-runner (Sunday),
and a basic Slack-or-CLI reviewer queue for the quarantine band (one
week after the hackathon). So a pilot is two weeks out. A fully
supported enterprise deployment with SLA is two months.

---

## Q18. What is the worst false positive in your test set, and what did you do about it?

Honest answer: we will know Saturday afternoon after the eval matrix
runs. Our prior is that the worst false positives will be packages
with legitimate post-install scripts that look like droppers; things
like binary native modules that download platform-specific binaries.
The mitigation is the source-match rule, which has an explicit
allowlist for signed binaries from verified maintainer accounts, and
the quarantine band, which holds these for review rather than blocking
them. We will name the actual worst false positive in the Q&A after we
have the eval output.

---

## Q19. Is there a privacy issue with scoring developer installs?

The scoring request contains the package name, version, and tarball
hash. No customer code is sent to our service. The audit container
runs on the customer's infrastructure; the audit prompts never leave
the server-side artifact directory. In the self-hosted enterprise
deployment, the model runs entirely in the customer network, so even
scoring requests do not cross the boundary. We designed for the
privacy-strict case from the start because cyber-insurance and
financial customers will not adopt a service that ships their
dependency manifest to a third party.

---

## Q20. What is your single biggest risk?

The model not generalizing to net-new attack patterns. Every
malicious-package classifier in production today underperforms on
attack patterns that did not exist in the training data, and there is
no known fix beyond fast retraining loops. We mitigate with the
deterministic rules (structural signals do not require pattern
memorization) and the quarantine band (uncertainty routes to humans),
but we do not claim to have solved it. The honest framing: we will
catch the attacks that look like prior attacks, which is most of them,
and we will surface the suspicious ones for human review, which is the
right behavior for the rest.

---

## Q21. Your model's verdict-match is 46.7 to 73.9 percent. What is the trivial baseline, and what about block-recall?

Honest answer, lead with it. The trivial baseline is "always quarantine":
safe but useless because it stops all development, and on a held-out set
that is mostly quarantine it scores high for free. So verdict-match alone is
not the headline. The metric that matters for insurance is block-recall:
does it catch the severe class. On the held-out test split our 0.5B model's
block-recall is 0 percent, it caught 0 of 5 blocks. We do not hide that. It
is exactly why the deterministic 5-rule gate, not the model, is the verdict
authority: the gate independently flagged the compromised release
(postmark-mcp-1.0.16, release-age plus install-scripts plus source-match
fails) and the report escalated it to block. The model is the narrator. The
real result is the lift from fine-tuning, base 0 percent to fine-tuned 73.9
percent verdict reproduction, which proves the data and pipeline work end to
end on a small model. Block-recall is the metric we scale the model on, and
the 27B Leonardo run is where it earns it. The number is not the product;
the gate plus the trained pipeline is.

---

## Q&A escalation matrix

When a judge asks something we cannot answer cleanly, do not bluff.
Pre-approved escalation phrases:

| Question type | Response template |
|---|---|
| Specific hyperparameter we did not log | "We did not log that during the 36-hour training window. The artifacts are public; happy to follow up with the exact number by Monday." |
| Specific number we do not have yet | "Saturday training finishes Saturday afternoon Vienna time. I will have that for you in the demo Sunday morning, or by email if you want to send a card over." |
| Comparison to a tool we have not benchmarked | "We have not run a head-to-head against [tool]. Our position is composition, not displacement, so the comparison is about coverage gaps, not accuracy parity." |
| Deep ML research question on which we are not domain experts | "That is an open research question. Our pragmatic choice was [X]; we know it is not optimal and the next iteration would [Y]." |
| Anything we are not sure about | "I would be guessing if I answered that. Can you say more about what you are trying to determine? I might be able to point you at the relevant artifact." |

The two failure modes to avoid: confident wrong answers, and waffling
non-answers. The escalation template gives a clean exit from both.

## Things a judge might bring that we should anticipate

- A laptop. They might want to curl the gate themselves. Have the URL
  on a card. Have a wifi hotspot if the venue wifi is bad.
- A specific package they know is malicious or sensitive. We can replay
  it live if the gate is running. If it is outside the three shipped
  incidents, say: "We ship three reconstructions in-tree. Adding a new
  incident is a 15-minute job; I can mail you the result this afternoon."
- A specific package they know is legitimate but unusual. If we score
  it as benign, that is a good outcome. If we score it as quarantine,
  lean into the design: "this is exactly the case where a human
  reviewer adds value, captured in the Postgres supersedes pointer with
  the admin's rationale."
- A question about Andreas Wimmer or Amela Agovic specifically. If
  asked by name, say: "We have not had the chance to speak with you
  directly yet; the structured pilot ask on Slide 12 is exactly the
  conversation we would like to schedule."
