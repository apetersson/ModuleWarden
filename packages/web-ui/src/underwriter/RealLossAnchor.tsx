import { REAL_LOSS_ANCHOR } from './mockData';

const cardStyle: React.CSSProperties = {
  background: '#1e293b',
  border: '1px solid #334155',
  borderRadius: 8,
  padding: 24,
  display: 'flex',
  flexDirection: 'column',
  gap: 16,
};

const headerStyle: React.CSSProperties = {
  fontSize: 13,
  color: '#94a3b8',
  textTransform: 'uppercase',
  letterSpacing: 0.5,
  marginBottom: 4,
};

const titleStyle: React.CSSProperties = {
  fontSize: 20,
  fontWeight: 600,
  color: '#f1f5f9',
};

const lossStrip: React.CSSProperties = {
  background: 'rgba(239, 68, 68, 0.1)',
  border: '1px solid rgba(239, 68, 68, 0.3)',
  borderRadius: 6,
  padding: 20,
};

const lossNumber: React.CSSProperties = {
  fontSize: 36,
  fontWeight: 700,
  color: '#f1f5f9',
  marginBottom: 4,
};

const lossLabel: React.CSSProperties = {
  fontSize: 14,
  color: '#fca5a5',
};

const captionStyle: React.CSSProperties = {
  fontSize: 13,
  color: '#94a3b8',
  lineHeight: 1.5,
};

const linkStyle: React.CSSProperties = {
  background: 'rgba(34, 197, 94, 0.1)',
  border: '1px solid rgba(34, 197, 94, 0.3)',
  borderRadius: 6,
  padding: 12,
  color: '#86efac',
  fontSize: 13,
};

function fmtUsd(amount: number): string {
  if (amount >= 1_000_000_000) return '$' + (amount / 1_000_000_000).toFixed(1) + 'B';
  if (amount >= 1_000_000) return '$' + (amount / 1_000_000).toFixed(0) + 'M';
  return '$' + amount.toString();
}

export function RealLossAnchor() {
  return (
    <div style={cardStyle}>
      <div>
        <div style={headerStyle}>Real loss anchor</div>
        <div style={titleStyle}>{REAL_LOSS_ANCHOR.incident_name}</div>
      </div>
      <div style={lossStrip}>
        <div style={lossNumber}>{fmtUsd(REAL_LOSS_ANCHOR.total_economic_impact_usd)}</div>
        <div style={lossLabel}>Total economic impact, {REAL_LOSS_ANCHOR.year}</div>
      </div>
      <p style={captionStyle}>
        Source: {REAL_LOSS_ANCHOR.citation}. The Change Healthcare 2024 incident is
        the largest documented healthcare supply-chain breach. ModuleWarden's
        source-match rule would have failed on the malicious install path the
        attackers used.
      </p>
      <div style={linkStyle}>
        {REAL_LOSS_ANCHOR.modulewarden_outcome}
      </div>
    </div>
  );
}
