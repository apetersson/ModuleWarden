---
id: TASK-40
title: 'vast.ai smoke validated training pipeline; fixed trl eager-import bug (PR #24)'
status: Done
assignee: []
created_date: '2026-05-29 18:06'
labels: []
dependencies: []
ordinal: 56000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Ran the rehearsal smoke on a vast.ai RTX 3090 (Qwen2.5-1.5B, --quick) to de-risk the Leonardo run before 21:30. It surfaced and we fixed a real bug that would have failed Leonardo stage-2 SFT. Also confirmed the GPU-box dependency matrix.

PROVEN: clone (private repo, PAT), dep install, synthetic SFT records, dataset load, and the path up to model load all work on a clean GPU box. trl import no longer blocks.

BUG FIXED (PR #24, on main): sft_lora._require used __import__(module, fromlist=['*']), forcing trl to eager-load its SD/DDPO trainers (diffusers + flash-attn) that SFT never needs. They fail to import on common version combos. Dropped fromlist so trl lazy-loads only SFTTrainer/SFTConfig. Without this the Leonardo SFT stage hits the same wall.

DEP MATRIX for the training venv (Leonardo + vast): transformers 4.46, accelerate 1.1, datasets 3.1, peft >= 0.17 (trl 0.12.2 demands it), trl 0.12.2 (sft_lora targets SFTConfig + tokenizer= which is the 0.12 API), bitsandbytes 0.44, plus diffusers (trl transitively imports it). Pin these in the slurm .venv setup.

SECOND minor bug (not blocking, rehearsal-only): rehearsal.py --skip-abliteration leaves abliterated_path pointing at a non-existent dir instead of None, so SFT tries to load a model never written. Run the full rehearsal (no skip) or set abliterated_path=None on skip.

CREDS now available and saved locally in ~/keys.txt (NOT in git): Nextcloud (ademczuk), GITHUB_PAT_MODULEWARDEN (5000/hr), VASTAI_API_KEY. Leonardo queue creds arrive 21:30 Vienna. Full SFT-to-completion smoke run in progress on vast.

See docs/TEAM-HANDOVER.md for the full picture.
<!-- SECTION:DESCRIPTION:END -->

## Result (2026-05-29 18:25 UTC) - GREEN

Full rehearsal ran end to end on the vast.ai RTX 3090 and exited with {"ok": true}:

- Abliteration (Leonardo stage 1): best refusal layer 23 (norm 46.26), orthogonalized 56 weight matrices across 28 layers, saved abliterated model.
- SFT LoRA (Leonardo stage 2): trained 1 epoch (train_loss 0.8677), wrote adapter_model.safetensors (73.9 MB) + adapter_config.json + tokenizer to model_sft/.

Both Leonardo stages are now proven on real GPU hardware. The trl eager-import fix (PR #24) was required to reach this. Instance destroyed after the run, no further billing.

NOTE for the team: there is a duplicate TASK-40 id collision from parallel work (this task and "Auditor LLM-wiki with BM25 RAG"). Worth renumbering one of them when convenient.
