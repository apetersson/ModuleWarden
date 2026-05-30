import { incidentRows } from './mockData';

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

const tableStyle: React.CSSProperties = {
  width: '100%',
  borderCollapse: 'collapse',
  fontSize: 13,
};

const thStyle: React.CSSProperties = {
  padding: '8px 12px',
  textAlign: 'left',
  borderBottom: '1px solid #334155',
  color: '#94a3b8',
  fontSize: 11,
  textTransform: 'uppercase',
  letterSpacing: 0.5,
};

const tdStyle: React.CSSProperties = {
  padding: '12px',
  borderBottom: '1px solid #1e293b',
  color: '#e2e8f0',
};

function verdictColor(verdict: string) {
  if (verdict === 'BLOCK') return '#ef4444';
  if (verdict === 'QUARANTINE') return '#f59e0b';
  return '#22c55e';
}

/** User-facing forecast-decision labels for the underlying gate verdicts. */
const VERDICT_LABEL: Record<string, string> = {
  BLOCK: 'AVOID',
  QUARANTINE: 'WATCH',
  ALLOW: 'ADOPT',
};

export function IncidentReplays() {
  return (
    <div style={cardStyle}>
      <div style={headerStyle}>Decision history</div>
      <div style={titleStyle}>Live Postgres decision rows</div>
      <table style={tableStyle}>
        <thead>
          <tr>
            <th style={thStyle}>Package</th>
            <th style={thStyle}>Decision</th>
            <th style={thStyle}>MDR</th>
            <th style={thStyle}>Evidence</th>
            <th style={thStyle}>Prompt</th>
          </tr>
        </thead>
        <tbody>
          {incidentRows.map((row) => (
            <tr key={row.decision_id}>
              <td style={tdStyle}>
                <code>{row.package}@{row.version}</code>
              </td>
              <td style={{ ...tdStyle, color: verdictColor(row.verdict), fontWeight: 600 }}>
                {VERDICT_LABEL[row.verdict] ?? row.verdict}
              </td>
              <td style={tdStyle}>{row.mdr_qualifying ? 'Yes' : 'No'}</td>
              <td style={tdStyle}>{row.evidence_ref_count} refs</td>
              <td style={tdStyle}>
                <code style={{ fontSize: 11, color: '#94a3b8' }}>{row.prompt_version}</code>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
