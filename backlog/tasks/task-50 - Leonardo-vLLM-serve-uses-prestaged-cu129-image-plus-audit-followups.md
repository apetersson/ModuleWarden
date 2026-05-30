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
Full 2026-05-30 Leonardo audit landed (probe list in the Decepticon clone at LEONARDO-NODE-AUDIT-PROMPT.md).

RESOLVED:
- GPU arch: reserved nodes are uniformly A100-SXM-64GB, sm_80, CUDA 12.2. No H100. The committed CMAKE_CUDA_ARCHITECTURES=80 is correct; left as-is.
- Reservation window: s_tra_ncc ends Sun 2026-05-31 12:00 CEST (covers the 10:00 deadline). No walltime cap on normal QoS; both accounts can hold reserved GPUs at once.
- Compute-node egress: none. DNS resolves but TCP egress is blocked and there is no usable proxy. On-stage Decepticon is fully offline narration of a pinned ATT&CK chain; pre-stage everything, TRANSFORMERS_OFFLINE=1.
- Control plane: docker absent; runtime is SingularityPRO 4.3.1 (rootless), no docker socket or compose networking. Decepticon's Kali sandbox + Sliver C2 + LiteLLM + Neo4j stay local; only the inference endpoint serves on Leonardo. LLM-only is forced, not chosen.
- gcc: Decepticon build now uses the gcc/12.2.0 module host compiler with a version-guarded -lstdc++fs fallback (commit 534b3f0). gcc/12.2.0 confirmed available.
- Model de-dup: rsync of both models (52G abliterated + 19G GGUF) from a08trc01 $SCRATCH to shared $WORK=/leonardo_work/EUHPC_D30_031/models (group-shared, no purge, 2.3T free). slurm-vllm.sh now prefers the $WORK copy with a $SCRATCH fallback (commit 534b3f0). Also gives a08trc02 a copy he did not have.

- ollama path REJECTED: ollama-0.13.2.sif imports the heretic-v2 GGUF metadata (create succeeds) but its bundled llama.cpp fails the model load with "unknown model architecture: 'qwen35'". The GGUF is a hybrid SSM+attention Native-MTP arch that only the latest llama.cpp builds. So the from-source llama.cpp build (decepticon_gpu_build_serve.slurm, now gcc/12.2.0) stays the Decepticon serve path on Leonardo. Verified on lrdn0058, 2026-05-30.
- Decepticon serve GGUF now reads the shared $WORK copy with a $SCRATCH fallback (a715280).

REMAINING:
- Coordinate job submission and shared $WORK writes between a08trc01 and a08trc02 (one project, one 25-node reservation, shared pool).
- SECURITY: the proxy credential removed in bc7e9a2 still lives in the public-repo git history. Flag for rotation, or accept it as a time-boxed internal proxy. Decision needed.
<!-- SECTION:NOTES:END -->
