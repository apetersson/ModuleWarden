import React, { useState, useEffect, useCallback } from 'react';
import { createRoot } from 'react-dom/client';

const API_BASE = '';
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

interface EvidenceArtifact {
  id: string;
  type: string;
  name: string;
  description: string;
  createdAt: string;
  filePath?: string;
  viewable: boolean;
}

interface PackageDetail {
  packageName: string;
  version: string;
  tarballHash: string;
  verdict: string | null;
  riskSummary: string | null;
  piSessionId: string | null;
  evidenceArtifacts: EvidenceArtifact[];
  scores: Record<string, number>;
  decisionHistory: Array<{
    id: string;
    verdict: string;
    reasonSummary: string;
    actorType: string;
    createdAt: string;
  }>;
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

function DashboardPage({ onCardClick }: { onCardClick?: (id: string) => void }) {
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
                <div key={card.id} onClick={() => onCardClick?.(card.id)} style={{ cursor: 'pointer',
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

// ── Audit Run Detail Modal ──────────────────────────────

function AuditRunDetail({ runId, onClose }: { runId: string; onClose: () => void }) {
  const [detail, setDetail] = useState<PackageDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [evidenceContent, setEvidenceContent] = useState<Record<string, unknown> | null>(null);
  const [loadingEvidence, setLoadingEvidence] = useState<string | null>(null);

  useEffect(() => {
    async function load() {
      try {
        const resp = await fetch(`${API_BASE}/admin/audit-run/${runId}`);
        if (resp.ok) setDetail(await resp.json() as PackageDetail);
      } catch { /* */ }
      setLoading(false);
    }
    load();
  }, [runId]);

  const openEvidence = async (id: string) => {
    setLoadingEvidence(id);
    try {
      const resp = await fetch(`${API_BASE}/admin/evidence/${id}`);
      if (resp.ok) setEvidenceContent(await resp.json() as unknown as Record<string, unknown>);
    } catch { /* */ }
    setLoadingEvidence(null);
  };

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center' }} onClick={onClose}>
      <div style={{ background: '#fff', borderRadius: 8, maxWidth: 800, width: '90%', maxHeight: '80vh', overflow: 'auto', padding: '1.5rem' }} onClick={(e) => e.stopPropagation()}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1rem' }}>
          <h2 style={{ margin: 0, fontSize: '1.2rem' }}>Audit Run Detail</h2>
          <button onClick={onClose} style={{ border: 'none', background: 'none', cursor: 'pointer', fontSize: '1.2rem' }}>✕</button>
        </div>

        {loading ? (
          <p style={{ color: '#666' }}>Loading...</p>
        ) : !detail ? (
          <p style={{ color: '#c62828' }}>Failed to load audit run details.</p>
        ) : (
          <>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.5rem', fontSize: '0.9rem' }}>
              <div><strong>Package:</strong> {detail.packageName}</div>
              <div><strong>Version:</strong> {detail.version}</div>
              <div><strong>Hash:</strong> <code style={{ fontSize: '0.8rem' }}>{detail.tarballHash.slice(0, 24)}...</code></div>
              <div><strong>Verdict:</strong> <span style={{ color: statusColor(detail.verdict), fontWeight: 600 }}>{detail.verdict ?? 'Pending'}</span></div>
              <div><strong>PI Session:</strong> {detail.piSessionId ?? 'N/A'}</div>
              <div><strong>Risk:</strong> {detail.riskSummary ?? 'N/A'}</div>
            </div>

            {detail.riskSummary && (
              <div style={{ marginTop: '0.75rem', padding: '0.75rem', background: '#fff3e0', borderRadius: 4, fontSize: '0.9rem' }}>
                <strong>Risk Summary:</strong> {detail.riskSummary}
              </div>
            )}

            {/* Scores */}
            {Object.keys(detail.scores).length > 0 && (
              <div style={{ marginTop: '0.75rem' }}>
                <h3 style={{ fontSize: '1rem', margin: '0 0 0.5rem' }}>Scores</h3>
                <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
                  {Object.entries(detail.scores).map(([k, v]) => (
                    <span key={k} style={{ padding: '0.2rem 0.5rem', background: '#e3f2fd', borderRadius: 4, fontSize: '0.85rem' }}>
                      {k}: {v}
                    </span>
                  ))}
                </div>
              </div>
            )}

            {/* Evidence */}
            <div style={{ marginTop: '0.75rem' }}>
              <h3 style={{ fontSize: '1rem', margin: '0 0 0.5rem' }}>Evidence ({detail.evidenceArtifacts.length})</h3>
              {detail.evidenceArtifacts.length === 0 ? (
                <p style={{ color: '#999', fontSize: '0.85rem' }}>No evidence artifacts recorded.</p>
              ) : (
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.85rem' }}>
                  <thead>
                    <tr style={{ borderBottom: '1px solid #ddd' }}>
                      <th style={{ padding: '0.3rem', textAlign: 'left' }}>Type</th>
                      <th style={{ padding: '0.3rem', textAlign: 'left' }}>Name</th>
                      <th style={{ padding: '0.3rem', textAlign: 'left' }}>Created</th>
                      <th style={{ padding: '0.3rem', textAlign: 'left' }}>Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {detail.evidenceArtifacts.map((ea) => (
                      <tr key={ea.id} style={{ borderBottom: '1px solid #eee' }}>
                        <td style={{ padding: '0.3rem', fontSize: '0.8rem' }}>{ea.type}</td>
                        <td style={{ padding: '0.3rem', fontFamily: 'monospace', fontSize: '0.8rem' }}>{ea.name}</td>
                        <td style={{ padding: '0.3rem', color: '#666', fontSize: '0.8rem' }}>{new Date(ea.createdAt).toLocaleString()}</td>
                        <td style={{ padding: '0.3rem' }}>
                          {ea.viewable ? (
                            <button
                              onClick={() => openEvidence(ea.id)}
                              style={{ padding: '0.2rem 0.5rem', fontSize: '0.8rem', cursor: 'pointer' }}
                              disabled={loadingEvidence === ea.id}
                            >
                              {loadingEvidence === ea.id ? 'Loading...' : 'View'}
                            </button>
                          ) : (
                            <span style={{ color: '#999', fontSize: '0.8rem' }}>Redacted</span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>

            {/* Evidence content viewer */}
            {evidenceContent && (
              <div style={{ marginTop: '0.75rem', padding: '0.75rem', background: '#f5f5f5', borderRadius: 4 }}>
                <h3 style={{ fontSize: '1rem', margin: '0 0 0.5rem' }}>Evidence Content</h3>
                <pre style={{ fontSize: '0.8rem', overflow: 'auto', maxHeight: 300, whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>
                  {JSON.stringify(evidenceContent, null, 2)}
                </pre>
              </div>
            )}

            {/* Decision history */}
            {detail.decisionHistory.length > 0 && (
              <div style={{ marginTop: '0.75rem' }}>
                <h3 style={{ fontSize: '1rem', margin: '0 0 0.5rem' }}>Decision History</h3>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.85rem' }}>
                  <thead>
                    <tr style={{ borderBottom: '1px solid #ddd' }}>
                      <th style={{ padding: '0.3rem', textAlign: 'left' }}>Verdict</th>
                      <th style={{ padding: '0.3rem', textAlign: 'left' }}>Reason</th>
                      <th style={{ padding: '0.3rem', textAlign: 'left' }}>Actor</th>
                      <th style={{ padding: '0.3rem', textAlign: 'left' }}>Date</th>
                    </tr>
                  </thead>
                  <tbody>
                    {detail.decisionHistory.map((dh) => (
                      <tr key={dh.id} style={{ borderBottom: '1px solid #eee' }}>
                        <td style={{ padding: '0.3rem' }}>
                          <span style={{ color: '#fff', background: statusColor(dh.verdict), padding: '1px 6px', borderRadius: 10, fontSize: '0.8rem', fontWeight: 600 }}>
                            {dh.verdict}
                          </span>
                        </td>
                        <td style={{ padding: '0.3rem', fontSize: '0.8rem' }}>{dh.reasonSummary.slice(0, 100)}</td>
                        <td style={{ padding: '0.3rem', fontSize: '0.8rem' }}>{dh.actorType}</td>
                        <td style={{ padding: '0.3rem', fontSize: '0.8rem', color: '#666' }}>{new Date(dh.createdAt).toLocaleString()}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

function App() {
  const [page, setPage] = useState<'dashboard' | 'queue'>('dashboard');
  const [detailRunId, setDetailRunId] = useState<string | null>(null);
  return (
    <>
      {detailRunId && (
        <AuditRunDetail runId={detailRunId} onClose={() => setDetailRunId(null)} />
      )}
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

      {page === 'dashboard' ? <DashboardPage onCardClick={(id) => setDetailRunId(id)} /> : <QueuePage />}

      <footer style={{ marginTop: '3rem', paddingTop: '1rem', borderTop: '1px solid #eee', color: '#999', fontSize: '0.85rem' }}>
        ModuleWarden v0.1.0 — Auto-refreshes every {REFRESH_INTERVAL / 1000}s
      </footer>
    </div>
    </>
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
