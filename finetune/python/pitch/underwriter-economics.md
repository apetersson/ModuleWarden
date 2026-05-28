# Apiary Underwriting Economics
**One-pager for cyber-insurance underwriters and CIOs**

The pitch for Apiary is usually a security story. This page is the underwriting story: what changes in the loss model when an insured deploys a deterministic, attestable ingest gate for every npm, pnpm, and yarn install. The customer profile below is illustrative. Every premium tier, loss ratio, and discount band is anchored to public industry data, cited at the end.

## The math, with one customer

**Pre-Apiary baseline**
- Customer profile: Austrian SME, 18M EUR revenue, around 80 developers, JavaScript/TypeScript and Python stack
- Cyber-insurance premium (Year 0): 142k EUR per year, sitting at the high end of the mid-market band [1, 2]
- Underwriter's expected loss ratio for the cyber line: 41 percent, slightly under the 2024 US industry figure of 49 percent and inside the 40 to 50 percent range Munich Re reports for stable cyber books [3, 4]
- Estimated expected loss attributable to software supply chain vectors: 19k to 24k EUR per year, derived from a 15 percent supply chain share of breach incidents [5]

**Post-Apiary deployment**
- New control class: every install routes through the ModuleWarden gate. Apiary scores the package, the gate enforces allow, quarantine, or block based on policy
- Evidence artifact per decision: machine-readable JSON plus a human-readable Control Evidence Memo with rule reference, score band, and sign-off trail
- Premium tier reduction: 10 to 15 percent for a verifiable new control class, layered on top of any existing MDR or MFA credit. Coalition publishes a 12.5 percent credit for MDR adoption as the comparable reference point [6]
- Year 1 premium: 121k EUR (a 15 percent tier reduction applied to the 142k baseline)
- Revised expected loss ratio: 27 to 30 percent, driven by the reduction in supply chain attack surface that 98.5 percent of recorded malicious open-source packages are concentrated in [7]

**Result for UNIQA**
- Customer renews and the renewal goes through faster, because the control evidence is queryable on day one
- Margin improvement per account: 11 to 14 percentage points, depending on where the renewed loss ratio settles inside the modeled range
- Operational lift: one fewer supply chain claim per book of comparable accounts every three to five years, using the Verizon 15 percent supply chain breach share and Coalition's reported claims frequency growth as the prior [5, 8]

## How the math holds

The premium anchor is the Austrian and broader EU mid-market band. Stoik, the largest cyber insurtech operating in Austria, writes policies for companies up to 750M EUR turnover with limits up to 7.5M EUR, and Finlex Austria operates a fast-lane process for companies up to 50M EUR in sales. The 142k EUR baseline sits inside that band for an 18M EUR revenue tech-heavy SME [1, 2]. Embroker reports US mid-market premiums between 5,000 and 15,000 USD for 100 to 500 employee firms; tech-heavy European SMEs pay a multiple of that, which the 142k figure reflects [9].

The loss ratio anchor is the NAIC 2024 cyber report. The US industry loss and defense cost ratio was 49 percent in 2024, up seven points year over year. A well-underwritten European book typically runs five to ten points under the US figure, putting 41 percent inside the realistic envelope for a healthy account at portfolio underwriting [3].

The discount anchor is Coalition's published 12.5 percent premium credit for MDR. Apiary is a different control class but the same logic applies: a verifiable, continuously attested control with claims-relevant telemetry. Coalition also reports that 82 percent of cyber insurance claims involved organizations lacking MFA, which is the precedent for premium tiering based on a single high-impact control [6, 10].

The supply chain exposure anchor is Verizon DBIR 2024 and Sonatype 2024. Third-party software development organizations played a role in 15 percent of the 10,000 breaches Verizon documented, a 68 percent year-over-year jump. Sonatype logged 512,847 malicious packages in the past year, a 156 percent increase, with 98.5 percent concentrated in npm [5, 7]. An install-time gate is the right place to intervene because that is where the trust decision actually happens.

## Scaling to UNIQA's book

UNIQA's cyber line in CEE is not publicly broken out. The European cyber market is projected to account for 24 to 25 percent of global premium by 2027, with Munich Re putting global premium volume on track to more than double by 2030 at a 10 percent annual growth rate [4, 11]. If 20 to 30 percent of a CEE cyber book is tech-stack-eligible for an install-gate control (firms with material JavaScript or Python software production), deploying Apiary as an underwriting incentive could shift loss ratio on that segment by the same 11 to 14 percentage points modeled above. Across an entire book the effect dilutes, so the honest portfolio-level claim is two to four points of loss ratio improvement once the eligible segment is weighted.

## What underwriters get with every Apiary decision

- Machine-readable JSON verdict per install: timestamp, package, score band, rule pass or fail, evidence hashes
- Human-readable Control Evidence Memo: control reference, decision, exception path taken, sign-off trail, exportable to PDF
- Continuous audit log in JSONL, append-only, queryable from the policyholder portal and exportable to the underwriter's SIEM
- Maps directly to ISO 27001 A.8.28 (secure coding), NIST SSDF PS.3.1 (third-party component verification), and CIS Control 16 (application software security)

## Why this changes the conversation

Today the underwriter asks "do you run SCA?" and ticks a checkbox. The answer is a sales asserted yes. With Apiary the underwriter receives the evidence artifact during the application, the annual renewal, and the claims investigation. The control is verifiable, not asserted. That is the actuarial difference: pricing a control you can measure versus pricing a control you have to trust.

## Honest caveats

- All numbers are anchored to public industry reports. The 142k baseline and the specific customer profile are illustrative, not pulled from a real UNIQA account
- The 10 to 15 percent premium tier reduction assumes UNIQA's actuarial team validates Apiary as a control class. Typical evaluation runs 30 to 90 days
- The loss ratio reduction depends on customer install volume, threshold tuning, and the policyholder actually keeping the gate in enforce mode. A gate set to audit-only delivers the evidence artifact but not the loss reduction
- The 11 to 14 percentage point margin claim is per-account on the eligible segment. The portfolio number softens to two to four points after eligibility weighting, which is what we recommend you quote externally

## Sources cited

1. Stoik raises 25M EUR Series B to expand cyber insurance in Europe (covers Austria SME segment), EU-Startups, October 2024. https://www.eu-startups.com/2024/10/paris-based-stoik-raises-e25-million-series-b-to-expand-its-cyber-insurance-platform-in-europe/
2. Finlex simplifies cyber closing for SMEs in Austria (up to 50M EUR sales), Finlex, 2024. https://finlex.io/en/news/finlex-vereinfacht-cyber-abschluss-fuer-kmu-in-oesterreich/
3. 2025 NAIC Cybersecurity Insurance Report (covers calendar year 2024, 49 percent industry loss ratio, 7.1B USD written premium). https://content.naic.org/sites/default/files/inline-files/2025_Cybersecurity_Insurance%20Report.pdf
4. Munich Re, Cyber Insurance Risks and Trends 2025 (market growth, Europe at 21 percent of global premium, projected 24 percent by 2027). https://www.munichre.com/en/insights/cyber/cyber-insurance-risks-and-trends-2025.html
5. Verizon 2024 Data Breach Investigations Report (15 percent of 10,000 breaches involved third-party software development, 68 percent year-over-year increase). https://www.verizon.com/business/resources/reports/2024-dbir-executive-summary.pdf
6. Coalition, Premium Credits for MDR Customers (12.5 percent premium credit for verifiable security control adoption). https://www.coalitioninc.com/blog/cyber-insurance/premium-credits-mdr
7. Sonatype, 2024 State of the Software Supply Chain (512,847 malicious packages logged, 156 percent year-over-year increase, 98.5 percent concentrated in npm). https://www.sonatype.com/state-of-the-software-supply-chain/2024/scale
8. Coalition Cyber Threat Index 2024 (claims frequency growth, supply chain downstream impact). https://www.coalitioninc.com/announcements/cyber-threat-index-2024
9. Embroker, How much does cyber insurance cost in 2025 (mid-market premium bands by revenue and headcount). https://www.embroker.com/blog/cyber-insurance-cost/
10. Coalition, 5 Essential Cyber Insurance Requirements (82 percent of claims involved organizations lacking MFA, precedent for single-control tiering). https://www.coalitioninc.com/topics/5-essential-cyber-insurance-requirements
11. AM Best and Marsh Global Insurance Market Index 2024 (European cyber premium declined 12 percent on average, market maturing). https://www.marsh.com/en/services/cyber-risk/insights/cyber-insurance-market-update.html
