# Leonardo HPC onboarding (consolidated)

Merges the AI Factory Austria onboarding kit (https://ai-at.eu/hpc-onboarding/)
with the concrete hackathon facts from the briefing and `docs/leonardo-docs`. This
is the team reference for running ModuleWarden inference on Leonardo.

## What Leonardo is

Leonardo is the EuroHPC pre-exascale supercomputer at CINECA (Italy). The GPU
("booster") nodes are 4x NVIDIA A100 64 GB each. We use it for LLM inference and
the fine-tune; everything else stays local.

## Access

- Normal route (per the onboarding kit): CINECA UserDB account linked to a project,
  the Step client plus a certificate, SSH config, and 2FA. EuroHPC access tracks run
  from Playground and Fast Lane to Large Scale Access.
- Hackathon route (what we use): a shared account (`a08trcNN`), no 2FA. SSH to any
  of `login0{1,2,5,7}-ext.leonardo.cineca.it`. The login password lives in
  `.leonardo-access` (kept out of git); `tunnel.sh` and `deploy-vllm.sh` source it.

## Login vs compute nodes

- Login nodes: prep only. About a 10-minute CPU cap, no heavy compute. Internet
  lives here, so download models and containers on the login node.
- Compute nodes: GPU work, no internet. Partition `boost_usr_prod`. One node is
  4x A100 64 GB.

## Reservation

`s_tra_ncc` is the hackathon reservation: it jumps the queue, one node per team.
Reservation jobs without a set `--time` are killed at 30 minutes, so always set
`--time`. Add `#SBATCH --reservation=s_tra_ncc` to use the fast lane; drop it for
the general queue or multi-node runs.

## Storage

- `$HOME` 50 GB.
- `$SCRATCH` about 20 TB, purged after 40 days. Put models and containers here.
- `$PUBLIC` for sharing between accounts.
- Do not touch `$FAST` or `$WORK`.

The deploy uses `/leonardo_scratch/large/usertrain/$USER` for the model cache, the
vLLM `.sif`, and logs.

## Compute-node internet: the HTTP proxy

Compute nodes have no direct internet. A low-bandwidth HTTP proxy at
`10.99.0.1:38425` (proxyuser credentials in `.leonardo-access` / the leonardo
scripts) lets vLLM and huggingface reach out; it restarts roughly every 10 minutes,
so large pulls should happen on the login node where possible.

## Environment and containers

- Pixi is the preferred env manager (conda-forge based).
- Containers run via Singularity/Apptainer. No Docker on HPC. Convert a Docker
  image with `singularity pull --name x.sif docker://...`.

## SLURM basics

- Submit with `sbatch job.sh`; check with `squeue --me`.
- GPU jobs: `--partition=boost_usr_prod`, `--reservation=s_tra_ncc`,
  `--gpus-per-task=N` (up to 4), and the Leonardo fair-share ratios
  `--cpus-per-task=8*N`, `--mem=120GB*N`. `--time` up to 24:00:00.
- Light non-GPU prep (pulling containers, fetching models) can use the serial
  partition `lrd_all_serial`.

## ModuleWarden integration on Leonardo

LLM inference moves to Leonardo; everything else stays local. vLLM serves the
abliterated `huihui-ai/Huihui-Qwen3.6-27B-abliterated` (TP=4) on one compute node at
port 8000; the local stack reaches it over an SSH tunnel (`localhost:8081` maps to
`node:8000`). Target 8 to 16 concurrent audit containers against the one vLLM
instance.

Scripts in `scripts/leonardo/`:

- `slurm-vllm.sh` pulls the vLLM `.sif` and launches the OpenAI API on 8000 (TP=4,
  max-model-len 32768, 8 h).
- `deploy-vllm.sh` uploads and submits the job, waits for RUNNING, writes
  `.leonardo-vllm-state`.
- `tunnel.sh` opens the autossh tunnel to the compute node.
- `vllm-health-check.sh` hits `/v1/models`, `/health`, and a chat smoke test.

For Decepticon specifically, serve the heretic-v2 GGUF
(`llmfan46/Qwen3.6-27B-uncensored-heretic-v2-Native-MTP-Preserved-GGUF`, `Q5_K_M`)
with llama.cpp, not the vLLM path. Decepticon is inference-only offense narration,
not a fine-tuned model, so it consumes the pre-abliterated GGUF as-is. Stage it on
the login node with `./fetch-models.sh --decepticon-gguf` and point
`DECEPTICON_MODEL_ENDPOINT_BASE_URL` at the tunnel. See
`finetune/python/decepticon/SERVE.md`.
