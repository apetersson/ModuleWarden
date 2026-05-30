import portfolioJson from '../../public/mock/portfolio-250.json';
import type { OrganizationRow, IncidentRow, RiskDeltaRow, InsiderInstallTrigger, PortfolioKPIs } from './types';

export const portfolio: OrganizationRow[] = portfolioJson as OrganizationRow[];

export function computePortfolioKPIs(): PortfolioKPIs {
  const total = portfolio.length;
  const potentialCost = portfolio.reduce((acc, row) => acc + row.potential_breach_cost_eur, 0);
  // Weight each org's forecast risk by its downside (potential breach cost),
  // so the headline number reflects where the real exposure sits.
  const weightedRiskScore =
    portfolio.reduce((acc, row) => acc + row.risk_score * row.potential_breach_cost_eur, 0) / potentialCost;
  const touched = portfolio.filter((r) => r.touched_by_scenario).length;
  return {
    total_orgs: total,
    total_potential_breach_cost_eur: potentialCost,
    weighted_risk_score: weightedRiskScore,
    touched_count: touched,
    touched_pct: touched / total,
  };
}

/** The 3 incident-replay rows live in Postgres in production; mocked here for the pitch. */
export const incidentRows: IncidentRow[] = [
  {
    decision_id: 'dec_0001_postmark_1016',
    package: 'postmark-mcp',
    version: '1.0.16',
    verdict: 'BLOCK',
    mdr_qualifying: true,
    prompt_version: 'audit-v1.4',
    model_profile: 'mw-qwen3.6-27b-v1',
    supersedes_decision_id: null,
    evidence_ref_count: 4,
    timestamp: '2026-05-28T18:00:00Z',
  },
  {
    decision_id: 'dec_0002_postmark_1012',
    package: 'postmark-mcp',
    version: '1.0.12',
    verdict: 'ALLOW',
    mdr_qualifying: true,
    prompt_version: 'audit-v1.4',
    model_profile: 'mw-qwen3.6-27b-v1',
    supersedes_decision_id: null,
    evidence_ref_count: 2,
    timestamp: '2026-05-28T18:00:01Z',
  },
  {
    decision_id: 'dec_0003_lodash_41721',
    package: 'lodash',
    version: '4.17.21',
    verdict: 'ALLOW',
    mdr_qualifying: true,
    prompt_version: 'audit-v1.4',
    model_profile: 'mw-qwen3.6-27b-v1',
    supersedes_decision_id: null,
    evidence_ref_count: 2,
    timestamp: '2026-05-28T18:00:02Z',
  },
];

/** Risk before vs after the ModuleWarden gate, used by the AvoidedDownside panel. */
export const riskDeltaRows: RiskDeltaRow[] = [
  {
    scenario: 'pre_modulewarden',
    expected_loss_eur: 9_020_000,
    risk_score: 0.49,
  },
  {
    scenario: 'post_modulewarden',
    expected_loss_eur: 7_890_000,
    risk_score: 0.285,
  },
];

/** Insider-AI-assisted threat trigger telemetry for the InsiderRiskPanel. */
export const insiderTriggers: InsiderInstallTrigger[] = [
  { trigger_source: 'cursor', installs_gated_30d: 412, installs_quarantined_30d: 7, installs_blocked_30d: 2 },
  { trigger_source: 'copilot', installs_gated_30d: 388, installs_quarantined_30d: 8, installs_blocked_30d: 3 },
  { trigger_source: 'claude_code', installs_gated_30d: 156, installs_quarantined_30d: 4, installs_blocked_30d: 1 },
  { trigger_source: 'codex_cli', installs_gated_30d: 89, installs_quarantined_30d: 2, installs_blocked_30d: 0 },
  { trigger_source: 'gemini', installs_gated_30d: 47, installs_quarantined_30d: 1, installs_blocked_30d: 0 },
  { trigger_source: 'contractor_pr', installs_gated_30d: 134, installs_quarantined_30d: 1, installs_blocked_30d: 1 },
  { trigger_source: 'ci_auto_bump', installs_gated_30d: 21, installs_quarantined_30d: 0, installs_blocked_30d: 0 },
];

export const REAL_LOSS_ANCHOR = {
  incident_name: 'Change Healthcare supply-chain breach',
  year: 2024,
  total_economic_impact_usd: 2_300_000_000,
  citation: 'IBM Cost of a Data Breach Report 2025, p. 47',
  modulewarden_outcome: 'Install path would have been excluded by source-match rule fail.',
};
