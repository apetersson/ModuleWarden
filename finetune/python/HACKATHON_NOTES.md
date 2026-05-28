# Hackathon Notes - Pantheon council + Qwen3.6-27B research

> Follow-up notes for PR #1. Folds in HIGH-confidence Pantheon council
> consensus + Qwen3.6-27B fine-tuning research that landed after the
> initial PR commit. Read this before launching the H100 run.

## Two training recipe options

The PR ships one config (`sft_config_qwen36.yaml`). Below are two
calibrated recipes - pick at sbatch time based on data volume and
time budget.

### Option A: Pantheon recommendation (data-conservative, 24h safe)

For when the 89 real GHSA version-pair extractions are the dominant
signal and time pressure dominates everything else.

- **Base model**: `Qwen2.5-Coder-7B-Instruct` (smaller, faster, lower OOM risk)
- **Method**: QLoRA 4-bit NF4 with double quantization, bf16 compute
- **LoRA**: r=64, alpha=128, dropout=0.05, all linear target modules
- **Sequence length**: 8192
- **Effective batch**: 128 (per-device 8, grad-acc 4-8)
- **Optimizer**: AdamW 8-bit, LR=2e-4, cosine schedule, 0.03 warmup
- **Epochs**: 3
- **Data mix**: 89 real GHSA pairs doubled (178 examples: unpatched=MALICIOUS + patched=BENIGN) + 8,000 synthetic from the apiary attack catalog
- **Split**: 62 train / 9 val / 18 test on REAL pairs only, package-disjoint, CWE+severity-stratified, time-biased test
- **Synthetic samples**: train only, never in val or test
- **Primary metric**: Macro-F1 on 18-package real test set
- **Guard**: malicious-class recall on patched (benign) examples must be `< 0.05`

### Option B: Andreas's stated choice (Qwen3.6-27B per finetune/README.md)

For when H100 access is confirmed, abliterated checkpoint is downloadable, and time budget has cushion.

- **Base model**: `huihui-ai/Huihui-Qwen3.6-27B-abliterated` (PRE-ABLITERATED checkpoint, saves the abliteration stage)
  - Apache 2.0, BF16 safetensors
  - Use this directly to skip 30-90 min of abliteration on the standard `Qwen/Qwen3.6-27B` base
- **Method**: bf16 LoRA (NOT QLoRA - Qwen team flags higher-than-normal quantization differences for Qwen3.6)
- **LoRA**:
  - `r=16-32` (16 for classification adaptation, 32 if shifting domain substantially)
  - `lora_alpha=2*r` is the safer reasoning-model default
  - `lora_dropout=0.0` (large models should not have LoRA dropout, hurts reasoning-chain fidelity)
  - `target_modules="all-linear"` - CRITICAL: Qwen3.6 has hybrid Gated DeltaNet + Gated Attention layers. The DeltaNet layers have DIFFERENT projection names than standard `q_proj`/`v_proj`. Using `"all-linear"` catches both. Hard-coding the standard 7 target names will miss the DeltaNet layers entirely.
- **Sequence length**: 4096 (do NOT go above 65536 if using Unsloth - known gradient explosion bug. Standard HF/axolotl is clean.)
- **Optimizer**: `adamw_8bit` or `paged_adamw_32bit`, LR=1e-4 (LoRA scale), cosine schedule, `warmup_ratio=0.05`
- **Batch**: per-device 2, grad-accum 4 (effective global 512 on 64xH100)
- **Mixed precision**: bf16 ONLY (fp16 causes overflow on Qwen3.6 architectures)
- **Thinking mode**: Qwen3.6-27B generates `<think>...</think>` blocks. For classification add `/no_think` to user prompts OR set `enable_thinking=False` in chat_template_kwargs.

### FSDP config (Option B, 64xH100)

CRITICAL: FSDP2 is broken with Qwen3 (axolotl issue #3056: `KeyError: lm_head.weight`). Use FSDP1.

```yaml
fsdp_version: 1
fsdp_sharding_strategy: FULL_SHARD
fsdp_auto_wrap_policy: TRANSFORMER_BASED_WRAP
fsdp_transformer_layer_cls_to_wrap: Qwen3DecoderLayer
fsdp_state_dict_type: SHARDED_STATE_DICT
fsdp_backward_prefetch: BACKWARD_PRE
fsdp_forward_prefetch: true
fsdp_offload_params: false
fsdp_use_orig_params: true
mixed_precision: bf16
activation_checkpointing: true
```

CRITICAL: gradient checkpointing requires `use_reentrant=False` or FSDP breaks:

```python
SFTConfig(
    gradient_checkpointing=True,
    gradient_checkpointing_kwargs={"use_reentrant": False},
)
```

## Eval matrix metrics

Use the SecLens-R framework (arXiv:2604.01637) - the published 4-arm evaluation framework for security-vulnerability LLMs. Maps directly to the 4 cells in `finetune/README.md`.

**Primary metrics for cyber-insurance underwriting** (false-positive cost is high):

1. **Precision@Recall90** (P@R90) - precision at the operating point where recall = 90%. Underwriters care about FPR at high-recall operating points, not raw F1.
2. **False Discovery Rate** (FDR = 1 - Precision) - directly maps to underwriter claim-cost expectation
3. **Matthews Correlation Coefficient** (MCC) - more stable than F1 when classes are imbalanced
4. **Macro-F1** (Pantheon's primary metric) - 3-class macro-average

Secondary metrics already in `eval/metrics.py`: malicious_catch_rate, false_quarantine_block_rate, json_validity, evidence_citation_accuracy, missed_suspicious, runtime, tool_call_count.

## Floor baselines (don't fall below these)

From published npm-malware detection papers - your fine-tune should beat or match these:

- **GPT-4 zero-shot on npm malware** (arXiv:2403.12196): 97% precision, 97% F1
- **Fine-tuned DeepSeek-Coder-6.7B** (same paper): 87.04% detection accuracy
- **Fine-tuned with taint-flow data** (arXiv:2510.20739): F1=0.915

A 27B model fine-tuned on real GHSA pairs + synthetic should sit between the GPT-4 zero-shot (97%) and the DeepSeek 6.7B (87%) marks. If lower than 87%, something is wrong with the training data or hyperparams.

## Known issues to avoid

| Issue | Severity | Workaround |
|---|---|---|
| FSDP2 + Qwen3 = `KeyError: lm_head.weight` | Blocker | Use FSDP1 (config above) |
| Unsloth seq_len > 65536 = gradient explosion | Blocker if using Unsloth | Use standard HF/axolotl/trl instead |
| QLoRA + Qwen3.6 = quantization differences | High | Use bf16 LoRA, not QLoRA, for Option B |
| Hybrid DeltaNet + standard target_modules = empty LoRA | High | Use `"all-linear"` target_modules |
| Think-block tokens inflate sequence | Medium | `/no_think` mode OR `enable_thinking=False` |
| `use_reentrant=True` breaks FSDP | Medium | Always set `use_reentrant=False` |

## Open question for the team (resolve before sbatch)

**Which option do we run?**

- Option A (Pantheon, 7B): runs in 2-4 hours on 8 H100s. Safer for 24h time pressure. Smaller model, less novelty.
- Option B (Andreas's choice, Qwen3.6-27B abliterated): runs in 6-12 hours on 64 H100s. Bigger model, novelty story stronger for UNIQA judges, requires confirmed H100 access + stable training.

Recommendation: run Option A first (low risk validation), and if it converges cleanly, kick off Option B as a stretch run for the strongest demo number.

Pre-flight before either option: `python -m finetune.python.training.rehearsal` on a 1.5B model in 30 min before burning any H100 hours.

## External recipes worth flagging

Two repos landed during the build window that are worth a decision
*after* Saturday SFT lands. Neither requires changes to the pinned dep
cohort or the canonical schemas. Both stay inside the 4-arm matrix
shape; the second adds a 5th arm rather than replacing one.

### unslothai/unsloth (single-node SFT/QLoRA, 65k stars)

Fit: Recipe A only (parallel vast.ai 7B QLoRA safety net). Strengths
are single-node, single- or few-GPU: 2x faster, 70 percent less VRAM,
Qwen-specific bug fixes called out in their README.

Do NOT use on Leonardo Option B (Qwen3.6-27B FSDP1 across 6 nodes).
Their multi-node story is "available with a major upgrade on the
way", which we cannot absorb on hackathon day. Their `seq_len >
65536` Qwen3 gradient-explosion warning does not apply to Option B
(we run seq_len 4096) but is documented above and worth knowing.

Concrete swap, if accepted: replace the `pip install transformers
peft trl accelerate datasets bitsandbytes` cohort in vast_smoke.py
with `pip install "unsloth[colab-new] @
git+https://github.com/unslothai/unsloth.git"`. The training script
shape is unchanged (model, dataset, lora_config, SFTTrainer). Wins
about 2x wall-clock on the same A100; lets us run 2-3 hyperparam
ablations inside the same budget.

### AkaliKong/MiniOneRec (constrained-decoding reference, 1601 stars, Apache 2.0)

Fit: arm 5 in the eval matrix, after SFT convergence. Their
`LogitProcessor.py` is a 75-line `transformers.generation.LogitsProcessor`
subclass that takes a `prefix_allowed_tokens_fn` callback returning the
allowed token-id list for the current decode position. Domain mismatch
on paper (next-item recommendation, not classification), but the
constrained-decoding mechanism is domain-neutral and the SFT-then-GRPO
sandwich pattern in `minionerec_trainer.py` is exactly the recipe
arXiv:2602.14012 ("From SFT to RL for Vulnerability Detection")
describes.

Why this matters: ALLOW / BLOCK / QUARANTINE is a closed three-token
verdict space, and our dossiers carry a finite `evidence_index` list.
Porting the LogitProcessor with a callback that allows only those
tokens at the right decode positions takes the `json_validity` metric
to 100 percent by construction and the citation-format axis of
`evidence_citation_accuracy` to 100 percent (the model cannot emit an
`ev.fake.999` that is not in the dossier).

Cost: about 3 to 4 GPU-hours from a working SFT checkpoint. Port (1h)
+ adapt the trainer reward to verdict correctness plus a 10 percent
evidence-ref-match bonus (1h) + 50 to 100 GRPO steps (1 to 2h on 8
to 16x A100s). Fits inside the documented slack window if Saturday
SFT lands before late afternoon.

Decision deferred until SFT loss curve is in hand. Add as arm 5 of
the existing `matrix_runner.py` rather than replacing arms 1 to 4.

## Sources

- Pantheon council session `d7b711f5-a467-4cbd-a395-a74492a157a0` (HIGH confidence, 3 reviewers)
- `huihui-ai/Huihui-Qwen3.6-27B-abliterated` HuggingFace card
- `Qwen/Qwen3.6-27B` HuggingFace card
- Qwen3 Best Practices - Swift docs (swift.readthedocs.io)
- axolotl issue #3056 (FSDP2 Qwen3 lm_head bug)
- arXiv:2604.01637 (SecLens-R 4-arm eval framework)
- arXiv:2403.12196 (Shifting the Lens: npm malware detection)
- arXiv:2510.20739 (Taint-based code slicing, F1=0.915 baseline)
- arXiv:2602.14012 (From SFT to RL for Vulnerability Detection)
- `unslothai/unsloth` README
- `AkaliKong/MiniOneRec` `LogitProcessor.py` and `minionerec_trainer.py`
