import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, LabelList } from 'recharts';
import { pricingRows } from './mockData';

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

export function PricingDelta() {
  const data = pricingRows.map((row) => ({
    name: row.scenario === 'pre_modulewarden' ? 'Pre' : 'Post',
    expected_loss_M: row.expected_loss_eur / 1_000_000,
    premium_K: row.premium_eur / 1000,
    fill: row.scenario === 'pre_modulewarden' ? '#ef4444' : '#22c55e',
  }));

  return (
    <div style={cardStyle}>
      <div style={headerStyle}>Pricing delta</div>
      <div style={titleStyle}>Expected loss, before vs after</div>
      <ResponsiveContainer width="100%" height={220}>
        <BarChart data={data} margin={{ top: 16, right: 16, bottom: 8, left: 8 }}>
          <CartesianGrid stroke="#334155" />
          <XAxis dataKey="name" stroke="#94a3b8" tick={{ fontSize: 12 }} />
          <YAxis stroke="#94a3b8" tick={{ fontSize: 11 }} unit="M" />
          <Tooltip
            cursor={{ fill: 'rgba(148, 163, 184, 0.1)' }}
            contentStyle={{ background: '#0f172a', border: '1px solid #334155' }}
            formatter={(value: number) => `EUR ${value.toFixed(2)}M`}
          />
          <Bar dataKey="expected_loss_M" fill="#94a3b8">
            <LabelList
              dataKey="expected_loss_M"
              position="top"
              formatter={(label: number) => `EUR ${label.toFixed(2)}M`}
              style={{ fill: '#f1f5f9', fontSize: 12, fontWeight: 600 }}
            />
          </Bar>
        </BarChart>
      </ResponsiveContainer>
      <p style={captionStyle}>
        Premium drops EUR 142K to EUR 121K. Expected loss drops EUR 9.02M to EUR 7.89M.
        Coalition 12.5 percent MDR control credit applied; loss ratio improves 49 percent to 28.5 percent.
      </p>
    </div>
  );
}
