/**
 * Underwriter view shared types.
 *
 * Mock data lives in `mockData.ts` (sourced from `mock/portfolio-250.json`).
 * In a follow-up wiring pass these shapes are returned by
 * `GET /admin/underwriter/portfolio` per the existing checkAdmin pattern.
 */

export interface InsurerRow {
  insurer_id: string;
  name: string;
  sector: 'manufacturing' | 'finance' | 'healthcare' | 'retail' | 'hospitality' | 'services';
  gross_premium_eur: number;
  loss_ratio: number;
  region: string;
  tail_exposure_eur: number;
  /** True if the insurer touched the 2026-class npm compromise scenario. */
  exposed_to_scenario: boolean;
}

export interface IncidentRow {
  decision_id: string;
  package: string;
  version: string;
  verdict: 'ALLOW' | 'BLOCK' | 'QUARANTINE';
  mdr_qualifying: boolean;
  prompt_version: string;
  model_profile: string;
  supersedes_decision_id: string | null;
  evidence_ref_count: number;
  timestamp: string;
}

export interface PricingRow {
  scenario: 'pre_modulewarden' | 'post_modulewarden';
  premium_eur: number;
  expected_loss_eur: number;
  loss_ratio: number;
  control_credit_pct: number;
}

export interface InsiderInstallTrigger {
  trigger_source: 'cursor' | 'copilot' | 'claude_code' | 'codex_cli' | 'gemini' | 'contractor_pr' | 'ci_auto_bump';
  installs_gated_30d: number;
  installs_quarantined_30d: number;
  installs_blocked_30d: number;
}

export interface PortfolioKPIs {
  total_insureds: number;
  total_gwp_eur: number;
  weighted_loss_ratio: number;
  exposed_count: number;
  exposed_pct: number;
}
