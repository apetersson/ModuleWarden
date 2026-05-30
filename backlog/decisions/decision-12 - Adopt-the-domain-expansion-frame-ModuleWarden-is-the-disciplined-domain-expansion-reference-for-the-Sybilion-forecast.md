---
id: decision-12
title: >-
  Adopt the domain-expansion frame: ModuleWarden is the
  disciplined-domain-expansion reference for the Sybilion forecast
date: '2026-05-30 06:47'
status: accepted
---
## Context

decision-10 took us to the Sybilion FORECAST track; decision-11 pivoted the forecast role
to trajectory-prioritization after a backtest disproved abandonment-detection. On
2026-05-30 we reviewed Sybilion's own pitch: deck slide 05 "The domain is yours", an
18-domain grid, "+ what we haven't thought of / your idea here", and the presenter saying
"half our company is sales, we are still finding our ICP, it is still moving, go nuts".
Their judging criterion is "honest about uncertainty?" and their stated philosophy is
"false certainty is worse than honest uncertainty". Sources: Hackathons/
sybillion-hackathon-notes.md, the deck at 260528-Supercompute/sybilion_deck.md, and the
distilled pitch-video summary.

The observation: Sybilion is actively growing into new forecast domains. Their engine
keyword-matches drivers from a 3B-time-series lake and returns a confident band, named
drivers, and an in-sample backtest. In commodity and macro domains the drivers are causal
(naphtha drives propylene). In a brand-new domain with thin history, a 3B-series lake will
surface some correlated drivers and a confident band even when the relationship is
spurious. That is the false certainty their own value warns against. Their domain-growth
strategy is in tension with the honesty that makes a forecast defensible.

## Decision

Adopt the domain-expansion frame as ModuleWarden's positioning for the Sybilion track.
ModuleWarden is not a security vertical; it is the disciplined-domain-expansion reference,
the pattern for taking the forecast into a new domain without breaking its honesty.

1. The pattern, four steps: transfer-test whether the forecast carries to the new domain;
   keep what it genuinely earns (here, blast-radius trajectory ranking); gate what it does
   not (the deterministic delta-gate owns the verdict where the forecast has no signal);
   concede the negative result with the data (AUROC 0.54 cold, band and slope do not
   separate dying from healthy packages).
2. Tone discipline: adopt their operating system, do not critique their engine. Concede
   their calibration (the band widens with sparsity, the lake is more than raw
   correlation). The claim is not "your forecast is wrong", it is "a new domain needs a
   transfer test, and the most sophisticated use of your bands and backtest is to gate the
   forecast's role, not just read the number".
3. This subsumes decision-11: forecast prioritizes (trajectory ranking), gate detects
   (verdict authority), honesty pillar (the conceded negative result). The domain-expansion
   frame is the meta-layer that explains why that division of labor is the right answer for
   any new Sybilion domain, not only ours.
4. Land it across surfaces: the v3.1 ASK and Q&A in PITCH-2MIN.md, a README direction note,
   and a website beat. The stage one-liner: "We did not just pick a new domain. We
   stress-tested your honesty principle against it, proved where the signal stops, and
   built the guardrail so your expansion never lies to you".

## Consequences

- The pitch leads with a meta-frame that scores all three Sybilion pillars at once: impact
  (security), originality (a methodology, not a sector), and technical sophistication
  (gating the forecast by its measured transfer). It speaks directly to their strategic
  anxiety: they are crowdsourcing domains and do not yet know which ones the forecast works
  in.
- The honesty pillar (decision-11) becomes the headline strength, not a caveat. The
  conceded AUROC 0.54 and the backtest are the evidence that we ran the transfer test most
  teams skip.
- Risk to manage: the frame must stay flattering, not accusatory. The Q&A in PITCH-2MIN.md
  handles the calibration counter. Red-teamed via the local Decepticon brain on 2026-05-30,
  verdict fair, not overreach.
- No code change. This is positioning and documentation alignment on top of the shipped
  gate, the published 27B auditor, and the trajectory-ranking forecast.
