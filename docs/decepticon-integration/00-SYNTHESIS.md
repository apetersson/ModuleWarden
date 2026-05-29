# Decepticon x ModuleWarden: swarm synthesis + adversarial pass

Five agents (tech architecture, track fit, competitive, demo/exec, model
training) analyzed how to integrate the Decepticon red-team framework into
ModuleWarden for Zero-One Hack Track 02. Full per-agent docs: 01-05 in this
folder. This file is the consolidation plus the "are you sure" second pass.

## The premise correction (read first)

The original brief said "they currently have NO Decepticon integration at
all." That was the apiary-starter (wrong-codebase) assumption. The real repo
already integrates Decepticon at the reference+data level:

- T1606 injection test vectors (`demo/tests/test_injection_robustness.py`)
- a 26-pattern npm attack catalog that generates synthetic SFT training data
  (`finetune/python/data/patterns/`)
- the "offense to our defense" framing (`q-and-a-prep.md` Q10a)
- task-30 (post-hackathon plugin-registry reference to decepticon-core)

So the job is to deepen from reference to a live-feeling capability, not to
integrate from scratch.

## What all five agents converged on (unprompted)

The integration value is the MITRE ATT&CK kill-chain MAPPING / narrative
layer over ModuleWarden's already-extracted static signals
(`capability_deltas`), NOT live execution of Decepticon. Independently
verified by the demo-exec agent: the `pip install decepticon` SDK does
nothing standalone (it routes LLM + sandbox calls to runtime services over
HTTP), and standing up the full stack (Docker Compose, Kali sandbox, Neo4j,
LiteLLM proxy) is a 13-28h spend with WSL/VRAM/safety conflicts. So live
Decepticon is out for a 36h safe build regardless of the safety rule.

The capability vocabulary the mapper must cover (from the real corpus):
network_access, process_execution, native_or_wasm, credential_or_env_access,
filesystem_sensitive_access, dynamic_code_execution, obfuscation,
lifecycle_script. postmark-mcp-1.0.16 carries lifecycle_script +
credential_or_env_access + network_access, which map cleanly to
T1195.002 (supply-chain compromise) -> T1552 (credential access) ->
T1041 (exfiltration over C2).

## The adversarial pass (are you sure?)

The trap: calling a deterministic capability-to-ATT&CK lookup table
"Decepticon integration" is the same overclaim pattern we have been killing
all session (SOC 2, fine-tuned-27B). A judge who asks "where is Decepticon
running?" gets "it is a lookup table that uses the same taxonomy." Thin.

The honest reframe (non-negotiable):

- This is MITRE ATT&CK kill-chain mapping. We adopt the same taxonomy
  Decepticon uses. Decepticon is the named offensive-validation roadmap
  partner (offense to our defense). We do NOT claim Decepticon runs live.
- The move that makes the kill chain a real MODEL capability rather than a
  lookup is the training augmentation: fine-tune the model to EMIT the
  kill-chain narrative, with the deterministic mapper as the authoritative
  grounding/fallback. This extends the verdict-pinning discipline: the
  mapper is authoritative for technique IDs; the model narrates them. Same
  rule that protects the verdict protects the technique citations.

Sequencing reality: the baseline fine-tune (running now) is on un-augmented
data and gives the honest baseline number. The ATT&CK-narrative augmentation
is a SECOND run; it is the enhancement, gated on the baseline succeeding and
time remaining.

## Tiered plan

TIER 1 - build now, safe, no execution, no new deps (~5-8h):
- `finetune/python/decepticon/mapper.py`: deterministic capability_deltas ->
  ordered ATT&CK kill chain (tactic, technique id, technique name,
  procedure). Pure Python.
- wire into the report/chat: inject the kill chain into the pinned evidence
  so the underwriter memo and the model narration cite technique ids.
- `demo/`: a static ATT&CK replay step that degrades gracefully (mirror the
  existing optional-proxy pattern in `safe_demo.sh`); no Decepticon process.
- honest framing edits to the deck/site: "MITRE ATT&CK kill-chain mapping",
  Decepticon = roadmap offensive-validation partner.

TIER 2 - if baseline model lands and time remains (~9h):
- add `kill_chain_narrative` to `audit_report.v1` + `narrative-db.json`
  (26 entries from the attack catalog) + `decepticon_augmentor.py`; re-run
  the small QLoRA so the model emits kill-chain narratives.

NARRATE-ONLY (roadmap, do not claim built): live Decepticon execution, the
16-agent swarm, the Neo4j attack-chain graph, the offensive-vaccine loop,
the 27B Leonardo run.

HARD CUTS (do not attempt): Decepticon Docker stack, pip-install-and-run,
Neo4j, executing any npm tarball or the attack-catalog injection templates.

## Competitive line (honest version)

"ModuleWarden is the only supply-chain gate that produces offense-validated,
MITRE ATT&CK-mapped attack-chain evidence - the artifact a cyber underwriter
can price, not just a score they have to trust." Socket/Snyk/Sonatype do not
close the offense/defend loop for npm packages; Snyk's offensive product
(Evo) covers first-party app code, not third-party packages. The claim rests
on mapping + the quarantine workflow, never on live-executing malware.
