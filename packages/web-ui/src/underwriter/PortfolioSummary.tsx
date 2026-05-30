import { computePortfolioKPIs } from './mockData';

const cardStyle: React.CSSProperties = {
  background: '#1e293b',
  border: '1px solid #334155',
  borderRadius: 8,
  padding: 24,
};

const headerStyle: React.CSSProperties = {
  fontSize: 13,
  color: '#94a3b8',
  textTransform: 'uppercase',
  letterSpacing: 0.5,
  marginBottom: 8,
};

const titleStyle: React.CSSProperties = {
  fontSize: 20,
  fontWeight: 600,
  color: '#f1f5f9',
  marginBottom: 24,
};

const kpiGrid: React.CSSProperties = {
  display: 'grid',
  gridTemplateColumns: '1fr 1fr',
  gap: 24,
};

const metricLabel: React.CSSProperties = {
  fontSize: 11,
  color: '#94a3b8',
  textTransform: 'uppercase',
  letterSpacing: 0.5,
  marginBottom: 4,
};

const metricValue: React.CSSProperties = {
  fontSize: 28,
  fontWeight: 600,
  color: '#f1f5f9',
};

const metricUnit: React.CSSProperties = {
  fontSize: 14,
  color: '#94a3b8',
  marginLeft: 4,
};

function fmtEur(amount: number): string {
  if (amount >= 1_000_000) return (amount / 1_000_000).toFixed(1) + 'M';
  if (amount >= 1_000) return (amount / 1_000).toFixed(0) + 'K';
  return amount.toString();
}

export function PortfolioSummary() {
  const kpis = computePortfolioKPIs();
  return (
    <div style={cardStyle}>
      <div style={headerStyle}>Portfolio summary</div>
      <div style={titleStyle}>Austrian SME tech-heavy portfolio</div>
      <div style={kpiGrid}>
        <div>
          <div style={metricLabel}>Monitored orgs</div>
          <div style={metricValue}>{kpis.total_orgs}</div>
        </div>
        <div>
          <div style={metricLabel}>Portfolio at risk</div>
          <div style={metricValue}>
            EUR {fmtEur(kpis.total_potential_breach_cost_eur)}
            <span style={metricUnit}>downside</span>
          </div>
        </div>
        <div>
          <div style={metricLabel}>Weighted risk score</div>
          <div style={metricValue}>{(kpis.weighted_risk_score * 100).toFixed(1)}%</div>
        </div>
        <div>
          <div style={metricLabel}>Touched by scenario</div>
          <div style={metricValue}>
            {kpis.touched_count}
            <span style={metricUnit}>({(kpis.touched_pct * 100).toFixed(0)}%)</span>
          </div>
        </div>
      </div>
    </div>
  );
}
