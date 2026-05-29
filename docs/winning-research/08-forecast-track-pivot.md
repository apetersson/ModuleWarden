# Forecast-track pivot: forecasting supply-chain attack-vector risk on internal submissions

Status: concept in development (Andrew + Andreas, 2026-05-29). Zero-One Hack,
Forecast track (partner: Sybilion, "probabilistic forecasting and the agent
layer that acts on it"). This doc reframes ModuleWarden for that track and is
written against the MEASURED corpus reality in
`finetune/python/eval/CLASSIFIER-FLOOR-FINDINGS.md`, not against a borrowed
benchmark. Read that findings doc first; it is the source of truth for what the
data can and cannot support.

## The concept in one line

Forecast the likelihood that a dependency a developer is about to pull into the
company codebase is a supply-chain attack vector, by scoring what CHANGED between
the version being pulled and the known-good prior version, then act on that
forecast at submission time (allow, review, or block) with an auditable decision
record.

## Threat model (whose risk we forecast)

The largest internal risk is the person submitting code:

1. The lazy submitter. Pulls any open-source project off GitHub or npm without
   understanding the dependency risk it drags in. Picks a popular-sounding
   package, an unmaintained one, or a typosquat. Not malicious, just does not
   check.
2. The disgruntled submitter. Deliberately introduces a malicious or
   subtly-compromised dependency, or pins a known-vulnerable version on purpose.

Both reach the codebase through an internal submission (a commit, a PR, a
`package.json` edit, a CI install). That submission is the trigger.

## The measured reality (this is the load-bearing section)

A single static score on the cold package does NOT work on this corpus. Measured
2026-05-29 on an 800-artifact balanced subset:

- AUROC 0.54, Brier 0.31, ECE 0.23. Barely above a coin flip.
- Reason: the corpus is GHSA advisory pairs. `benign` is the first-patched
  release of a real package; `vulnerable` is the affected release of the same
  kind of package. Both buckets are largely the same legitimate code at two
  versions, so their absolute capability inventories are nearly identical. The
  model can only learn package size, which is uncorrelated with
  affected-vs-patched.
- The "AUROC 0.90 / GuardDog 93 percent F1" figure that earlier notes cited comes
  from malware-vs-benign typosquat detection, a different problem where malware
  screams (install hooks, obfuscation, credential theft). It does not transfer.
  Every 0.90 / calibrated / conformal-98-percent claim is struck.

This is not a data-volume problem. The ceiling for cold-package static features on
this corpus is about 0.54. More rows will not move it.

## What the measurement validates: forecast the DELTA

The signal is in what CHANGED between versions, not in what the package can do.
ModuleWarden's gate is already built on this:

- `_detect_lifecycle_script_delta`: which install or lifecycle scripts were ADDED
  versus the baseline version.
- The capability-delta detectors fed by `version_pair_extractor`: which
  capabilities (network, exec, obfuscation, credential access) appeared that were
  not in the prior version.

The forecasting object is the version delta plus, when the GPU frees up (task-18,
embedding layer, currently deferred because another model holds the GPU), the
position of that delta in embedding space relative to nearest-known-attack
patterns. That is a defensible probabilistic layer. The cold-package score is not.

Measured 2026-05-30 on 594 matched same-package pairs
(`finetune/python/eval/paired-delta/`, built by `_paired_delta_train.py`): the
paired static delta scores AUROC 0.60 (PR-AUC 0.62, Brier 0.29), versus a
same-package cold baseline of 0.25. So the delta does carry signal and beats the
cold floor, but the verdict is WEAK, not learnable enough to stand alone: the top
delta feature is still entropy (size-of-change), and capability_delta_count is
near zero. This confirms the architecture: the deterministic delta-gate is the
verdict authority, and the only lever for a strong probabilistic layer is the
code-change embedding (task-18), not static count-features.

## Architecture: gate decides, model narrates (unchanged, and now empirically justified)

The deterministic delta-gate is the verdict authority. It is auditable and emits
no fabricated score. The probabilistic layer is an enrichment, never the verdict.
The 0.54 measurement is the empirical reason this split is correct: a single
opaque static score is the wrong tool here, so the gate decides and the model
explains. That is a stronger judge story than a borrowed 0.90.

## What carries over (near-total reuse)

| ModuleWarden today | Forecast-track reframe | New work |
|---|---|---|
| `pnpm add <pkg>` hits the proxy | A submission introduces a dependency (PR / CI / commit) | trigger framing |
| `ReviewJob` queued by pg-boss | `ForecastJob` queued the same way | rename |
| Deterministic delta-gate pins the verdict | Same gate, the verdict authority | none |
| `version_pair_extractor` + delta detectors | The forecast feature surface (what changed) | none, it exists |
| `Decision` row (verdict, reason, actor) | `Decision` row carries the delta drivers + recommended action | add fields |
| Control Evidence Memo (chat/agent.py) | Forecast Evidence Memo: what changed, why it raises risk, recommended action | reword |
| React kanban (localhost:3000) | Same kanban, each card shows the delta-driven risk + action | label change |
| ZeroToOne_Data raw-bundles corpus | The paired-version data the delta features are computed on | none |

## The data (live, real numbers)

ZeroToOne_Data/finetune-data/raw-bundles on nextcloud.capacity.at, still
downloading as of this writing:

- 6,587 labeled artifacts in `artifact-index.jsonl` (3,778 vulnerable, 2,809
  benign), 14.1 GiB so far.
- Each artifact: bucket, package, version, integrity, file_count, unpacked_size,
  CVE/GHSA advisory_ids. Benign rows carry `role: "first_patched"`.
- The pairing is the asset, but only for DELTA features. For cold-package features
  the pairing is exactly why the absolute signal is flat (0.54).

## Safety (real malware in the corpus)

The vulnerable bucket is real malicious or vulnerable npm tarballs. The pipeline
is static-only by construction: feature extraction reads tarball bytes (entropy,
file counts, capability-signal counts, install-script presence) and never
extracts or executes a tarball, never runs npm or node. Samples live in a
quarantined, gitignored directory and only the static extractor touches them.

## Demo (the visible-from-stage moment)

A developer opens a PR that adds or bumps a dependency. ModuleWarden intercepts
it, the kanban card appears as "assessing," then flips to a verdict with the delta
drivers spelled out ("postinstall hook added in this version, new network +
credential capability not present in the prior release, advisory match
GHSA-xxxx"). The Forecast Evidence Memo is the audit trail. Show one
lazy-employee case (an innocently-bumped version that quietly added a lifecycle
hook) and one disgruntled-employee case (a deliberately compromised bump).

## Honest scope at hackathon time

- Lead with the deterministic delta-gate as the verdict authority. It works today,
  is auditable, and fabricates nothing.
- Present the 0.54 cold-package measurement honestly as the reason the
  architecture is gate-decides-model-narrates. Rigor is the pitch, not a number.
- The delta-embedding probabilistic layer (task-18) is GPU-deferred; the scaffold
  is ready. Do not promise a calibrated probability until it is measured on the
  delta, not the cold package.
