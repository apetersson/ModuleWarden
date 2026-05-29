# finetune/python/pitch

Hackathon submission materials for ModuleWarden v2. Target: the Zero-One
Hack FORECAST track, partner Sybilion. The pitch frames ModuleWarden as
probabilistic forecasting plus the agent layer that acts on it.

Product one-liner: ModuleWarden forecasts the probability that a dependency
a developer is about to pull into the company codebase is a supply-chain
attack vector, and an agent acts on it at submission time. The thing we
forecast is the version DELTA, not the cold package. The deterministic
delta-gate decides; the model narrates. The threat model is internal: the
lazy submitter and the disgruntled submitter.

## Files

- `track-reframes.md`: per-track framing. Sybilion FORECAST is the primary
  target; UNIQA and Infineon are demoted fallback reframes.
- `underwriter-economics.md`: one-pager for the insurance application (a
  downstream actor acting on the forecast). Anchors every number to NAIC
  2024, Coalition MDR, Verizon DBIR 2024, Sonatype, and Munich Re reports.
  Cited at the bottom.
- `insurance-economics-slides.md`: two-slide insert (Slide A "the math, one
  customer" and Slide B "why the carrier wins too") sized for 50 seconds of
  speaker time. These are the agent-layer application slides.
- `slide-deck.md`: 12-slide ModuleWarden deck. Lead is the forecast: a
  static classifier on the cold package floors at AUROC 0.54 on this corpus,
  so the signal is in the delta and the deterministic gate, not the model,
  holds verdict authority. The insurance economics are positioned as one
  worked downstream application of acting on the forecast.

## How these slot into the hackathon pitch

The deck is the submission artifact. Speaker rotation:

- Slides 1 to 4 and slide 6 (live demo): Andrew presents.
- Slides 5, 7, 8, 9, 10: Andreas presents.
- Slide 12 (the ask): either.
- Slide 11 (eval methodology): held in reserve, only shown if a judge
  asks how the model numbers were generated.

The insurance-economics slides (Slide A and Slide B in
`insurance-economics-slides.md`) appear as slides 6 and 7 in the deck.
Andreas presents both; total speaker time around 50 seconds.

## Citation provenance

All economic claims trace back to public industry reports. See the
"Sources cited" section at the bottom of `underwriter-economics.md` for
the full list with URLs.

The honest caveats section in the same file is load-bearing for the
pitch: the 142k EUR baseline is illustrative (anchored to the Austrian
SME band, not a real carrier account), and the 11 to 14 point per-account
margin uplift softens to 2 to 4 points at the portfolio level after
eligibility weighting. Both numbers are documented as such.

The model-side honesty is also load-bearing and must not be inflated: the
cold-package classifier floors at AUROC 0.54 on this corpus; the fine-tune
lifts verdict-match from 0 to 46.7-to-73.9 percent depending on split;
block-recall on the held-out severe cases is 0 percent, which is exactly why
the deterministic delta-gate, not the model, is the verdict authority. Do
not quote any headline accuracy that was not measured on this corpus.
