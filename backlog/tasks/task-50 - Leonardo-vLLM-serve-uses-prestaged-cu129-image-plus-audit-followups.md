---
id: TASK-50
title: 'Leonardo vLLM serve uses pre-staged cu129 image; audit follow-ups open'
status: In Progress
assignee: []
created_date: '2026-05-30 06:37'
updated_date: '2026-05-30 06:37'
labels:
  - leonardo
  - serve
  - gpu
dependencies: []
ordinal: 65000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
The 27B auditor serve on Leonardo now points at the pre-staged, world-readable vllm-openai-v0.21.0-cu129.sif in /leonardo_work/EUHPC_D30_031/mpfister-public/ instead of a per-job singularity pull of v0.6.3.post1. CUDA 12.9 userspace runs on the 535/12.2 A100 driver via 12.x minor-version compat and also covers Hopper (sm_90), so the serve is GPU-arch-agnostic. Override with MW_VLLM_SIF; falls back to the pinned pull if the staged image is absent. Also dropped a hardcoded compute-node proxy credential from the committed script (now read from MW_LEONARDO_PROXY); the staged-image plus local-model serve path needs no egress. Shipped: scripts/leonardo/slurm-vllm.sh (commit bc7e9a2 on main).
<!-- SECTION:DESCRIPTION:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Open items from the 2026-05-30 Leonardo audit (full probe list lives in the Decepticon clone at LEONARDO-NODE-AUDIT-PROMPT.md):

- GPU arch unresolved: confirm the reserved s_tra_ncc nodes are A100 sm_80 vs H100 sm_90. This only gates the source-built Decepticon llama.cpp (decepticon_gpu_build_serve.slurm hard-pins CMAKE_CUDA_ARCHITECTURES=80). The vLLM auditor serve is already arch-agnostic via the cu129 image. The cuda/12.6 module covers sm_90 if needed; there is no CUDA 13 on the system.
- ollama-0.13.2.sif is staged alongside the vLLM image. Test whether it loads the heretic-v2 qwen35 (Native-MTP) GGUF for a build-free Decepticon serve before committing to the from-source llama.cpp path.
- HF cache on the cluster is empty (refs/main stubs only). The 52GB model download still stands (login node, HF_HUB_DISABLE_XET=1, since the xet CDN is unreachable from the workstation).
- Model de-dup: weights are staged per-user in each $SCRATCH, which purges after 40 days. Consolidate to shared $WORK.
- SECURITY: the proxy credential removed in bc7e9a2 still lives in the public-repo git history. Flag for rotation, or accept it as a time-boxed internal proxy. Decision needed.
<!-- SECTION:NOTES:END -->
