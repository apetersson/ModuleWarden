# When Decepticon runs: its 3 stages in the pipeline

Short answer: the three stages run at three different cadences. Only stage 1
touches the live install/audit path. Stages 2 and 3 run off the request path and
shape the gate and the auditor that the live path uses. Together they form a loop
that runs across training cycles, not inside a single request.

## The live runtime path (where a real install is handled)

This is the manual-e2e flow. It runs every time a developer pulls a dependency.

    dev: pnpm add pkg@ver
        -> ModuleWarden proxy intercepts (does NOT install)
        -> pg-boss queues a ReviewJob
        -> worker runs the audit-runner container (model-backed audit)
        -> dossier + report produced, Decision row written
        -> [STAGE 1: Decepticon narrate]  the mapper builds the ATT&CK kill chain
           from the dossier capability_deltas; if a Decepticon endpoint is set,
           narrate_attack_chain turns it into the attacker's-eye story in the memo
        -> dashboard kanban shows the verdict + the narrative
        -> retry is blocked

Stage 1 is the only stage on this path, and even here it is optional enrichment:
the gate pins the verdict, Decepticon just explains the attack path. No Decepticon
endpoint configured means the deterministic kill-chain text still renders, just
without the model narrative.

## Off the request path (system-level and training-time)

Stages 2 and 3 do not run per install. They run when the system or the training
data changes.

Stage 2, coverage scorer (`coverage.py`). Runs in CI or as a one-shot before the
demo, whenever the gate rules or the mapper catalog change. It scores the gate's
detection coverage against the whole ATT&CK catalog (the 11 percent deterministic
result). It is a property of the system, not of one package, so it runs once per
change, not once per audit. Output feeds the pitch deck and flags blind spots.

Stage 3, adversarial generator (`adversary.py`). Runs at training-data prep time,
before a fine-tune or during a red-team pass. It generates synthetic hard
negatives (the 75 percent evasion result) and writes them as SFT rows plus a
detection_gaps summary. Output feeds the NEXT auditor fine-tune and the Decepticon
wiki. Deterministic core needs no GPU; `--use-model` enriches with the 27B GGUF.

## The loop (across cycles, not within one request)

    [STAGE 3] adversary generates hard negatives  (training-time)
        -> fine-tune the auditor on them            (training-time)
        -> [STAGE 1] auditor narrates better verdicts at runtime  (per install)
        -> [STAGE 2] coverage re-measures the system  (per change / pre-demo)
        -> reveals new blind spots
        -> [STAGE 3] adversary targets them next cycle
    (offense feeds defense, over time)

## Cadence table

| stage | when it runs | trigger | on live install path? | feeds |
|-------|--------------|---------|------------------------|-------|
| 1 narrate | per audit | a real package audit | yes (optional enrichment) | the dashboard memo |
| 2 coverage | per change / pre-demo | gate or mapper edit, CI, deck prep | no | pitch metric, blind-spot list |
| 3 adversary | per training cycle | before a fine-tune / red-team pass | no | SFT hard negatives, wiki gaps |

## How to say it to Andreas

Decepticon is not a step in the install flow. Only its narration runs there, and
only to explain the gate's pinned verdict. Its real work happens around the
pipeline: stage 2 measures how much of the attack surface our gate actually
catches (11 percent deterministic), and stage 3 manufactures the attacks that slip
through (75 percent evasion) as training data, so the next auditor catches them.
The gate decides in real time; Decepticon makes the gate and the auditor better
between cycles.
