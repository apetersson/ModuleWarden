/**
 * Risk portfolio view shared types.
 *
 * Mock data lives in `mockData.ts` (sourced from `mock/portfolio-250.json`).
 * In a follow-up wiring pass these shapes are returned by
 * `GET /admin/risk-portfolio/portfolio` per the existing checkAdmin pattern.
 */

export interface OrganizationRow {
  org_id: string;
  name: string;
  sector: 'manufacturing' | 'finance' | 'healthcare' | 'retail' | 'hospitality' | 'services';
  annual_contract_value_eur: number;
  /** Forecast supply-chain risk, 0 (clean) to 1 (high). */
  risk_score: number;
  region: string;
  potential_breach_cost_eur: number;
  /** True if the org was touched by the 2026-class npm compromise scenario. */
  touched_by_scenario: boolean;
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

export interface RiskDeltaRow {
  scenario: 'pre_modulewarden' | 'post_modulewarden';
  expected_loss_eur: number;
  risk_score: number;
}

export interface InsiderInstallTrigger {
  trigger_source: 'cursor' | 'copilot' | 'claude_code' | 'codex_cli' | 'gemini' | 'contractor_pr' | 'ci_auto_bump';
  installs_gated_30d: number;
  installs_quarantined_30d: number;
  installs_blocked_30d: number;
}

export interface PortfolioKPIs {
  total_orgs: number;
  total_potential_breach_cost_eur: number;
  weighted_risk_score: number;
  touched_count: number;
  touched_pct: number;
}
