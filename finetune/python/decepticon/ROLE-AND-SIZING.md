# Decepticon: expanded role and model sizing

Narration is the floor, not the ceiling. This doc reconsiders what Decepticon
should do, and picks a model size based on that role rather than on "use the
biggest uncensored model."

## Reconsidering the role

Today Decepticon narrates a pinned ATT&CK kill chain. That is the minimum and it
underuses the concept. The upstream Decepticon (PurpleAILAB/VoidChecksum) is an
autonomous red-team agent. For a supply-chain defense product the valuable, safe
expansion is offense-feeds-defense: Decepticon generates the attacks our gate and
auditor must catch, then measures whether they do.

Three roles, in build order:

1. Narrator (done). Turns the deterministic kill chain into an attacker's-eye
   story for the demo and for blue-team readers. `model_client.narrate_attack_chain`.
2. Detection-coverage scorer (BUILT, `coverage.py`). Enumerates the ATT&CK
   techniques in the mapper and tiers each as gate_rule, static_signal, or
   blind_spot. Measured result: only 1 of 9 techniques (11 percent) is a hard
   deterministic catch (the install-scripts rule); the rest are weak static
   signals, and `native_or_wasm`, `dynamic_code_execution`, and
   `behavioral_change_runtime` are blind spots. This turns "we have a gate" into a
   measured coverage claim, and the blind spots are precisely what justifies the
   embedding layer (task-18). No GPU, pure static reasoning over the catalog.
3. Adversarial test-case generator (BUILT, `adversary.py`). Synthesizes adversarial
   dossiers from the catalog, scores each against the gate detection tiers, and
   emits the evasive ones as hard negatives shaped as SFT rows (label: block, the
   verdict the defense should reach). Measured: 75 percent of synthetic scenarios
   evade the one hard gate rule, reaching exec (T1059), dynamic-code (T1059.007),
   and exfil (T1041). The misses feed the Decepticon wiki `detection_gaps` and the
   SFT corpus as hard negatives. Deterministic core runs with no GPU; optional
   `--use-model` enriches with the GGUF, filtered to the catalog. This closes the
   offense-feeds-defense loop.

Safety boundary (unchanged): all generation is synthetic and static. Decepticon
never executes a package, never runs an exploit, never touches the live-malware
tarballs. It writes scenarios and narratives, not working payloads. The
deterministic mapper still pins the technique ids; generation cannot invent
techniques outside the catalog.

## Model sizing research

The naive answer is "use the biggest uncensored model." The evidence says no.

1. Abliteration damage scales with model size. Measured across the Heretic
   benchmark family: a 2B is barely affected by abliteration while a 27B loses
   substantial ground, and abliterated models forget instructions mid-task,
   struggle with multi-step reasoning, and fail constraint-heavy prompts. So a
   maximally-abliterated large model can reason worse than a smaller, lightly
   abliterated one. That matters because attack construction is multi-step and
   constraint-heavy.
2. Red-team agents get reasoning from the loop, not raw scale. RedTeamLLM
   (arXiv:2505.06913) runs a summarize-reason-act loop and names plan correction
   and context-window limits as the hard problems, not parameter count. Pentest
   work is vetted on open models from 7B (Mistral, Dolphin) up to 17B
   (Llama-4-Scout); frontier models clear the hardest challenges.
3. The mitigation that makes a large abliteration usable: KL-optimized abliteration
   (the Heretic method) is built to minimize the capability damage plain
   abliteration causes. That is why heretic-v2 is the right method and the reason a
   27B abliteration is usable at all. A DPO recovery pass restores most lost
   reasoning if it degrades.

### Recommendation, by role

- Narrator only: 7B to 8B, KL-abliterated. Abliteration barely dents this size, it
  is fast, narration is not reasoning-heavy. The 27B is overkill here.
- Detection-coverage scorer plus adversarial generator (the recommended role):
  27B to 32B with KL-optimized (Heretic) abliteration. The sweet spot: enough
  reasoning for multi-step attack construction, and Heretic keeps the abliteration
  damage low. The heretic-v2 27B GGUF you already have sits right in this band, so
  no new model is needed.
- Do not jump to 70B for this. Abliteration damage and the VRAM/latency cost rise
  faster than the planning quality, and the agentic loop closes most of the gap.
  Reserve a frontier API model for the rare hardest planning case if ever needed.
- If the 27B reasoning feels degraded after abliteration, run a DPO recovery pass
  on a clean preference set before reaching for a bigger model.

Net: keep the heretic-v2 27B for the expanded role and add the agentic loop. Drop
to 7B only if Decepticon stays a pure narrator.

## Sources

- RedTeamLLM, an agentic AI framework for offensive security: https://arxiv.org/abs/2505.06913
- Dreadnode AI red-team benchmark: https://dreadnode.io/blog/ai-red-team-benchmark
- Heretic vs abliterated, uncensored LLM comparison: https://privatellm.app/blog/heretic-vs-abliterated-uncensored-llm-comparison
- Uncensored abliteration benchmarked (HauhauCS vs Heretic vs Huihui): https://nathan.sapwell.net/posts/hauhaucs-abliteration-analysis/
- LLMalMorph, generating variant malware with LLMs (adversarial generation reference): https://arxiv.org/pdf/2507.09411
