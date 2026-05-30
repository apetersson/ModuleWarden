# ModuleWarden - Video Pitch Script

Target runtime: 2 to 2.5 minutes.
Track: Zero-One Hack Forecast track. Partner: Sybilion.
Frame: disciplined domain expansion. The gate detects, the model narrates, the forecast ranks, and we concede where the signal stops.

Read the voiceover at a steady pace, roughly 150 to 165 words per minute. Each beat below is one shot.

---

## Beat 1 - Hook: the threat

| Field | Content |
|---|---|
| SECTION | Hook |
| ON-SCREEN / VISUAL | A popular npm package page. The maintainer avatar. Then a red badge: "new version published." Cut to a code diff where a single added lifecycle script slips into `package.json`. |
| VOICEOVER | A package you trust gets a new release. The maintainer account is compromised, or a contributor went rogue. A careful attacker will not leave anything a static scanner can catch. The danger is not in the package. It is in what changed between two versions. |

---

## Beat 2 - Hook: the compounding-risk graph

| Field | Content |
|---|---|
| SECTION | Hook |
| ON-SCREEN / VISUAL | Display `modulewarden-website/media/compounding-risk.png`. X axis: dependency complexity, the transitive dependency count. Y axis: compounded risk, 1 minus (1 minus p) to the power of N. Animate the curve climbing as N grows. |
| VOICEOVER | Here is why this gets worse fast. Every dependency you pull in brings its own dependencies. The probability that at least one of them is an attack vector is one minus the chance they are all clean. As the tree grows, that curve climbs toward one. A modern project has thousands of these. You cannot review them by hand. |

---

## Beat 3 - The defense: guard the registry

| Field | Content |
|---|---|
| SECTION | Defense |
| ON-SCREEN / VISUAL | A diagram: developer, then the artifact registry in the middle, then the codebase. A shield drops onto the registry node. Label it "ModuleWarden." |
| VOICEOVER | So we guard the one interface every package has to cross. The artifact registry. The service you pull your packages from. One agentic code review that you kick off by hand is useful. Twenty that run automatically on every submission are consistent, and they never get tired. |

---

## Beat 4 - The gate detects on the delta

| Field | Content |
|---|---|
| SECTION | Defense |
| ON-SCREEN / VISUAL | A flowchart of a deterministic gate. Boxes light up as each rule matches: "added lifecycle scripts," "capability delta," "new obfuscation," "advisory match." A VERDICT stamp lands: BLOCK. |
| VOICEOVER | At the center is a deterministic delta-gate. It does not guess. It keys on the version delta: new lifecycle scripts, new capabilities the package never had before, fresh obfuscation, a match against a known advisory. The gate owns the verdict. It is auditable, and it emits no made-up score. |

---

## Beat 5 - Semantic analysis, the auditing rules

| Field | Content |
|---|---|
| SECTION | Defense |
| ON-SCREEN / VISUAL | A cluster of rule cards fanning out around the flagged package, each card a named, editable auditing rule. One card is opened and edited in place to show it is customizable. |
| VOICEOVER | Around the gate sits a cluster of semantic auditing rules. Well known, maintainable, and customizable, so a security team can tune them to their own threat model. This is the second pass that reads intent, not just structure. |

---

## Beat 6 - The model: where it comes from

| Field | Content |
|---|---|
| SECTION | The model |
| ON-SCREEN / VISUAL | A pipeline animation: recent CVEs downloaded, vulnerable and fixed versions paired, source pulled, sorted into benign and vulnerable buckets. Counter ticks up to 1,800 codebases. Leonardo supercomputer logo. Two LoRA adapters split off. |
| VOICEOVER | But which model narrates the evidence? We pulled recent CVEs, matched each vulnerable version to its fix, grouped the source into benign and vulnerable packages, and extracted eighteen hundred recent codebases. On the Leonardo supercomputer we trained two LoRA variants, small specialized adapters that nudge a base model toward our task. |

---

## Beat 7 - The model: what it does, honestly

| Field | Content |
|---|---|
| SECTION | The model |
| ON-SCREEN / VISUAL | A finished audit report on screen, in schema, with each claim citing a line of evidence. A caption: "27B auditor, published to Hugging Face. Held-out val loss 0.21." A second caption clarifies: "This measures narration fidelity, not detection accuracy." |
| VOICEOVER | The published model is a 27 billion parameter auditor. It takes the evidence the gate found and writes it up as an in-schema report where every claim cites its source. Held-out validation loss is 0.21. Read that honestly. It measures how faithfully the model narrates the evidence, not how well it detects danger. The gate decides. The model explains. |

---

## Beat 8 - The forecast: Sybilion ranks by trajectory

| Field | Content |
|---|---|
| SECTION | The forecast |
| ON-SCREEN / VISUAL | A dependency list re-sorting itself. Sybilion forecast curves attach to each row: react climbing, express climbing, a deprecated package flat. The climbing ones float to the top with a "review first" tag and a growing blast-radius ring. |
| VOICEOVER | Now the Sybilion forecast. Sybilion forecasts the demand and adoption trajectory of a dependency, a probability band with named drivers and a backtest. We use it to rank. The dependencies climbing fastest toward critical, the ones whose blast radius is growing, those go to the top of the review queue while they are still small enough to vet. The forecast sets the order. It does not set the verdict. |

---

## Beat 9 - The honesty beat

| Field | Content |
|---|---|
| SECTION | The forecast |
| ON-SCREEN / VISUAL | A plain results panel, no spin. "Cold-package static classifier: AUROC 0.54." Then a backtest chart: healthy and dying packages overlaid, their bands and slopes tangled together, clearly not separable. Caption: "We tested it. It cannot tell dying from healthy. Here is the data." |
| VOICEOVER | And here is the part most teams skip. We tested whether the forecast can detect a dying or compromised package. It cannot. The band and the slope do not separate a dying package from a healthy one. A cold static classifier floors at AUROC 0.54. We are not claiming 0.90, or calibrated, or conformal. We show you the floor, because false certainty is worse than honest uncertainty. |

---

## Beat 10 - Close: the domain-expansion frame

| Field | Content |
|---|---|
| SECTION | Close |
| ON-SCREEN / VISUAL | Four steps animate in sequence: "Transfer-test the forecast," "Keep what it earns (trajectory ranking)," "Gate what it does not (the gate owns the verdict)," "Concede the rest (with the data)." Then Sybilion's own slide line appears: "The domain is yours." |
| VOICEOVER | This is the real pitch. Sybilion says the domain is yours. So we did not just pick one. We took your forecast into supply-chain security and ran the transfer test. We kept what it earned, trajectory ranking. We gated what it could not do, so the deterministic gate owns the verdict. And we conceded the rest, with the data. That is the pattern for growing a forecast into any new domain without it ever lying to you. |

---

## Tagline

| Field | Content |
|---|---|
| SECTION | Tagline |
| ON-SCREEN / VISUAL | ModuleWarden logo on the guarded registry node. Tagline text below. |
| VOICEOVER | ModuleWarden. The gate decides, the model explains, the forecast prioritizes, and the honesty is on screen. |
