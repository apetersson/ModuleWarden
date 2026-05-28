import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend } from 'recharts';
import { insiderTriggers } from './mockData';

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
  lineHeight: 1.5,
};

const SOURCE_LABEL: Record<string, string> = {
  cursor: 'Cursor',
  copilot: 'Copilot',
  claude_code: 'Claude Code',
  codex_cli: 'Codex CLI',
  gemini: 'Gemini',
  contractor_pr: 'Contractor PR',
  ci_auto_bump: 'CI auto-bump',
};

export function InsiderRiskPanel() {
  const totalGated = insiderTriggers.reduce((acc, t) => acc + t.installs_gated_30d, 0);
  const totalQuarantined = insiderTriggers.reduce((acc, t) => acc + t.installs_quarantined_30d, 0);
  const totalBlocked = insiderTriggers.reduce((acc, t) => acc + t.installs_blocked_30d, 0);

  const chartData = insiderTriggers.map((t) => ({
    name: SOURCE_LABEL[t.trigger_source] ?? t.trigger_source,
    Allowed: t.installs_gated_30d - t.installs_quarantined_30d - t.installs_blocked_30d,
    Quarantined: t.installs_quarantined_30d,
    Blocked: t.installs_blocked_30d,
  }));

  return (
    <div style={cardStyle}>
      <div style={headerStyle}>Insider AI-assisted threat surface</div>
      <div style={titleStyle}>LLM-suggested installs in last 30 days</div>
      <ResponsiveContainer width="100%" height={220}>
        <BarChart data={chartData} margin={{ top: 8, right: 16, bottom: 8, left: 8 }}>
          <CartesianGrid stroke="#334155" />
          <XAxis dataKey="name" stroke="#94a3b8" tick={{ fontSize: 11 }} angle={-15} textAnchor="end" height={50} />
          <YAxis stroke="#94a3b8" tick={{ fontSize: 11 }} />
          <Tooltip
            cursor={{ fill: 'rgba(148, 163, 184, 0.1)' }}
            contentStyle={{ background: '#0f172a', border: '1px solid #334155' }}
          />
          <Legend wrapperStyle={{ fontSize: 12 }} />
          <Bar dataKey="Allowed" stackId="a" fill="#22c55e" />
          <Bar dataKey="Quarantined" stackId="a" fill="#f59e0b" />
          <Bar dataKey="Blocked" stackId="a" fill="#ef4444" />
        </BarChart>
      </ResponsiveContainer>
      <p style={captionStyle}>
        {totalGated} installs gated, {totalQuarantined} quarantined, {totalBlocked} blocked
        across IDE telemetry, contractor PRs, and CI auto-bumps. Verizon DBIR 2024 puts
        74 percent of breaches on the human element. AI-assisted coding amplifies the vector.
        Per-source telemetry captured via the audit_dossier.v1 trigger_context field.
      </p>
    </div>
  );
}
