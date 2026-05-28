/**
 * Escalation detection service.
 *
 * Determines whether a verdict from the first-pass audit run
 * triggers a model escalation (second-pass with higher capability model).
 */

/**
 * Check if a verdict warrants escalation to a more capable model.
 *
 * @param verdict - The raw verdict string ('allow', 'block', 'quarantine')
 * @param scores - Score map from the audit
 * @param riskSummary - Human-readable risk summary
 * @returns true if escalation is recommended
 */
export function shouldEscalateVerdict(
  verdict: string,
  scores: Record<string, number>,
  riskSummary: string
): boolean {
  // Always escalate quarantines — the escalation pass reduces false positives
  if (verdict === 'quarantine') return true;

  // Escalate blocks with non-definitive language
  if (verdict === 'block' && riskSummary.length > 50) return true;

  // Escalate when risk scores are high
  const riskScore = scores.risk ?? scores.riskScore ?? scores.riskLevel ?? 0;
  if (riskScore > 0.7) return true;

  // Escalate when significant finding counts exist
  const findingCount = scores.findingCount ?? scores.totalFindings ?? 0;
  if (findingCount > 5) return true;

  return false;
}
