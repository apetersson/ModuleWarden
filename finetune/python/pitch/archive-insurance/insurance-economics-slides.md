# Insurance Economics Slides

A secondary use case, not the headline track. ModuleWarden's headline pitch is the FORECAST track with Sybilion: probabilistic forecasting and the agent layer that acts on it. This page covers one downstream application of that forecast, cyber-risk pricing. It shows what the agent layer does once the forecast exists. Read it as "here is one thing you can do with a calibrated supply-chain forecast", not "we are the insurance-track entry."

Two-slide insert for the deck. Sits after the architecture slide, ahead of the live demo. Andreas presents both. Total speaker time about 50 seconds. Pulls all numbers from `pitch/underwriter-economics.md`, which carries the citations.

---

## Slide A: The math, one customer

**Speaker note (about 30 seconds):** "Take a real underwriting profile. An 18M EUR Austrian SME, around 80 developers, JavaScript and Python stack. Their cyber premium today sits at 142k a year. The underwriter's expected loss ratio on the account is 41 percent, anchored to NAIC and Munich Re 2024 figures. After ModuleWarden is deployed, every install routes through the gate, and every decision ships with a control evidence memo. Apply Coalition's published control-class credit of 12.5 percent, plus the reduction in supply chain exposure that Verizon and Sonatype both pin at the install layer. Year 1 premium drops to 121k. Loss ratio drops to 27 to 30 percent. The customer renews and the carrier picks up 11 to 14 percentage points of margin on the account."

**Visual layout:**

Two columns. The left is pre-ModuleWarden, the right is post-ModuleWarden, with a wide right-pointing chevron between them.

| Pre-ModuleWarden (left column)              | Post-ModuleWarden (right column)              |
| ------------------------------------- | --------------------------------------- |
| Premium: 142k EUR per year            | Premium: 121k EUR per year              |
| Expected loss ratio: 41 percent       | Expected loss ratio: 27 to 30 percent   |
| Supply chain exposure: uncontrolled   | Supply chain exposure: gated, attested  |
| Evidence on renewal: asserted         | Evidence on renewal: queryable          |

Bottom strip below the chevron:

**Margin uplift: +11 to +14 percentage points per account**

**Bullets (small, under the visual):**
- 142k baseline anchored to Austrian SME band (Stoik, Finlex)
- 41 percent loss ratio anchored to NAIC 2024 cyber report
- 12.5 percent control-class credit anchored to Coalition MDR program
- 15 percent supply chain breach share anchored to Verizon DBIR 2024

**Judges' question this answers:** "Why would an insurer actually pay you?"

---

## Slide B: Why a cyber insurer wins too

**Speaker note (about 20 seconds):** "Three things change for the carrier. The at-risk account renews instead of churning to a cheaper insurer. The margin on the account goes up by 11 to 14 points on the eligible segment, and 2 to 4 points across the full book once you weight for eligibility. And the same control class scales. Every JavaScript-heavy account in the CEE book is addressable with the same memo template, the same evidence schema, and the same actuarial tier. One control class, hundreds of accounts."

**Visual layout:**

Three large bullets, each with an icon and a one-line caption. Stacked vertically, equal weight.

1. **Retention.** Tech-heavy SMEs are the most actively shopped segment in the European cyber market. The control credit is a switching-cost increase.
2. **+11 to +14 pt account margin, +2 to +4 pt book margin.** Per-account math from Slide A. Book math weighted for eligibility.
3. **Scales across the CEE book.** One control class, one evidence schema, one actuarial tier. Reusable from the first account onward.

**Footer (small text):** "All numbers anchored to NAIC, Coalition, Verizon, Sonatype, Munich Re 2024 reports. See `pitch/underwriter-economics.md` for citations."

**Judges' question this answers:** "Is this a product or a feature?"

---

## Insertion point

These two slides sit between Slide 4 (Architecture) and Slide 5 (The model). The deck flow becomes:

1. Slide 1: The problem
2. Slide 2: Why probabilistic, not binary
3. Slide 3: The agent
4. Slide 4: Architecture
5. **Slide A: The math, one customer** (new)
6. **Slide B: Why a cyber insurer wins too** (new)
7. Slide 5: The model (renumber to Slide 7)
8. ... and so on

The intent is to make the underwriting case immediately after the technical architecture lands, so the live demo opens with the actuarial frame already in the judges' heads.
