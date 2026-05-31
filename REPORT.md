# ModuleWarden - Forecasting AI (Sybilion)

**Track:** Forecasting AI (Sybilion), "Build on Probability"
**Team:** {confirm team name}
**Repo:** https://github.com/apetersson/ModuleWarden
**Live pitch site:** https://ademczuk.github.io/modulewarden-website/

---

## TL;DR

ModuleWarden guards the one interface every dependency crosses: the package registry.
Every new version gets a deterministic security gate plus an evidence-cited audit, and a
Sybilion probabilistic forecast ranks which dependencies to review first by their adoption
trajectory. The forecast does not decide whether a package is bad; it decides what to look
at first, and the deterministic gate owns the verdict.

## Problem

Supply-chain attacks hide in the delta between two versions, not in the package as a whole,
so a careful attacker leaves nothing a static scanner flags. A modern project pulls in
thousands of transitive dependencies and cannot review each by hand. The real bottleneck is
not prediction accuracy, it is turning a probabilistic signal into a decision about where to
spend scarce review attention. That is the gap we build in: forecast the adoption trajectory
of a dependency, rank the review queue by which dependency will be load-bearing soonest, and
gate every install at the registry with an auditable verdict.

## Approach

- **Deterministic review is the verdict authority.** Release-age, source-match,
  capability-delta, lifecycle-script, and obfuscation rules fire first. The gate decides
  allow / quarantine / block. This is by design, and our evaluation confirms why (see
  Results): the model is a narrator, not the classifier.
- **27B LoRA auditor narrates the evidence.** A January-2026 hybrid 27B
  (huihui-Qwen3.6-27B-abliterated) fine-tuned with LoRA on 1,745 ModuleWarden audit dossiers
  built from real CVE version pairs, trained on 4x A100 on CINECA Leonardo. It writes the
  in-schema, evidence-cited audit report; it does not own the verdict.
- **Sybilion forecast ranks the review queue.** For each package we clone the repo, pull
  monthly git history to the first commit, and send the time series to the Sybilion API. The
  returned trajectory and per-horizon driver importance feed a priority score on the review
  queue, with every Sybilion job id linked. The forecast owns the impact axis (what becomes
  load-bearing), the gate owns the likelihood axis (detection).
- **Cross-machine adversarial loop.** A local uncensored offense model (heretic-v2, on a
  consumer GPU) generates evasive audit dossiers; the auditor on the A100 scores them. Offense
  on one machine, defense on another.

## How to run it

Setup and exact commands are in `README.md`. Dependency manifests: `package.json` (orchestrator
and dashboard), `finetune/python/pyproject.toml` (training and serving), `chat/requirements.txt`.
The Sybilion forecast path needs an API token (set via env, see `.env.example`); the auditor
adapter is published to Hugging Face (`ademczuk/modulewarden-auditor-qwen3.6-27b-lora`) and
attaches to any OpenAI-compatible endpoint. The deterministic gate runs with no model at all.

## Results (measured, not projected)

- **Auditor training.** Full run on 4x A100, 3 epochs, held-out validation loss 0.2135, token
  accuracy 0.94. Read honestly: this measures how faithfully the model writes the report in
  the right schema, not how well it detects danger. It is narration fidelity.
- **Detection evaluation, the number the training loss does not tell you.** On 30 held-out
  dossiers the tuned auditor emits the valid report schema with the correct verdict key 30/30,
  where the untuned base drifts to a wrong key and is unparseable on 6/30. But the tuned model
  predicts "quarantine" on every case: verdict-match 0.467 (exactly the quarantine base rate),
  block-recall 0/7. The fine-tune collapsed to the majority class and adds no detection signal
  on its own. This is the empirical reason the deterministic gate, not the model, is the verdict
  authority. The published adapter was trained on a small quarantine-skewed corpus; we built a
  balanced corpus and a debiased-prompt sweep to test whether that restores discrimination (see
  What we would do next).
- **Forecast honesty.** A cold-package static classifier floors at AUROC 0.54. The confidence
  band and slope do not separate a dying or compromised package from a healthy one. We do not
  claim 0.90, calibrated, or conformal. We show the floor. The forecast earns trajectory
  ranking (impact prioritization), and we gate detection on the deterministic rules.
- **Adversarial.** The auditor returned a valid quarantine report for all 6 offense-model
  dossiers, 4 of them rewritten to look benign. Honest read: this is recall, not precision,
  because the model quarantines everything; the point demonstrated is the cross-machine
  pipeline, not a catch rate.

## What worked / what did not

- Worked: getting a January-2026 hybrid 27B to train on 2023-era A100 silicon via a container
  and a text-only load; the honest evaluation discipline that caught the collapse before a judge
  would; the trajectory-ranking the forecast genuinely earns; the registry-level gate.
- Did not: the auditor fine-tune collapsed to always-quarantine on the skewed corpus; the cold
  forecast cannot separate dying from healthy packages. We report both rather than hide them.

## What we would do with another 36 hours

- The balanced-corpus, debiased-prompt, minority-oversampled LoRA sweep (running now on the
  free A100 nodes) to test whether the verdict collapse is a data artifact and restore real
  3-way discrimination, measured by block-recall, not aggregate match.
- A gate-alignment loss that penalizes divergence between the model verdict and the
  deterministic gate, so the model learns to agree with the authority rather than default.
- The adaptive demo: a judge shifts an assumption live, the Sybilion forecast re-calls, and the
  review-queue recommendation visibly changes with the driver importance and confidence band on
  screen.

## Credits & dependencies

Base model: huihui-ai/Huihui-Qwen3.6-27B-abliterated. Training: transformers, trl, peft, torch,
on CINECA Leonardo (account euhpc_d30_031). Forecast: the Sybilion API. Offense model: heretic-v2
GGUF served with llama.cpp. Data sources: GHSA advisories and CVE version pairs. AI coding tools
were used during development.
