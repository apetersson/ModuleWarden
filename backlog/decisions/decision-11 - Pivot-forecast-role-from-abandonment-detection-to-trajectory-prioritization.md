---
id: decision-11
title: >-
  Pivot the Sybilion forecast role from abandonment-detection to
  trajectory-prioritization (backtest-driven)
date: '2026-05-30 22:00'
status: accepted
---
## Context

decision-10 took us to the Forecast track with the thesis "forecast the demand DELTA and
read declining demand plus a widening band as abandonment risk." On 2026-05-30 we
BACKTESTED that thesis on 12 real packages against the LIVE Sybilion API
(Hackathons/260528-Supercompute/retro_backtest.py). It does not hold. The forecast band
and slope do NOT separate declining from healthy packages, and run backwards if anything
(healthy high-volume packages have the widest bands; the band reflects volatility and
scale, not abandonment). Downloads lag abandonment because abandoned-but-depended-on
packages keep getting installed by old lockfiles and CI. Data table in the retro output.

## Decision

Pivot the forecast's role from DETECTION to PRIORITIZATION. The one thing the forecast
cleanly separates is GROWTH (react +144 percent, express +89 percent, axios, lodash on
confident rising curves; deprecated packages flat or fading).

1. The Sybilion forecast RANKS dependencies by forecasted growth and blast-radius
   trajectory, so a security team reviews the ones climbing toward critical first, while
   they are still small enough to vet. The forecast does NOT detect danger.
2. The deterministic gate remains the security detector. Decepticon's mapper classifies a
   flagged dependency into an ATT&CK kill chain for the evidence memo.
3. The pitch concedes the measured negative result honestly ("we tested whether the
   forecast detects a dying package, it cannot, here is the data") as the "honest about
   uncertainty" pillar.

Locked pitch and plan: Hackathons/260528-Supercompute/FORECAST-WIN-PLAN.md and
PITCH-2MIN.md. Verified API facts (bands real, backtest real MAPE 10.6 percent, drivers
weak for software, 60-observation minimum, tier-0 2-concurrent): SYBILION-INTEGRATION-SPEC.md.

## Consequences

- Any doc or deck that claims "the forecast detects abandonment" or "the band saw the rot
  before the tools did" is now FALSE and must be corrected to "the forecast ranks by
  trajectory; the gate detects." This affects pitch/slide-deck, pitch/track-reframes,
  pitch/q-and-a, and docs/decepticon-integration/02-track-fit, which still carry the
  abandonment framing. Coordinate the rewrite (do not let two CLIs overwrite each other).
- The website hero is already aligned (ademczuk.github.io/modulewarden-website).
- The H100 reference is a mislabel: the compute is Leonardo A100. Plan in
  Hackathons/260528-Supercompute/COMPUTE-AND-MODEL-PLAN.md.
