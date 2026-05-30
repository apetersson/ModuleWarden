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
| VOICEOVER | So we guard the one interface every package has to cross. The artifact registry, the service you pull your packages from. You activate it with a single line, globally on your machine or for one project. A code review you kick off by hand is useful once. ModuleWarden runs a full audit automatically on every new version, before it reaches your code. |

---

## Beat 4 - The audit: evidence first, verdict second

| Field | Content                                                                                                                                                                                                                                             |
|---|-----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| SECTION | Defense                                                                                                                                                                                                                                             |
| ON-SCREEN / VISUAL | An audit in progress. Evidence artifacts appear one by one: `static-checks.json`, `advisory-search.json`, `package-info.json`, `capability-delta.json`. Then a structured verdict card stamps: BLOCK with cited evidence lines below.               |
| VOICEOVER | Every new version triggers a full audit. An agentic reviewer looks at the code from multiple angles and lands on one of three verdicts: ALLOW, BLOCK, or QUARANTINE. You can open the audit session and read exactly what the model saw and why it decided. |

---

## Beat 5 - Prompt packs: customizable audit instructions

| Field | Content                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
|---|---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| SECTION | Defense                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| ON-SCREEN / VISUAL |                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| VOICEOVER | What the model looks for is defined by prompt packs. Instruction files that you can read, edit, and version. Core packs cover claimed purpose versus actual behavior, install-time execution, and known vulnerabilities. Pattern packs target specific attack classes: crypto hijack, secret harvesting, protestware. You write custom packs for your own internal threat model. The model reads these instructions alongside the evidence and produces a focused verdict. |

---

## Beat 6 - The model: fine-tuned on CVEs

| Field | Content |
|---|---|
| SECTION | The model |
| ON-SCREEN / VISUAL | A pipeline animation: recent CVEs downloaded, vulnerable and fixed versions paired, source pulled, sorted into benign and vulnerable buckets. A counter ticks up over thousands of vulnerable-vs-patched pairs, then narrows to the audit dossiers used for training. Leonardo supercomputer logo. Two LoRA adapters split off. |
| VOICEOVER | The model is a 27 billion parameter Qwen variant, fine-tuned on real CVE diffs. We pulled recent CVEs, matched each vulnerable version to its fix, and distilled the diffs into audit dossiers, then trained two LoRA adapters on the Leonardo supercomputer. Small specialized modules that steer a large base model toward supply-chain audit. The adapter is published on Hugging Face. Attach it to any OpenAI-compatible endpoint and it works with our orchestrator. |

---

## Beat 7 - The model: what it does,

| Field | Content |
|---|---|
| SECTION | The model |
| ON-SCREEN / VISUAL | A finished audit report on screen, in schema, with each claim citing a line of evidence. A caption: "27B auditor, published to Hugging Face. Held-out val loss 0.2135, token accuracy 0.94." A second caption: "This measures narration fidelity, not detection accuracy." |
| VOICEOVER | Held-out validation loss is 0.2135, token accuracy 0.94. Read that honestly. It measures how faithfully the model writes up the evidence it was given, in the right schema, not how well it spots danger. The model narrates what the evidence shows. The verdict comes from the structured output schema, not from a hidden probability. You get the same output format every time. |

---


## Beat 8 - The forecast: live implementation

| Field | Content                                                                                                                                                                                                                                                                                                                        |
|---|--------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| SECTION | The forecast                                                                                                                                                                                                                                                                                                                   |
| ON-SCREEN / VISUAL | A live ModuleWarden dashboard. Click into an audit run detail. The "Temporal Forecast (Sybilion)" card expands, with per-metric rows: commits, contributors, downloads. Each with verdict badges (collapse, uncertainty, anomaly) and a linked Sybilion job ID. Below, a composite risk badge: 40%.                                |
| VOICEOVER | We ship this. For every package we audit, we pull its history, monthly commits, contributors, and npm downloads, and send each series to Sybilion. Sybilion returns a probabilistic forecast, a quantile band and a measured backtest error. From the band and the slope we derive three signals: collapse, a declining trajectory; uncertainty, a band too wide to call; anomaly, a sharp break. A wide band sends the package to a human, a tight one is safe to auto-audit. Every Sybilion job ID is linked, so you can audit the forecast itself. |

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
| VOICEOVER | Sybilion says the domain is yours. We took your forecast into supply-chain security and ran the transfer test. We kept what it earned: it ranks review order by trajectory and flags where it is too uncertain to call. We gated what it could not do: the deterministic gate and the audit pipeline own the verdict, with evidence-backed reasons. And we conceded the rest, with the data. That is how you grow a forecast into a new domain without it lying to you. |

---

## Tagline

| Field | Content |
|---|---|
| SECTION | Tagline |
| ON-SCREEN / VISUAL | ModuleWarden logo on the guarded registry node. Tagline text below. |
| VOICEOVER | ModuleWarden. Audit every version. Forecast every trajectory. Show every piece of evidence. |
