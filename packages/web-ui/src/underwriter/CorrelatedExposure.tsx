import { ScatterChart, Scatter, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, ZAxis } from 'recharts';
import { portfolio, computePortfolioKPIs } from './mockData';

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
  marginBottom: 16,
};

const captionStyle: React.CSSProperties = {
  fontSize: 13,
  color: '#94a3b8',
  marginTop: 12,
};

export function CorrelatedExposure() {
  const kpis = computePortfolioKPIs();

  const exposedPoints = portfolio
    .filter((r) => r.exposed_to_scenario)
    .map((r) => ({
      x: r.gross_premium_eur / 1000,
      y: r.tail_exposure_eur / 1000,
      z: 100,
      name: r.name,
    }));
  const safePoints = portfolio
    .filter((r) => !r.exposed_to_scenario)
    .map((r) => ({
      x: r.gross_premium_eur / 1000,
      y: r.tail_exposure_eur / 1000,
      z: 60,
      name: r.name,
    }));

  return (
    <div style={cardStyle}>
      <div style={headerStyle}>Correlated exposure</div>
      <div style={titleStyle}>2026-class npm compromise scenario</div>
      <ResponsiveContainer width="100%" height={240}>
        <ScatterChart margin={{ top: 8, right: 16, bottom: 8, left: 8 }}>
          <CartesianGrid stroke="#334155" />
          <XAxis
            type="number"
            dataKey="x"
            name="GWP"
            unit="K"
            stroke="#94a3b8"
            tick={{ fontSize: 11 }}
          />
          <YAxis
            type="number"
            dataKey="y"
            name="Tail"
            unit="K"
            stroke="#94a3b8"
            tick={{ fontSize: 11 }}
          />
          <ZAxis type="number" dataKey="z" range={[40, 140]} />
          <Tooltip
            cursor={{ strokeDasharray: '3 3' }}
            contentStyle={{ background: '#0f172a', border: '1px solid #334155' }}
          />
          <Scatter name="Exposed" data={exposedPoints} fill="#ef4444" />
          <Scatter name="Safe" data={safePoints} fill="#22c55e" />
        </ScatterChart>
      </ResponsiveContainer>
      <p style={captionStyle}>
        {kpis.exposed_count} of {kpis.total_insureds} insureds ({(kpis.exposed_pct * 100).toFixed(0)}%) touched
        via 98.5 percent npm concentration (Sonatype 2024) x 15 percent supply-chain breach share (Verizon DBIR 2024).
      </p>
    </div>
  );
}
