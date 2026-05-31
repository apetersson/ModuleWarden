# ModuleWarden milestones

What we built and what we learned at Zero-One Hack Vienna 2026, in the order it mattered.

## 1. A January-2026 27B fine-tuned on 2023-era A100 silicon

We fine-tuned `huihui-ai/Huihui-Qwen3.6-27B-abliterated`, a January-2026-class hybrid-attention model, into the ModuleWarden auditor end to end on 4x A100-SXM-64GB on CINECA Leonardo. Validation loss 0.21, about 43 minutes of wall time.

The hard part was the version gap. A brand-new hybrid-attention model normally wants the newest GPUs, and the reference stack assumes the latest CUDA. The hardware we had was A100 (compute capability sm_80, CUDA 12.2 host driver). We bridged it with a custom stack: a Singularity container carrying its own CUDA 12.4 userspace, torch 2.6.0+cu124 running against the 12.2 host driver through CUDA minor-version compatibility, and a config that removed the hard dependency on CUDA-version-specific kernels. The run loaded the 27B across all four A100s and trained to a clean exit.

Serving is the other half of the custom-llama story: to run the auditor as a GGUF under llama-server on the same A100s you need a source-built llama.cpp carrying the qwen3next operators (the Gated DeltaNet ops). Stock and older binaries reject the architecture.

## 2. The trained adapter is a measurably better advisor

The base model, even abliterated, rambles and does not reliably emit the structured audit report. After the LoRA fine-tune, on 37 held-out audit dossiers it never broke the schema: validation loss 0.21, token accuracy 94 percent. That number is narration fidelity, how faithfully the model writes up the evidence, not a detection score. Detection stays with the deterministic gate. The LoRA is published on Hugging Face.

## 3. A code-bearing audit corpus, not just metadata

We rebuilt the training corpus to carry sanitized diff excerpts and capability deltas from the actual package changes (prototype pollution, env mutation, module hooking, homoglyph dependencies, dependency confusion), not just package names and descriptions. The advisory text is decoupled from the model input so the label cannot leak into the features.

## 4. The honest pivot

We tested whether the Sybilion forecast can detect a dying or compromised package. It cannot: a cold-package static classifier floors at AUROC 0.54, and the forecast band and slope do not separate a dying package from a healthy one. Rather than claim a number we could not back, we kept the finding and changed the role. The forecast ranks which dependencies to review first and routes the uncertain ones to a human; the deterministic gate owns the allow, block, or quarantine verdict. False certainty is worse than honest uncertainty.

## 5. The forecast, run live at scale

We forecasted a real npm dependency tree of 46 packages through Sybilion, with real quantile bands and backtest error. The forecast's own calibration does the triage: semver and minimatch are both about 2.5 billion downloads a month, but semver's band is tight so it auto-clears, while minimatch's is wide so it goes to a human. Across the set, 18 routed to a reviewer and 28 auto-cleared, on one live run.

## 6. The full pipeline, deployable

Every new package version triggers an automatic audit at the registry, an agentic reviewer reads the code and lands on one verdict with cited evidence, and every decision ships with a git-committed evidence memo. Prompt packs make the audit instructions readable, editable, and versioned for your own threat model.
