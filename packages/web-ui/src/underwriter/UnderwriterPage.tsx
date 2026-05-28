import { PortfolioSummary } from './PortfolioSummary';
import { CorrelatedExposure } from './CorrelatedExposure';
import { IncidentReplays } from './IncidentReplays';
import { PricingDelta } from './PricingDelta';
import { RealLossAnchor } from './RealLossAnchor';
import { InsiderRiskPanel } from './InsiderRiskPanel';

interface UnderwriterPageProps {
  adminToken: string;
}

const pageStyle: React.CSSProperties = {
  padding: 32,
  maxWidth: 1400,
  margin: '0 auto',
  display: 'flex',
  flexDirection: 'column',
  gap: 24,
};

const headerStyle: React.CSSProperties = {
  marginBottom: 16,
};

const titleStyle: React.CSSProperties = {
  fontSize: 32,
  fontWeight: 700,
  color: '#f1f5f9',
  marginBottom: 8,
};

const subtitleStyle: React.CSSProperties = {
  fontSize: 16,
  color: '#94a3b8',
  maxWidth: 800,
};

const gridStyle: React.CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'repeat(auto-fit, minmax(420px, 1fr))',
  gap: 24,
};

const tagline: React.CSSProperties = {
  background: 'rgba(16, 185, 129, 0.1)',
  border: '1px solid rgba(16, 185, 129, 0.3)',
  borderRadius: 8,
  padding: 24,
  marginTop: 8,
};

const taglineMono: React.CSSProperties = {
  fontFamily: 'ui-monospace, "Cascadia Code", Menlo, monospace',
  fontSize: 18,
  color: '#34d399',
  marginBottom: 4,
};

const taglineHint: React.CSSProperties = {
  fontSize: 13,
  color: '#94a3b8',
};

/**
 * UnderwriterPage is the UNIQA-track pitch surface.
 *
 * Five required panels per Grok's spec (constants in mockData.ts):
 *   1. Portfolio summary  (250 insureds, EUR 18.4M GWP, 49% loss ratio)
 *   2. Correlated exposure (41% of portfolio touched by 2026-class npm compromise)
 *   3. Incident replays    (Postgres decision rows: 3 incidents + MDR flag)
 *   4. Pricing delta       (EUR 9.02M -> EUR 7.89M, Coalition 12.5% MDR credit)
 *   5. Real loss anchor    (Change Healthcare 2024 USD 2.3B, IBM citation)
 *
 * Plus one new panel per the insider-AI-assisted-threat angle:
 *   6. Insider risk panel  (LLM-suggested installs blocked in last 30 days)
 *
 * No new API endpoint required for the hackathon pitch; all panels read
 * from `mockData.ts` (which imports `mock/portfolio-250.json`). Wiring
 * to the live Postgres decisions table is a 30-minute follow-up via
 * GET /admin/underwriter/portfolio.
 */
export function UnderwriterPage(_props: UnderwriterPageProps) {
  return (
    <div style={pageStyle}>
      <header style={headerStyle}>
        <h1 style={titleStyle}>Underwriter view</h1>
        <p style={subtitleStyle}>
          What a UNIQA cyber product team sees when ModuleWarden is wired
          into a policyholder cohort. Five panels plus an insider-AI-assisted
          threat surface that addresses the human-element vector responsible
          for 74 percent of breaches per Verizon DBIR 2024.
        </p>
      </header>

      <div style={gridStyle}>
        <PortfolioSummary />
        <CorrelatedExposure />
        <IncidentReplays />
        <PricingDelta />
        <RealLossAnchor />
        <InsiderRiskPanel />
      </div>

      <div style={tagline}>
        <p style={taglineMono}>
          This is not a security tool. This is an underwriting control.
        </p>
        <p style={taglineHint}>
          ModuleWarden is the twelfth section of UNIQA's underwriting
          questionnaire. Architecture: deterministic 5-rule gate + MW
          fine-tuned 27B model in per-job Docker container + DeepSeek V3
          second opinion on QUARANTINE-band decisions.
        </p>
      </div>
    </div>
  );
}
