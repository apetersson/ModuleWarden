# Leonardo launch kit (CINECA, Zero-One Hack reservation)

The corrected, tested SLURM kit for the hackathon Leonardo allocation. The older
`../train_qwen3.6.slurm` assumed a generic 64x H100 cluster and will not run here.
Leonardo's reservation is **1 node = 4x A100-64GB per account**, Singularity (no
Docker), and compute nodes have **no internet**, so everything is staged into
`$SCRATCH` first and the GPU job runs fully offline.

## Validated 2026-05-30 (all green on a08trc01)

- Submission path: a 1-GPU reservation job landed on lrdn0058 and got an
  A100-SXM-64GB (driver 535, CUDA 12.2). Account + partition + reservation accepted.
- `prep.slurm`: cloned the repo, pulled the `pytorch:2.4.0-cuda12.1` container
  (3.6G), built a venv with the vast-validated deps (852M), pre-downloaded the
  model into `$SCRATCH/hf`. Completed in 13:44.
- `rehearsal.slurm`: the abliterate -> SFT LoRA pipeline on Qwen2.5-1.5B ran end
  to end on the A100 in 53s (best refusal layer 23, adapter saved, `{"ok": true}`).

## The recipe (what the SLURM headers encode)

```
--account=euhpc_d30_031
--partition=boost_usr_prod
--reservation=s_tra_ncc        # 1 node per account; drop it to use the open queue
--nodes=1 --gpus-per-task=N     # N up to 4 A100-64GB
--mem=120GB*N --cpus-per-task=8*N
--time=HH:MM:SS                 # REQUIRED - a reservation job is killed at 30 min if unset
```

Reservation window: ends 2026-05-31 12:00. Two team accounts share it, so two
nodes (8 A100) run in parallel: **a08trc01 = devops/decepticon, a08trc02 =
fine-tune (Andreas)**. Live queue view: the website `leonardo/` dashboard.

## How to run

Access is password-based, no 2FA. The `leo.py` helper does non-interactive SSH and
sftp, reading creds from `~/keys.txt` (`LEONARDO_USERNAME`/`PASSWORD`, and the
`_2` pair for the second account; switch with `LEO_ACCT=2`). Never put the token
or password in a committed file.

```bash
# 1. stage everything into $SCRATCH (serial partition: internet, no 10-min limit)
#    inject the GitHub PAT into prep.slurm at upload time (placeholder in the file):
sed "s|GITHUB_TOKEN_PLACEHOLDER|$PAT|" prep.slurm > /tmp/prep.filled && \
  python leo.py --put /tmp/prep.filled '/leonardo/home/.../prep.slurm' && rm /tmp/prep.filled
python leo.py 'cd $HOME && sbatch prep.slurm'

# 2. prove the pipeline on 1 A100 (offline, model pre-staged)
python leo.py 'cd $HOME && sbatch rehearsal.slurm'

# 3. real fine-tune on up to 4 A100 (set BASE_MODEL + SFT_JSONL; see model note)
python leo.py 'cd $HOME && BASE_MODEL=... sbatch train.slurm'

# watch: squeue --me ; tail -f <job>.out ; scancel <id>
```

## Model note (read before the real run)

`train.slurm` defaults to a pure-text model (`Qwen/Qwen2.5-7B-Instruct`) that loads
cleanly in the validated transformers 4.46 stack. The intended scale-up model,
**Qwen3.6-27B**, is a vision-language model (`image-text-to-text`) and needs two
changes first: a newer transformers (which re-opens the trl/peft/bitsandbytes
version matrix) and VLM-aware loading in `abliteration.py` / `sft_lora.py`. The
pre-abliterated `huihui-ai/Huihui-Qwen3.6-27B-abliterated` skips our abliteration
stage but does not remove the VLM/version work. `Qwen/Qwen2.5-32B-Instruct` is the
low-risk pure-text option that fits 4x A100-64GB in QLoRA today. `prep.slurm`
downloads only the 1.5B; extend its `snapshot_download` to the production model and
pull the corpus (`sft-records-partial.jsonl` is on the team Nextcloud) before
`train.slurm`.

## Qwen3.6 fine-tune (modern stack, validated 2026-05-30)

The Qwen3.6 production model is a different stack from the rehearsal/text path
above. `Qwen/Qwen3.6-27B` and `huihui-ai/Huihui-Qwen3.6-27B-abliterated` are
`qwen3_5` vision-language models. Fine-tuning them text-only needs:

- torch >= 2.6 (transformers 5.9 imports `torch.distributed.tensor.device_mesh`),
  so a torch-2.6 container, not the torch-2.4 one the rehearsal uses
- transformers 5.9.0, trl 1.5.1, peft 0.19.1, accelerate 1.13.0, datasets 4.8.5
- NO bitsandbytes (its triton modules JIT-compile at import and the runtime
  container has no C compiler). The 27B trains in bf16 across 4x A100-64GB
  (256GB), so 4-bit is unnecessary on this hardware
- load with `config.language_model_only = True` to skip the vision tower; it
  comes back as `Qwen3_5ForCausalLM` via `AutoModelForCausalLM`, `device_map=auto`
- trl 1.x API: `SFTConfig` + `SFTTrainer(processing_class=tok)` (not `tokenizer=`)

This is implemented in `finetune/python/training/sft_qwen36.py` (the legacy
`sft_lora.py` stays the transformers-4.46 / trl-0.12 text path for Qwen2.5).

Validated end to end on 4x A100: the abliterated huihui-Qwen3.6-27B loaded text-
only, LoRA attached (79.7M trainable / 27.0B), trl trained on the cve_diff corpus
with loss 5.83 -> 1.11. Run it:

```bash
python leo.py 'cd $HOME && sbatch prep-qwen36.slurm'    # torch-2.6 container + deps (~10 min)
python leo.py 'cd $HOME && sbatch train-qwen36.slurm'   # bf16 LoRA SFT on 4 A100
# overrides: MWMODEL, MWCORPUS, MWOUT, MW_EPOCHS (defaults to the staged 27B + corpus)
```
