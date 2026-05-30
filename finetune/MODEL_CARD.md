# ModuleWarden auditor model card

A real, trained model on real data, reported honestly including where it is
weak. The deterministic gate is the verdict authority; this model is the
narrator that turns a pinned verdict into an evidence-cited audit report.

## The model judges should look at: the 27B auditor (published)

- Base: `huihui-ai/Huihui-Qwen3.6-27B-abliterated`, a January-2026-class 27B
  hybrid-attention model (Gated DeltaNet plus Gated Attention). The text
  backbone is loaded and the vision tower skipped; we are training a code
  auditor, not a VLM.
- Method: bf16 LoRA, r16 / alpha32 / dropout 0.05 on q,k,v,o,gate,up,down_proj.
  79.7M trainable params (0.30%). No 4-bit: bitsandbytes collides with
  transformers 5.9 on this stack, so `device_map=auto` shards the 27B across
  four 64GB cards instead.
- Compute: 4x A100-SXM-64GB (sm_80, CUDA 12.2 host) on CINECA Leonardo, inside a
  Singularity container carrying its own CUDA 12.4 userspace. About 43 minutes
  wall, 3 epochs.
- Data: 152 ModuleWarden audit dossiers (103 train / 37 val), GHSA cve_diff, the
  dossier-to-report task.
- Result: held-out val loss 0.2135, token accuracy 0.9435. Train loss fell from
  about 4.9 to about 0.16 over 3 epochs.
- Published: `ademczuk/modulewarden-auditor-qwen3.6-27b-lora` on HuggingFace
  (the LoRA adapter, about 305MB, with an honest card). The artifact survives
  the Leonardo scratch purge.

### Honest reading of the 27B numbers

- What the lift is: the stock model refuses to read and describe malicious npm
  code, and even the abliterated base rambles and will not emit the report in
  the fixed schema. After the LoRA, on 37 dossiers it never saw during training,
  it writes the structured, evidence-cited audit report in the right schema and
  voice.
- What 0.94 is: teacher-forced next-token fidelity on a small, verdict-skewed
  set. It is narration fidelity, not detection accuracy. Do not put "94 percent
  detection" on a slide.
- What is not yet measured at 27B: verdict-match and block-recall (does it call
  the right allow / quarantine / block). That evaluation has not run yet. The
  defensible claim today is that the auditor stopped refusing and now produces
  auditable, in-schema, evidence-cited reports with high fidelity on unseen
  dossiers.

## The earlier 0.5B local run (the measured detection floor)

Before the 27B, a `Qwen2.5-0.5B-Instruct` QLoRA was trained locally (386 train
records, 2 epochs, train loss ~0.51) so the detection metrics could be measured
cheaply. Those numbers are why the architecture is gate-decides, model-narrates.

| split | arm | verdict-match | schema-valid JSON | block-recall |
|---|---|---|---|---|
| validation (30, all-quarantine) | base | 0% | 0% | n/a (no blocks) |
| validation (30, all-quarantine) | fine-tuned | 46.7% | 3.3% | n/a (no blocks) |
| test (23, 5 blocks) | base | 0% | 0% | 0/5 (0%) |
| test (23, 5 blocks) | fine-tuned | 73.9% | 21.7% | **0/5 (0%)** |

The lift is real (the stock model emits no parseable verdict at all), but the
0.5B's standalone block-recall is 0%: it reaches its verdict-match by defaulting
to the majority class and catches none of the held-out block cases. At 0.5B that
is expected. So the deterministic 5-rule gate is the verdict authority, not the
model: the gate independently flags the compromised release (postmark-mcp-1.0.16
raises release-age, install-scripts, and source-match FAILs and quarantines it;
the report escalates to block). The model narrates that decision, it does not
source it.

## Why a static classifier cannot be the detector either

A static classifier on the COLD package floors at AUROC 0.5387 (about coin-flip)
on 800 balanced GHSA pairs, because the top features are size proxies, not
maliciousness. The paired version-DELTA lifts it to about 0.60. The signal is in
what changed between versions, not the package in isolation, which is the
empirical reason the deterministic delta-gate reads the diff and owns the
verdict. We do not claim AUROC 0.90, calibration, or conformal coverage as a
headline.

## Safety

Training and evaluation read JSON text only. No npm package is downloaded,
installed, or executed; model output is parsed as inert JSON, never run.

## Artifacts to show

- The published adapter: `ademczuk/modulewarden-auditor-qwen3.6-27b-lora` on
  HuggingFace.
- `finetune/python/eval/finetune-metrics.attck.json`, `finetune-metrics.test.json`
  (the 0.5B detection numbers).
- `finetune/python/eval/classifier-floor-metrics.json` and
  `CLASSIFIER-FLOOR-FINDINGS.md` (the AUROC 0.54 cold-package floor).
