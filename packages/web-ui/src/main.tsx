import React, { useState, useEffect, useCallback } from 'react';
import { createRoot } from 'react-dom/client';

const API_BASE = '/api';
const REFRESH_INTERVAL = 15_000;

// ── Types ─────────────────────────────────────────────────

interface AuditRunCard {
  id: string;
  packageName: string;
  packageVersion: string;
  tarballHash: string;
  triggerSource: string;
  jobState: string;
  column: string;
  riskSummary: string | null;
  ageSeconds: number;
  retryCount: number;
  needsAttention: boolean;
  verdict: string | null;
}

interface DashboardData {
  columns: Record<string, AuditRunCard[]>;
  summary: {
    total: number;
    queued: number;
    running: number;
    blocked: number;
    quarantined: number;
    allowed: number;
    failed: number;
    needsAttention: number;
  };
  refreshedAt: string;
}

interface QueueStat {
  queue: string;
  pending: number;
  running: number;
  completed: number;
  failed: number;
  deadLettered: number;
}

// ── Helpers ───────────────────────────────────────────────

function statusColor(verdict?: string | null): string {
  switch (verdict) {
    case 'ALLOW': return '#2e7d32';
    case 'BLOCK': return '#c62828';
    case 'QUARANTINE': return '#f57f17';
    default: return '#757575';
  }
}

function columnColor(col: string): string {
  switch (col) {
    case 'queued': return '#1565c0';
    case 'running': return '#6a1b9a';
    case 'needs-escalation': return '#e65100';
    case 'quarantined': return '#f57f17';
    case 'blocked': return '#c62828';
    case 'allowed': return '#2e7d32';
    case 'failed': return '#b71c1c';
    default: return '#546e7a';
  }
}

function timeAgo(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const min = Math.floor(seconds / 60);
  if (min < 60) return `${min}m`;
  const hr = Math.floor(min / 60);
  return `${hr}h`;
}

function triggerIcon(src: string): string {
  switch (src) {
    case 'preflight': return '📥';
    case 'subscription': return '🔄';
    case 're-audit': return '🔁';
    case 'admin': return '👤';
    default: return '❓';
  }
}

// ── Dashboard Page ────────────────────────────────────────

function DashboardPage() {
  const [dashboard, setDashboard] = useState<DashboardData | null>(null);
  const [queueStats, setQueueStats] = useState<QueueStat[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [activeColumn, setActiveColumn] = useState<string | null>(null);

  const fetchDashboard = useCallback(async () => {
    try {
      const [dashResp, queueResp] = await Promise.all([
        fetch(`${API_BASE}/admin/dashboard`),
        fetch(`${API_BASE}/admin/queue-stats`),
      ]);
      if (dashResp.ok) {
        setDashboard(await dashResp.json() as DashboardData);
      } else {
        setError(`Dashboard API: ${dashResp.status}`);
      }
      if (queueResp.ok) {
        setQueueStats(await queueResp.json() as QueueStat[]);
      }
    } catch (err) {
      setError(`API unavailable: ${err instanceof Error ? err.message : String(err)}`);
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    fetchDashboard();
    const interval = setInterval(fetchDashboard, REFRESH_INTERVAL);
    return () => clearInterval(interval);
  }, [fetchDashboard]);

  const columnOrder = ['queued', 'running', 'needs-escalation', 'quarantined', 'blocked', 'allowed', 'failed'];

  // ── Error state ────────────────────────────────────────

  if (error && !dashboard) {
    return (
      <div>
        <h2>Dashboard</h2>
        <div style={{ padding: '2rem', textAlign: 'center', color: '#c62828' }}>
          <p style={{ fontSize: '1.2rem' }}>⚠️ API Unavailable</p>
          <p>{error}</p>
          <p style={{ color: '#666', marginTop: '1rem' }}>
            Ensure the ModuleWarden API server is running and accessible at <code>{API_BASE}</code>.
          </p>
        </div>
      </div>
    );
  }

  // ── Loading state ──────────────────────────────────────

  if (loading) {
    return (
      <div>
        <h2>Dashboard</h2>
        <p style={{ color: '#666' }}>Loading audit data...</p>
      </div>
    );
  }

  // ── Empty state ────────────────────────────────────────

  if (dashboard && dashboard.summary.total === 0) {
    return (
      <div>
        <h2>Dashboard</h2>
        <div style={{ padding: '2rem', textAlign: 'center', color: '#666' }}>
          <p style={{ fontSize: '1.2rem' }}>No audit data yet</p>
          <p>Import a lockfile or request a package review to get started.</p>
          <p style={{ marginTop: '1rem' }}>
            <code>modulewarden preflight pnpm-lock.yaml</code>
          </p>
        </div>
      </div>
    );
  }

  // ── Kanban board ───────────────────────────────────────

  const selectedCards = activeColumn && dashboard
    ? dashboard.columns[activeColumn] ?? []
    : null;

  return (
    <div>
      <div style={{ display: 'flex', gap: '1rem', alignItems: 'center', marginBottom: '1rem' }}>
        <h2 style={{ margin: 0 }}>Audit Dashboard</h2>
        <span style={{ color: '#666', fontSize: '0.9rem' }}>
          {dashboard?.summary.total ?? 0} runs
          {dashboard && <span> · {dashboard.summary.needsAttention} need attention</span>}
        </span>
        <button
          onClick={() => { setLoading(true); fetchDashboard(); }}
          style={{ marginLeft: 'auto', padding: '0.3rem 0.8rem', cursor: 'pointer' }}
        >
          Refresh
        </button>
      </div>

      {error && (
        <div style={{ padding: '0.5rem', background: '#fff3e0', borderRadius: 4, marginBottom: '1rem', color: '#e65100', fontSize: '0.9rem' }}>
          ⚠ {error}
        </div>
      )}

      <div style={{ display: 'flex', gap: '0.75rem', overflowX: 'auto', paddingBottom: '0.5rem' }}>
        {columnOrder.map((col) => {
          const cards = dashboard?.columns[col];
          const count = cards?.length ?? 0;
          return (
            <div
              key={col}
              onClick={() => setActiveColumn(activeColumn === col ? null : col)}
              style={{
                minWidth: 180,
                flex: '0 0 auto',
                padding: '0.75rem',
                borderRadius: 8,
                background: activeColumn === col ? '#e3f2fd' : '#f5f5f5',
                cursor: 'pointer',
                borderTop: `3px solid ${columnColor(col)}`,
              }}
            >
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <span style={{ fontWeight: 600, fontSize: '0.9rem', textTransform: 'capitalize' }}>
                  {col.replace(/-/g, ' ')}
                </span>
                <span style={{
                  background: columnColor(col),
                  color: '#fff',
                  borderRadius: 12,
                  padding: '1px 8px',
                  fontSize: '0.85rem',
                  fontWeight: 600,
                }}>
                  {count}
                </span>
              </div>
              {cards && cards.slice(0, 5).map((card) => (
                <div key={card.id} style={{
                  marginTop: '0.5rem',
                  padding: '0.5rem',
                  background: '#fff',
                  borderRadius: 4,
                  fontSize: '0.85rem',
                  borderLeft: `3px solid ${statusColor(card.verdict)}`,
                  boxShadow: '0 1px 3px rgba(0,0,0,0.1)',
                }}>
                  <div style={{ fontWeight: 600, fontSize: '0.8rem', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {triggerIcon(card.triggerSource)} {card.packageName}@{card.packageVersion}
                  </div>
                  <div style={{ display: 'flex', gap: '0.3rem', marginTop: '0.2rem' }}>
                    <span style={{ fontSize: '0.75rem', color: '#666' }}>{timeAgo(card.ageSeconds)}</span>
                    {card.retryCount > 0 && <span style={{ fontSize: '0.75rem', color: '#c62828' }}>↻{card.retryCount}</span>}
                    {card.needsAttention && <span style={{ fontSize: '0.75rem', color: '#e65100' }}>⚠</span>}
                  </div>
                  {card.riskSummary && (
                    <div style={{ fontSize: '0.75rem', color: '#555', marginTop: '0.2rem', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {card.riskSummary.slice(0, 60)}
                    </div>
                  )}
                </div>
              ))}
              {count > 5 && (
                <div style={{ textAlign: 'center', fontSize: '0.8rem', color: '#666', marginTop: '0.3rem' }}>
                  +{count - 5} more
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* Selected column detail */}
      {activeColumn && selectedCards && (
        <div style={{ marginTop: '1rem' }}>
          <h3 style={{ textTransform: 'capitalize' }}>{activeColumn.replace(/-/g, ' ')} ({selectedCards.length})</h3>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.85rem' }}>
            <thead>
              <tr style={{ borderBottom: '2px solid #ddd' }}>
                <th style={{ padding: '0.4rem', textAlign: 'left' }}>Package</th>
                <th style={{ padding: '0.4rem', textAlign: 'left' }}>Version</th>
                <th style={{ padding: '0.4rem', textAlign: 'left' }}>Source</th>
                <th style={{ padding: '0.4rem', textAlign: 'left' }}>Age</th>
                <th style={{ padding: '0.4rem', textAlign: 'left' }}>Verdict</th>
                <th style={{ padding: '0.4rem', textAlign: 'left' }}>Summary</th>
              </tr>
            </thead>
            <tbody>
              {selectedCards.map((card) => (
                <tr key={card.id} style={{ borderBottom: '1px solid #eee' }}>
                  <td style={{ padding: '0.4rem', fontFamily: 'monospace' }}>{card.packageName}</td>
                  <td style={{ padding: '0.4rem' }}>{card.packageVersion}</td>
                  <td style={{ padding: '0.4rem' }}>{triggerIcon(card.triggerSource)} {card.triggerSource}</td>
                  <td style={{ padding: '0.4rem', color: '#666' }}>{timeAgo(card.ageSeconds)}</td>
                  <td style={{ padding: '0.4rem' }}>
                    {card.verdict ? (
                      <span style={{ color: '#fff', background: statusColor(card.verdict), padding: '1px 6px', borderRadius: 10, fontSize: '0.8rem', fontWeight: 600 }}>
                        {card.verdict}
                      </span>
                    ) : (
                      <span style={{ color: '#999' }}>—</span>
                    )}
                  </td>
                  <td style={{ padding: '0.4rem', color: '#666', maxWidth: 300, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {card.riskSummary ?? ''}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Queue stats */}
      {queueStats.length > 0 && (
        <div style={{ marginTop: '2rem' }}>
          <h3>Queue Status</h3>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.85rem' }}>
            <thead>
              <tr style={{ borderBottom: '2px solid #ddd' }}>
                <th style={{ padding: '0.4rem', textAlign: 'left' }}>Queue</th>
                <th style={{ padding: '0.4rem', textAlign: 'right' }}>Pending</th>
                <th style={{ padding: '0.4rem', textAlign: 'right' }}>Running</th>
                <th style={{ padding: '0.4rem', textAlign: 'right' }}>Completed</th>
                <th style={{ padding: '0.4rem', textAlign: 'right' }}>Failed</th>
                <th style={{ padding: '0.4rem', textAlign: 'right' }}>Dead</th>
              </tr>
            </thead>
            <tbody>
              {queueStats.map((q) => (
                <tr key={q.queue} style={{ borderBottom: '1px solid #eee' }}>
                  <td style={{ padding: '0.4rem', fontFamily: 'monospace', fontSize: '0.8rem' }}>{q.queue}</td>
                  <td style={{ padding: '0.4rem', textAlign: 'right' }}>{q.pending}</td>
                  <td style={{ padding: '0.4rem', textAlign: 'right' }}>{q.running}</td>
                  <td style={{ padding: '0.4rem', textAlign: 'right' }}>{q.completed}</td>
                  <td style={{ padding: '0.4rem', textAlign: 'right', color: q.failed > 0 ? '#c62828' : 'inherit' }}>{q.failed}</td>
                  <td style={{ padding: '0.4rem', textAlign: 'right', color: q.deadLettered > 0 ? '#b71c1c' : 'inherit' }}>{q.deadLettered}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {dashboard && (
        <div style={{ marginTop: '0.5rem', color: '#999', fontSize: '0.8rem', textAlign: 'right' }}>
          Last refreshed: {new Date(dashboard.refreshedAt).toLocaleTimeString()}
        </div>
      )}
    </div>
  );
}

// ── App ───────────────────────────────────────────────────

function App() {
  const [page, setPage] = useState<'dashboard' | 'queue'>('dashboard');

  return (
    <div style={{ fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif', maxWidth: 1200, margin: '0 auto', padding: '1rem' }}>
      <header style={{ display: 'flex', alignItems: 'center', gap: '2rem', marginBottom: '2rem', borderBottom: '1px solid #ddd', paddingBottom: '1rem' }}>
        <h1 style={{ margin: 0, fontSize: '1.5rem' }}>ModuleWarden</h1>
        <nav style={{ display: 'flex', gap: '0.5rem' }}>
          <button
            onClick={() => setPage('dashboard')}
            style={{
              padding: '0.5rem 1rem',
              border: 'none',
              borderRadius: 4,
              background: page === 'dashboard' ? '#1976d2' : '#e0e0e0',
              color: page === 'dashboard' ? '#fff' : '#333',
              cursor: 'pointer',
              fontWeight: page === 'dashboard' ? 600 : 400,
            }}
          >
            Dashboard
          </button>
          <button
            onClick={() => setPage('queue')}
            style={{
              padding: '0.5rem 1rem',
              border: 'none',
              borderRadius: 4,
              background: page === 'queue' ? '#1976d2' : '#e0e0e0',
              color: page === 'queue' ? '#fff' : '#333',
              cursor: 'pointer',
              fontWeight: page === 'queue' ? 600 : 400,
            }}
          >
            Queue
          </button>
        </nav>
      </header>

      {page === 'dashboard' ? <DashboardPage /> : <QueuePage />}

      <footer style={{ marginTop: '3rem', paddingTop: '1rem', borderTop: '1px solid #eee', color: '#999', fontSize: '0.85rem' }}>
        ModuleWarden v0.1.0 — Auto-refreshes every {REFRESH_INTERVAL / 1000}s
      </footer>
    </div>
  );
}

// Retain QueuePage for navigation, now shows the queue stats table
function QueuePage() {
  const [stats, setStats] = useState<QueueStat[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function doFetch() {
      try {
        const resp = await fetch(`${API_BASE}/admin/queue-stats`);
        if (resp.ok) setStats(await resp.json() as QueueStat[]);
      } catch { /* */ }
      setLoading(false);
    }
    doFetch();
    const interval = setInterval(fetch, REFRESH_INTERVAL);
    return () => clearInterval(interval);
  }, []);

  return (
    <div>
      <h2>Queue Status</h2>
      {loading ? (
        <p style={{ color: '#666' }}>Loading...</p>
      ) : stats.length === 0 ? (
        <p style={{ color: '#666' }}>No queue data available. Ensure the API server is running.</p>
      ) : (
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead>
            <tr style={{ borderBottom: '2px solid #ddd' }}>
              <th style={{ padding: '0.5rem', textAlign: 'left' }}>Queue</th>
              <th style={{ padding: '0.5rem', textAlign: 'right' }}>Pending</th>
              <th style={{ padding: '0.5rem', textAlign: 'right' }}>Running</th>
              <th style={{ padding: '0.5rem', textAlign: 'right' }}>Completed</th>
              <th style={{ padding: '0.5rem', textAlign: 'right' }}>Failed</th>
              <th style={{ padding: '0.5rem', textAlign: 'right' }}>Dead Letter</th>
            </tr>
          </thead>
          <tbody>
            {stats.map((q) => (
              <tr key={q.queue} style={{ borderBottom: '1px solid #eee' }}>
                <td style={{ padding: '0.5rem', fontFamily: 'monospace' }}>{q.queue}</td>
                <td style={{ padding: '0.5rem', textAlign: 'right' }}>{q.pending}</td>
                <td style={{ padding: '0.5rem', textAlign: 'right' }}>{q.running}</td>
                <td style={{ padding: '0.5rem', textAlign: 'right' }}>{q.completed}</td>
                <td style={{ padding: '0.5rem', textAlign: 'right', color: q.failed > 0 ? '#c62828' : 'inherit' }}>{q.failed}</td>
                <td style={{ padding: '0.5rem', textAlign: 'right', color: q.deadLettered > 0 ? '#b71c1c' : 'inherit' }}>{q.deadLettered}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

const root = document.getElementById('root');
if (root) {
  createRoot(root).render(<App />);
}

export default App;
