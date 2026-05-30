# ModuleWarden pitch video, verbatim narration

The exact words spoken in `demo/ModuleWarden_pitch.mp4` (female voice, Kokoro
af_bella). Runtime 2:30. One block per shot, in order.

1. Title. ModuleWarden, by Team Andrew.

2. The threat. A package you trust ships a new release. The maintainer account is compromised, or a contributor goes rogue. Nothing a static scanner alone can catch. The danger is the delta: what changed between two versions.

3. Compounding risk. And it gets worse fast. Every dependency brings its own dependencies. The chance that one of them is an attack vector climbs toward certain as the tree grows. A modern project has thousands. You cannot review them by hand.

4. Guard the registry. So we guard the one interface every package crosses: the registry you pull your packages from. You activate it with a single line. ModuleWarden then runs a full audit automatically on every new version, before it reaches your code.

5. Evidence first. Every new version triggers a full audit. An agentic reviewer reads the code from multiple angles and lands on one verdict: allow, block, or quarantine. You open the session and read exactly what the model saw.

6. Prompt packs. What the model looks for is defined by prompt packs: readable, versioned instruction files. Core packs cover purpose versus behavior, install-time execution, and known vulnerabilities. Pattern packs target attack classes like crypto hijack and secret harvesting. You add custom packs for your own threat model.

7. The model. The model is a twenty-seven billion parameter Qwen, fine-tuned on real CVE diffs. We matched each vulnerable version to its fix, distilled the diffs into dossiers, and trained two LoRA adapters on the Leonardo supercomputer. It is published on Hugging Face.

8. Trained vs untrained. Held-out validation loss is zero point two one, token accuracy ninety-four percent. That measures how faithfully the model writes up the evidence, not how well it spots danger. Untuned, the base drifts the schema. Tuned, it emits a valid report every time. The verdict comes from the schema, and detection stays with the gate.

9. The forecast, two signals. We ship the forecast. We send each package's monthly download history to Sybilion, and use two things: the slope, to rank which packages to review first, and the band width, to route the work. Too wide to call goes to a human. A tight band, and the gate auto-audits and owns the verdict.

10. Live at scale. We ran it live across forty-six packages. Semver and minimatch are the same size, two and a half billion downloads a month each, but the forecast separates them. Semver's band is tight, so it auto-clears. Minimatch's is wide, so a human looks. Eighteen routed, twenty-eight cleared. The forecast decides who gets your attention.

11. The honesty beat. Here is the part most teams skip. We tested whether the forecast can detect a dying package. It cannot. The band and slope do not separate dying from healthy. A cold classifier floors at AUROC zero point five four. We do not claim ninety, or calibrated. We show you the floor. False certainty is worse than honest uncertainty.

12. Close. Sybilion says the domain is yours. We ran the transfer test. We kept what the forecast earned, trajectory ranking. We gated what it could not, the gate and audit pipeline own the verdict, with evidence. And we conceded the rest, with the data. That is how you grow a forecast into a new domain without it lying to you.

13. Tagline. ModuleWarden. Audit every version. Forecast every trajectory. Show every piece of evidence.
