# Live A/B: the fine-tuned 27B auditor vs the stock base

The "watch it work" artifact for the trained model. We loaded the published 27B
base on 4x A100 (Leonardo) and ran two held-out validation dossiers through it
twice: once with the LoRA adapter DISABLED (the stock base) and once ENABLED (the
ModuleWarden auditor). Same weights, same prompt; the only difference is our
adapter.

## What it shows

On dossiers the model never saw during training:

- **Stock base (adapter disabled)** does not know our schema, and says so:
  "Since I don't have the exact schema definition for modulewarden.audit_report.v1,
  I'll infer a standard structure." It then invents generic fields
  (`cited_evidence`, `policy_applied`, a `findings` array of type/description) that
  are not the real report schema.
- **Fine-tuned auditor (adapter enabled)** recovers the exact proprietary schema
  (`primary_findings` with finding_id/category/severity/claim/evidence_refs/
  why_it_matters, `benign_explanations_considered`, `recommended_agent_checks`,
  `developer_safe_summary`, `security_admin_summary`, `output_integrity`), recites
  the policy constraints (cite only evidence ids in the index, quarantine on
  uncertainty, never invent evidence refs), and reproduces the human gold verdict
  for `tmp@0.2.6`: quarantine, confidence medium, risk_level high, with the same
  summary.

That schema recovery plus verdict match on unseen data is the lift. It is what "we
trained a real model on real data" looks like when you put the base next to it.

## Honest caveat

The base is a reasoning model, so it thinks before it writes the JSON and most of
the 1500-token budget goes to that reasoning. What this demonstrates is narration
and schema fidelity (the model knows the format and the policy and tracks the human
verdict), not a detection-accuracy number. The deterministic gate stays the verdict
authority; this model explains the gate's decision in the right schema. See
`finetune/MODEL_CARD.md` for the held-out numbers and the AUROC 0.54 floor.

## Receipts

- Cluster: CINECA Leonardo Booster, account euhpc_d30_031, reservation s_tra_ncc.
- GPUs: 4x A100-SXM-64GB (sm_80, CUDA 12.2 host), inside the `pytorch57.sif`
  Singularity container, the same stack that trained the adapter.
- Base: `huihui-ai/Huihui-Qwen3.6-27B-abliterated` (text backbone, language_model_only).
- Adapter: the published `sft27-adapter-full` (`ademczuk/modulewarden-auditor-qwen3.6-27b-lora`).
- Dossiers: 2 held-out val records from `sft-records-partial.jsonl`.

Full transcript: `base-vs-tuned-raw.md`.

## Reproduce

`infer_ab.py` loads the base plus the adapter once and generates each report with
the adapter disabled, then enabled (`PeftModel.disable_adapter`). `mw-ab.slurm` runs
it on one reserved A100 node:

    sbatch demo/leonardo-ab/mw-ab.slurm

Set `MWMODEL`, `MWADAPTER`, `MWCORPUS`, `MWN`, `MWMAXNEW` in the slurm for your paths.
