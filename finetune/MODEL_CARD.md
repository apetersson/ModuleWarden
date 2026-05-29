# ModuleWarden auditor model card

A real, trained model on real data, reported honestly including where it is
weak. The deterministic gate is the verdict authority; this model is the
narrator that turns a pinned verdict into an audit report.

## Model

- Base: `Qwen/Qwen2.5-0.5B-Instruct`
- Method: QLoRA, 4-bit NF4, LoRA r=16 alpha=32 on all attention + MLP projections
- Data: `finetune/corpus/sft-records.attck.jsonl` (the GHSA SFT corpus,
  ATT&CK-augmented), 386 train records, dossier-to-report task
- Epochs: 2, train loss ~0.51
- Trained locally on an RTX 5090. The 1.5B and 27B are the documented vast.ai
  / Leonardo scale-up (see `RECIPE_A_LAUNCH.md`); they are not trained yet.

## Results (base vs fine-tuned, held-out)

Base = the stock model with the LoRA adapter disabled. Metrics computed by
`finetune/python/training/local_finetune_eval.py`; artifacts in
`finetune/python/eval/finetune-metrics.attck.json` (validation) and
`finetune-metrics.test.json` (test).

| split | arm | verdict-match | schema-valid JSON | block-recall |
|---|---|---|---|---|
| validation (30, all-quarantine) | base | 0% | 0% | n/a (no blocks) |
| validation (30, all-quarantine) | fine-tuned | 46.7% | 3.3% | n/a (no blocks) |
| test (23, 5 blocks) | base | 0% | 0% | 0/5 (0%) |
| test (23, 5 blocks) | fine-tuned | 73.9% | 21.7% | **0/5 (0%)** |

## Honest reading

- The lift is real. The stock model emits no parseable verdict (0%);
  fine-tuning on real data teaches it the verdict format and reproduces the
  human auditor's verdict on 46.7-73.9% of held-out cases. That is the proof
  the data and pipeline work end to end.
- The model's standalone block-recall is 0%. It reaches its verdict-match by
  defaulting to the majority class (quarantine) and catches none of the 5
  held-out block cases. At 0.5B this is expected.
- Therefore the deterministic 5-rule gate is the verdict authority, not the
  model. The gate independently flags the compromised release
  (postmark-mcp-1.0.16 raises release-age + install-scripts + source-match
  FAILs and quarantines it; the audit report escalates to block). The model
  narrates that decision in underwriter language; it does not source it.
- Block-recall is the insurance-critical metric and the one the model fails
  at this size. It is the metric the 27B scale-up targets. We do not claim
  the model catches severe cases today; the gate does.

## Safety

Training and evaluation read JSON text only. No npm package is downloaded,
installed, or executed; model output is parsed as inert JSON, never run. The
only network access is the stock base-weights download from HuggingFace.

## Artifacts to show

- `finetune/python/eval/finetune-metrics.attck.json`, `finetune-metrics.test.json`
- `finetune/python/training/local_finetune_eval.py` (the code that produced the numbers)
- `finetune/python/training/adapters/local-sft/` (the LoRA adapter weights)
