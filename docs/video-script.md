# ModuleWarden - Video Pitch Script

Target runtime: 2 to 2.5 minutes.
Track: Zero-One Hack Forecast track. Partner: Sybilion.
Frame: supply-chain audit at the registry level. Every new version gets an
agentic review with evidence-backed verdicts, temporal forecasting ranks
by trajectory, and we show you exactly what the model saw.

Read the voiceover at a steady pace, roughly 150 to 165 words per minute.
Each beat below is one shot.

---

## Beat 1 - Hook: the threat

| Field | Content |
|---|---|
| SECTION | Hook |
| ON-SCREEN / VISUAL | A popular npm package page. The maintainer avatar. Then a red badge: "new version published." Cut to a code diff where a single added lifecycle script slips into `package.json`. |
| VOICEOVER | A package you trust gets a new release. The maintainer account is compromised, or a contributor went rogue. A careful attacker will not leave anything a static scanner can catch. The danger is the delta. What changed between two versions. |

---

## Beat 2 - Hook: the compounding-risk graph

| Field | Content |
|---|---|
| SECTION | Hook |
| ON-SCREEN / VISUAL | Display `modulewarden-website/media/compounding-risk.png`. X axis: dependency complexity, the transitive dependency count. Y axis: compounded risk, 1 minus (1 minus p) to the power of N. Animate the curve climbing as N grows. |
| VOICEOVER | Here is why this gets worse fast. Every dependency you pull in brings its own dependencies. The probability that at least one of them is an attack vector is one minus the chance they are all clean. As the tree grows, that curve climbs toward one. A modern project has thousands of them. You cannot review them by hand. |

---

## Beat 3 - The defense: guard the registry

| Field | Content                                                                                                                                                                                                                                                                                                                                          |
|---|--------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| SECTION | Defense                                                                                                                                                                                                                                                                                                                                          |
| ON-SCREEN / VISUAL | A diagram: developer, then the artifact registry in the middle, then the codebase. A shield drops onto the registry node. Label it "ModuleWarden."                                                                                                                                                                                               |
| VOICEOVER | So we guard the one interface every package has to cross. The artifact registry. The service you pull your packages from. You actiate it with a single line of code globally on your machine or just for one project. One code review which you kick off by hand is useful. With ModuleGuard: twenty that run automatically on every submission. |

---

## Beat 4 - The audit: evidence first, verdict second

| Field | Content                                                                                                                                                                                                                                             |
|---|-----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| SECTION | Defense                                                                                                                                                                                                                                             |
| ON-SCREEN / VISUAL | An audit in progress. Evidence artifacts appear one by one: `static-checks.json`, `advisory-search.json`, `package-info.json`, `capability-delta.json`. Then a structured verdict card stamps: BLOCK with cited evidence lines below.               |
| VOICEOVER | Every new version triggers a full audit. An Agentic Reviewers looks at the code from multiple angles and can ALLOW, BLOCK, or QUARANTINE. You can open the audit session and read exactly what the model saw. |

---

## Beat 5 - Prompt packs: customizable audit instructions

| Field | Content                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
|---|---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| SECTION | Defense                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| ON-SCREEN / VISUAL |                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| VOICEOVER | What the model looks for is defined by prompt packs. Instruction files that you can read, edit, and version. Core packs cover claimed purpose versus actual behavior, install-time execution, and known vulnerabilities. Pattern packs target specific attack classes — crypto hijack, secret harvesting, protestware. You write custom packs for your own internal threat model. The model reads these instructions alongside the evidence and produces a focused the verdict. |

---

## Beat 6 - The model: fine-tuned on CVEs

| Field | Content |
|---|---|
| SECTION | The model |
| ON-SCREEN / VISUAL | A pipeline animation: recent CVEs downloaded, vulnerable and fixed versions paired, source pulled, sorted into benign and vulnerable buckets. Counter ticks up to 1,800 codebases. Leonardo supercomputer logo. Two LoRA adapters split off. |
| VOICEOVER | The model is a 27 billion parameter Qwen variant, fine-tuned on eighteen hundred real-world CVE codebases. We pulled recent CVEs, matched each vulnerable version to its fix, grouped the source into benign and vulnerable packages, and trained two LoRA adapters on the Leonardo supercomputer. Small specialized modules that steer a large base model toward supply-chain audit. The model is published on Hugging Face. Attach it to any OpenAI-compatible endpoint and it works with our orchestrator. |

---

## Beat 7 - The model: what it does,

| Field | Content |
|---|---|
| SECTION | The model |
| ON-SCREEN / VISUAL | A finished audit report on screen, in schema, with each claim citing a line of evidence. A caption: "27B auditor, published to Hugging Face. Held-out val loss 0.21." A second caption: "This measures narration fidelity, not detection accuracy." |
| VOICEOVER | Held-out validation loss is 0.21. Read that honestly. It measures how faithfully the model writes up the evidence it was given, not how well it spots danger. The model narrates what the evidence shows. The verdict comes from the structured output schema, not from a hidden probability. You get the same output format every time. |

---


## Beat 8 - The forecast: live implementation

| Field | Content                                                                                                                                                                                                                                                                                                                        |
|---|--------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| SECTION | The forecast                                                                                                                                                                                                                                                                                                                   |
| ON-SCREEN / VISUAL | A live ModuleWarden dashboard. Click into an audit run detail. The "Temporal Forecast (Sybilion)" card expands — per-metric rows: commits, contributors, downloads. Each with verdict badges (collapse, uncertainty, anomaly) and a linked Sybilion job ID. Below, a composite risk badge: 40%.                                |
| VOICEOVER | We ship this. For every package we audit, we clone its repo, pull monthly git history back to the first commit, and send the time series of critical data to Sybilion. Sybilion returns Collapse Risk, Uncertaint, Anomaly. Those feed into one risk score you can see in the audit detail, with every Sybilion job ID linked. |

---

## Beat 9 - The honesty beat

| Field | Content |
|---|---|
| SECTION | The forecast |
| ON-SCREEN / VISUAL | A plain results panel, no spin. "Cold-package static classifier: AUROC 0.54." Then a backtest chart: healthy and dying packages overlaid, their bands and slopes tangled together, clearly not separable. Caption: "We tested it. It cannot tell dying from healthy. Here is the data." |
| VOICEOVER | Here is the part most teams skip. We tested whether the forecast can detect a dying or compromised package. It cannot. The band and the slope do not separate a dying package from a healthy one. A cold static classifier floors at AUROC 0.54. We are not claiming 0.90, or calibrated, or conformal. We show you the floor. False certainty is worse than honest uncertainty. |

---

## Beat 10 - Close: the domain-expansion frame

| Field | Content |
|---|---|
| SECTION | Close |
| ON-SCREEN / VISUAL | Four steps animate in sequence: "Transfer-test the forecast," "Keep what it earns (trajectory ranking)," "Gate what it cannot (the audit pipeline decides)," "Concede the rest (with the data)." Then Sybilion's slide line: "The domain is yours." |
| VOICEOVER | Sybilion says the domain is yours. We took your forecast into supply-chain security and ran the transfer test. We kept what it earned — trajectory ranking. We gated what it could not — the full audit pipeline with evidence-backed verdicts. And we conceded the rest, with the data. That is how you grow a forecast into a new domain without it lying to you. |

---

## Tagline

| Field | Content |
|---|---|
| SECTION | Tagline |
| ON-SCREEN / VISUAL | ModuleWarden logo on the guarded registry node. Tagline text below. |
| VOICEOVER | ModuleWarden. Audit every version. Forecast every trajectory. Show every piece of evidence. |
