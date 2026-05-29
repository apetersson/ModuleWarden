/**
 * Escalation detection service.
 *
 * Determines whether a verdict from the first-pass audit run
 * triggers a model escalation (second-pass with higher capability model).
 *
 * L-5: Uses structured signals instead of string-length heuristics.
 * Escalation is triggered by:
 *  - High risk scores (> 0.7)
 *  - Quarantine verdicts (high uncertainty)
 *  - Many findings (> 5)
 *  - Hedging language in the risk summary ("may", "might", "appears", "could")
 *  - Low confidence scores (< 0.3)
 */

// Hedging/uncertainty indicators that warrant a second-pass review
const HEDGING_PATTERNS = [
  /\bmay\b/i, /\bmight\b/i, /\bcould\b/i, /\bpossibly\b/i,
  /\bappears?\b/i, /\bseems?\b/i, /\bsuggests?\b/i,
  /\bunclear\b/i, /\bambiguous\b/i, /\binsufficient\b/i,
  /\bnot\s+definitive\b/i, /\bneeds?\s+further\s+review\b/i,
  /\bcannot\s+determine\b/i, /\bcould\s+not\s+verify\b/i,
];

/**
 * Check if a verdict warrants escalation to a more capable model.
 *
 * @param verdict - The verdict string ('ALLOW', 'BLOCK', or 'QUARANTINE')
 * @param scores - Score map from the audit (expects risk/confidence fields)
 * @param riskSummary - Human-readable risk summary
 * @returns true if escalation is recommended
 */
export function shouldEscalateVerdict(
  verdict: string,
  scores: Record<string, number>,
  riskSummary: string
): boolean {
  // Normalize to uppercase for case-insensitive comparison
  const normalized = verdict.toUpperCase();

  // Always escalate quarantines — the escalation pass reduces false positives
  if (normalized === 'QUARANTINE') return true;

  // Escalate when risk scores are high
  const riskScore = scores.risk ?? scores.riskScore ?? scores.riskLevel ?? 0;
  if (riskScore > 0.7) return true;

  // Escalate when significant finding counts exist
  const findingCount = scores.findingCount ?? scores.totalFindings ?? 0;
  if (findingCount > 5) return true;

  // Escalate blocks where the risk summary contains hedging/uncertainty language
  // (indicating the first-pass model lacked sufficient evidence for a confident block)
  if (normalized === 'BLOCK') {
    const hasHedging = HEDGING_PATTERNS.some((p) => p.test(riskSummary));
    if (hasHedging) return true;
  }

  // Escalate when confidence score is low
  const confidenceScore = scores.confidence ?? scores.confidenceScore ?? 0;
  if (confidenceScore > 0 && confidenceScore < 0.3) return true;

  return false;
}
