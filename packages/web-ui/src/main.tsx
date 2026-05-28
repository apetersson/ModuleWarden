import { useState, useEffect, useCallback, useMemo } from 'react';
import { createRoot } from 'react-dom/client';

// API_BASE resolution order: Vite build arg > window global > empty string (same-origin)
const viteBase = typeof import.meta !== 'undefined' ? (import.meta as Record<string, any>).env?.VITE_MW_API_BASE_URL : undefined;
const API_BASE = viteBase || (typeof window !== 'undefined' ? (window as any).__MW_API_BASE__ : undefined) || '';
const REFRESH_INTERVAL = 15_000;

function authHeaders(token: string): Record<string, string> {
  return token ? { Authorization: `Bearer ${token}` } : {};
}

async function adminFetch(url: string, token: string): Promise<Response> {
  return fetch(url, { headers: authHeaders(token) });
}

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

const EMPTY_AUDIT_CARDS: AuditRunCard[] = [];

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

function DashboardPage({ onCardClick, adminToken }: { onCardClick?: (id: string) => void; adminToken: string }) {
  const [dashboard, setDashboard] = useState<DashboardData | null>(null);
  const [queueStats, setQueueStats] = useState<QueueStat[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [activeColumn, setActiveColumn] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [sortBy, setSortBy] = useState<'age-asc' | 'age-desc' | 'risk'>('age-desc');

  const fetchDashboard = useCallback(async () => {
    try {
      const [dashResp, queueResp] = await Promise.all([
        adminFetch(`${API_BASE}/admin/dashboard`, adminToken),
        adminFetch(`${API_BASE}/admin/queue-stats`, adminToken),
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
  }, [adminToken]);

  useEffect(() => {
    void fetchDashboard();
    const interval = setInterval(() => void fetchDashboard(), REFRESH_INTERVAL);
    return () => clearInterval(interval);
  }, [fetchDashboard]);

  const columnOrder = ['submitted', 'queued', 'running', 'needs-escalation', 'quarantined', 'blocked', 'allowed', 'promotion-pending', 'promoted', 'failed', 'superseded'];

  // Filter helper: check if a card matches the search query
  const matchesSearch = useCallback((card: AuditRunCard): boolean => {
    if (!searchQuery) return true;
    const q = searchQuery.toLowerCase();
    return (
      card.packageName.toLowerCase().includes(q) ||
      card.packageVersion.toLowerCase().includes(q)
    );
  }, [searchQuery]);

  const selectedCards = activeColumn && dashboard
    ? dashboard.columns[activeColumn] ?? EMPTY_AUDIT_CARDS
    : null;

  const sortedCards = useMemo(() => {
    if (!selectedCards) return null;
    let cards = selectedCards;
    if (searchQuery) {
      cards = cards.filter(matchesSearch);
    }
    return [...cards].sort((a, b) => {
      if (sortBy === 'age-asc') return a.ageSeconds - b.ageSeconds;
      if (sortBy === 'age-desc') return b.ageSeconds - a.ageSeconds;
      if (sortBy === 'risk') {
        const ra = a.riskSummary ?? '';
        const rb = b.riskSummary ?? '';
        return rb.localeCompare(ra);
      }
      return 0;
    });
  }, [selectedCards, searchQuery, sortBy, matchesSearch]);

  const filteredColumns = useMemo(() => {
    if (!dashboard || !searchQuery) return dashboard?.columns;
    const result: Record<string, AuditRunCard[]> = {};
    for (const [col, cards] of Object.entries(dashboard.columns)) {
      const filtered = cards.filter(matchesSearch);
      if (filtered.length > 0) result[col] = filtered;
    }
    return result;
  }, [dashboard, searchQuery, matchesSearch]);

  const displayColumns = searchQuery ? filteredColumns : dashboard?.columns;

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

  if (dashboard?.summary.total === 0) {
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

  return (
    <div>
      <div style={{ display: 'flex', gap: '1rem', alignItems: 'center', marginBottom: '1rem' }}>
        <h2 style={{ margin: 0 }}>Audit Dashboard</h2>
        <span style={{ color: '#666', fontSize: '0.9rem' }}>
          {dashboard?.summary.total ?? 0} runs
          {dashboard && <span> · {dashboard.summary.needsAttention} need attention</span>}
        </span>
        <input
          type="text"
          placeholder="Search by package or version..."
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          style={{
            marginLeft: 'auto',
            padding: '0.3rem 0.6rem',
            fontSize: '0.85rem',
            borderRadius: 4,
            border: '1px solid #ccc',
            width: 220,
          }}
        />
        <button
          onClick={() => { setLoading(true); void fetchDashboard(); }}
          style={{ padding: '0.3rem 0.8rem', cursor: 'pointer' }}
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
          const cards = displayColumns?.[col];
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
              {cards?.slice(0, 5).map((card) => (
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

      {/* Lockfile Import Progress */}
      {dashboard && (
        <div style={{ marginTop: '1.5rem', padding: '0.75rem', border: '1px solid #e0e0e0', borderRadius: 8, background: '#fafafa' }}>
          <h3 style={{ margin: '0 0 0.5rem', fontSize: '1rem' }}>Lockfile Import Progress</h3>
          <div style={{ display: 'flex', gap: '1.5rem', flexWrap: 'wrap', alignItems: 'center' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
              <div style={{ width: 12, height: 12, borderRadius: '50%', background: '#1565c0' }} />
              <span style={{ fontSize: '0.85rem' }}>Queued: {dashboard.summary.queued}</span>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
              <div style={{ width: 12, height: 12, borderRadius: '50%', background: '#6a1b9a' }} />
              <span style={{ fontSize: '0.85rem' }}>Running: {dashboard.summary.running}</span>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
              <div style={{ width: 12, height: 12, borderRadius: '50%', background: '#2e7d32' }} />
              <span style={{ fontSize: '0.85rem' }}>Allowed: {dashboard.summary.allowed}</span>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
              <div style={{ width: 12, height: 12, borderRadius: '50%', background: '#c62828' }} />
              <span style={{ fontSize: '0.85rem' }}>Blocked: {dashboard.summary.blocked}</span>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
              <div style={{ width: 12, height: 12, borderRadius: '50%', background: '#f57f17' }} />
              <span style={{ fontSize: '0.85rem' }}>Quarantined: {dashboard.summary.quarantined}</span>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
              <div style={{ width: 12, height: 12, borderRadius: '50%', background: '#b71c1c' }} />
              <span style={{ fontSize: '0.85rem' }}>Failed: {dashboard.summary.failed}</span>
            </div>
          </div>
          {dashboard.summary.total > 0 && (
            <div style={{ marginTop: '0.5rem' }}>
              <div style={{
                height: 8,
                borderRadius: 4,
                background: '#e0e0e0',
                overflow: 'hidden',
                position: 'relative',
              }}>
                <div style={{
                  height: '100%',
                  width: `${((dashboard.summary.allowed + dashboard.summary.blocked + dashboard.summary.quarantined + dashboard.summary.failed) / dashboard.summary.total) * 100}%`,
                  background: 'linear-gradient(90deg, #2e7d32, #c62828)',
                  borderRadius: 4,
                  transition: 'width 0.5s ease',
                }} />
              </div>
              <div style={{ fontSize: '0.75rem', color: '#666', marginTop: '0.2rem' }}>
                {Math.round(((dashboard.summary.allowed + dashboard.summary.blocked + dashboard.summary.quarantined + dashboard.summary.failed) / dashboard.summary.total) * 100)}% complete
                ({dashboard.summary.allowed + dashboard.summary.blocked + dashboard.summary.quarantined + dashboard.summary.failed} / {dashboard.summary.total} packages)
              </div>
            </div>
          )}
        </div>
      )}

      {/* Selected column detail */}
      {activeColumn && sortedCards && (
        <div style={{ marginTop: '1rem' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '1rem', marginBottom: '0.5rem' }}>
            <h3 style={{ textTransform: 'capitalize', margin: 0 }}>{activeColumn.replace(/-/g, ' ')} ({sortedCards.length})</h3>
            <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
              <label htmlFor="sort-select" style={{ fontSize: '0.85rem', color: '#666' }}>Sort:</label>
              <select
                id="sort-select"
                value={sortBy}
                onChange={(e) => setSortBy(e.target.value as 'age-asc' | 'age-desc' | 'risk')}
                style={{ padding: '0.25rem 0.5rem', fontSize: '0.85rem', borderRadius: 4, border: '1px solid #ccc' }}
              >
                <option value="age-desc">Age (newest)</option>
                <option value="age-asc">Age (oldest)</option>
                <option value="risk">Risk</option>
              </select>
            </div>
          </div>
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
              {sortedCards.map((card) => (
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

// ── Prompts Page ─────────────────────────────────────────

interface PromptPack {
  id: string;
  name: string;
  version: string;
  category: string;
  createdAt: string;
}

function PromptsPage({ adminToken }: { adminToken: string }) {
  const [prompts, setPrompts] = useState<PromptPack[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    async function doFetch() {
      try {
        const resp = await fetch(`${API_BASE}/admin/prompts`, { headers: authHeaders(adminToken) });
        if (resp.ok) {
          setPrompts(await resp.json() as PromptPack[]);
        } else {
          setError(`Prompts API: ${resp.status}`);
        }
      } catch (err) {
        setError(`API unavailable: ${err instanceof Error ? err.message : String(err)}`);
      }
      setLoading(false);
    }
    void doFetch();
  }, [adminToken]);

  if (loading) {
    return <div><h2>Prompt Packs</h2><p style={{ color: '#666' }}>Loading prompts...</p></div>;
  }

  if (error) {
    return (
      <div>
        <h2>Prompt Packs</h2>
        <div style={{ padding: '2rem', textAlign: 'center', color: '#c62828' }}>
          <p style={{ fontSize: '1.2rem' }}>Unable to load prompts</p>
          <p>{error}</p>
        </div>
      </div>
    );
  }

  if (prompts.length === 0) {
    return (
      <div>
        <h2>Prompt Packs</h2>
        <div style={{ padding: '2rem', textAlign: 'center', color: '#666' }}>
          <p>No prompt packs found.</p>
          <p style={{ marginTop: '0.5rem', fontSize: '0.85rem' }}>
            Prompt packs are created when packages are audited. Import a lockfile or trigger a review to generate prompts.
          </p>
        </div>
      </div>
    );
  }

  const corePrompts = prompts.filter((p) => p.category === 'CORE' || p.category === 'PATTERN_CHECK');
  const customPrompts = prompts.filter((p) => p.category === 'CUSTOM_ADMIN' || p.category === 'ESCALATION');

  function renderTable(rows: PromptPack[]) {
    return (
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.85rem' }}>
        <thead>
          <tr style={{ borderBottom: '2px solid #ddd' }}>
            <th style={{ padding: '0.4rem', textAlign: 'left' }}>Name</th>
            <th style={{ padding: '0.4rem', textAlign: 'left' }}>Version</th>
            <th style={{ padding: '0.4rem', textAlign: 'left' }}>Category</th>
            <th style={{ padding: '0.4rem', textAlign: 'left' }}>Created</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((p) => (
            <tr key={p.id} style={{ borderBottom: '1px solid #eee' }}>
              <td style={{ padding: '0.4rem', fontFamily: 'monospace' }}>{p.name}</td>
              <td style={{ padding: '0.4rem' }}>{p.version}</td>
              <td style={{ padding: '0.4rem' }}>
                <span style={{
                  padding: '1px 6px',
                  borderRadius: 10,
                  fontSize: '0.8rem',
                  fontWeight: 600,
                  background: p.category === 'CORE' ? '#e3f2fd' : p.category === 'CUSTOM_ADMIN' ? '#fff3e0' : '#f3e5f5',
                  color: p.category === 'CORE' ? '#1565c0' : p.category === 'CUSTOM_ADMIN' ? '#e65100' : '#6a1b9a',
                }}>
                  {p.category}
                </span>
              </td>
              <td style={{ padding: '0.4rem', color: '#666' }}>{new Date(p.createdAt).toLocaleString()}</td>
            </tr>
          ))}
        </tbody>
      </table>
    );
  }

  return (
    <div>
      <h2>Prompt Packs</h2>
      <p style={{ color: '#666', fontSize: '0.9rem' }}>{prompts.length} total prompt packs</p>

      {customPrompts.length > 0 && (
        <div style={{ marginTop: '1.5rem' }}>
          <h3 style={{ fontSize: '1rem', margin: '0 0 0.5rem' }}>Custom Prompts ({customPrompts.length})</h3>
          {renderTable(customPrompts)}
        </div>
      )}

      <div style={{ marginTop: '1.5rem' }}>
        <h3 style={{ fontSize: '1rem', margin: '0 0 0.5rem' }}>Core Prompts ({corePrompts.length})</h3>
        {renderTable(corePrompts)}
      </div>
    </div>
  );
}

// ── Campaigns Page ───────────────────────────────────────

interface Campaign {
  id: string;
  reason: string;
  triggerType: string;
  status: string;
  createdAt: string;
  completedAt: string | null;
  projectId: string;
}

function CampaignsPage({ adminToken }: { adminToken: string }) {
  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    async function doFetch() {
      try {
        const resp = await fetch(`${API_BASE}/admin/campaigns`, { headers: authHeaders(adminToken) });
        if (resp.ok) {
          setCampaigns(await resp.json() as Campaign[]);
        } else {
          setError(`Campaigns API: ${resp.status}`);
        }
      } catch (err) {
        setError(`API unavailable: ${err instanceof Error ? err.message : String(err)}`);
      }
      setLoading(false);
    }
    void doFetch();
  }, [adminToken]);

  if (loading) {
    return <div><h2>Re-Audit Campaigns</h2><p style={{ color: '#666' }}>Loading campaigns...</p></div>;
  }

  if (error) {
    return (
      <div>
        <h2>Re-Audit Campaigns</h2>
        <div style={{ padding: '2rem', textAlign: 'center', color: '#c62828' }}>
          <p style={{ fontSize: '1.2rem' }}>Unable to load campaigns</p>
          <p>{error}</p>
        </div>
      </div>
    );
  }

  if (campaigns.length === 0) {
    return (
      <div>
        <h2>Re-Audit Campaigns</h2>
        <div style={{ padding: '2rem', textAlign: 'center', color: '#666' }}>
          <p>No re-audit campaigns found.</p>
          <p style={{ marginTop: '0.5rem', fontSize: '0.85rem' }}>
            Campaigns are created when prompts or model profiles change, triggering re-evaluation of previously audited packages.
          </p>
        </div>
      </div>
    );
  }

  function campaignStatusColor(status: string): string {
    switch (status) {
      case 'COMPLETED': return '#2e7d32';
      case 'RUNNING': return '#1565c0';
      case 'PENDING': return '#f57f17';
      case 'CANCELLED': return '#757575';
      default: return '#757575';
    }
  }

  return (
    <div>
      <h2>Re-Audit Campaigns</h2>
      <p style={{ color: '#666', fontSize: '0.9rem' }}>{campaigns.length} total campaigns</p>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.85rem' }}>
        <thead>
          <tr style={{ borderBottom: '2px solid #ddd' }}>
            <th style={{ padding: '0.4rem', textAlign: 'left' }}>ID</th>
            <th style={{ padding: '0.4rem', textAlign: 'left' }}>Reason</th>
            <th style={{ padding: '0.4rem', textAlign: 'left' }}>Trigger</th>
            <th style={{ padding: '0.4rem', textAlign: 'left' }}>Status</th>
            <th style={{ padding: '0.4rem', textAlign: 'left' }}>Created</th>
            <th style={{ padding: '0.4rem', textAlign: 'left' }}>Completed</th>
          </tr>
        </thead>
        <tbody>
          {campaigns.map((c) => (
            <tr key={c.id} style={{ borderBottom: '1px solid #eee' }}>
              <td style={{ padding: '0.4rem', fontFamily: 'monospace', fontSize: '0.8rem' }}>
                {c.id.slice(0, 8)}...
              </td>
              <td style={{ padding: '0.4rem', maxWidth: 300, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {c.reason}
              </td>
              <td style={{ padding: '0.4rem' }}>
                <span style={{
                  padding: '1px 6px',
                  borderRadius: 10,
                  fontSize: '0.8rem',
                  fontWeight: 600,
                  background: '#e8eaf6',
                  color: '#283593',
                }}>
                  {c.triggerType}
                </span>
              </td>
              <td style={{ padding: '0.4rem' }}>
                <span style={{
                  padding: '1px 6px',
                  borderRadius: 10,
                  fontSize: '0.8rem',
                  fontWeight: 600,
                  color: '#fff',
                  background: campaignStatusColor(c.status),
                }}>
                  {c.status}
                </span>
              </td>
              <td style={{ padding: '0.4rem', color: '#666' }}>{new Date(c.createdAt).toLocaleString()}</td>
              <td style={{ padding: '0.4rem', color: '#666' }}>
                {c.completedAt ? new Date(c.completedAt).toLocaleString() : '\u2014'}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ── Evaluation Page ──────────────────────────────────────

interface EvaluationResult {
  labelId: string;
  labelValue: string;
  labelDescription: string | null;
  labelCreatedAt: string;
  decisionId: string;
  verdict: string | null;
  reasonSummary: string | null;
  decisionCreatedAt: string;
  packageName: string;
  packageVersion: string;
}

function EvaluationPage({ adminToken }: { adminToken: string }) {
  const [results, setResults] = useState<EvaluationResult[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    async function doFetch() {
      try {
        const resp = await fetch(`${API_BASE}/admin/evaluation`, { headers: authHeaders(adminToken) });
        if (resp.ok) {
          setResults(await resp.json() as EvaluationResult[]);
        } else {
          setError(`Evaluation API: ${resp.status}`);
        }
      } catch (err) {
        setError(`API unavailable: ${err instanceof Error ? err.message : String(err)}`);
      }
      setLoading(false);
    }
    void doFetch();
  }, [adminToken]);

  if (loading) {
    return <div><h2>Evaluation Results</h2><p style={{ color: '#666' }}>Loading evaluation data...</p></div>;
  }

  if (error) {
    return (
      <div>
        <h2>Evaluation Results</h2>
        <div style={{ padding: '2rem', textAlign: 'center', color: '#c62828' }}>
          <p style={{ fontSize: '1.2rem' }}>Unable to load evaluation results</p>
          <p>{error}</p>
        </div>
      </div>
    );
  }

  if (results.length === 0) {
    return (
      <div>
        <h2>Evaluation Results</h2>
        <div style={{ padding: '2rem', textAlign: 'center', color: '#666' }}>
          <p>No evaluation results available.</p>
          <p style={{ marginTop: '0.5rem', fontSize: '0.85rem' }}>
            Evaluation results appear when packages are audited through the evaluation pipeline. Trigger a re-audit campaign or run the evaluation corpus to populate this view.
          </p>
        </div>
      </div>
    );
  }

  function verdictColor(verdict: string | null): string {
    switch (verdict) {
      case 'ALLOW': return '#2e7d32';
      case 'BLOCK': return '#c62828';
      case 'QUARANTINE': return '#f57f17';
      default: return '#757575';
    }
  }

  function matchResultColor(value: string): string {
    if (value === 'caught' || value === 'correct-allow') return '#2e7d32';
    if (value === 'missed' || value === 'false-positive-block' || value === 'false-positive-quarantine') return '#c62828';
    if (value === 'quarantined') return '#f57f17';
    return '#757575';
  }

  return (
    <div>
      <h2>Evaluation Results</h2>
      <p style={{ color: '#666', fontSize: '0.9rem' }}>{results.length} evaluation result{results.length !== 1 ? 's' : ''}</p>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.85rem' }}>
        <thead>
          <tr style={{ borderBottom: '2px solid #ddd' }}>
            <th style={{ padding: '0.4rem', textAlign: 'left' }}>Package</th>
            <th style={{ padding: '0.4rem', textAlign: 'left' }}>Version</th>
            <th style={{ padding: '0.4rem', textAlign: 'left' }}>Verdict</th>
            <th style={{ padding: '0.4rem', textAlign: 'left' }}>Result</th>
            <th style={{ padding: '0.4rem', textAlign: 'left' }}>Description</th>
            <th style={{ padding: '0.4rem', textAlign: 'left' }}>Date</th>
          </tr>
        </thead>
        <tbody>
          {results.map((r) => (
            <tr key={r.labelId} style={{ borderBottom: '1px solid #eee' }}>
              <td style={{ padding: '0.4rem', fontFamily: 'monospace' }}>{r.packageName}</td>
              <td style={{ padding: '0.4rem' }}>{r.packageVersion}</td>
              <td style={{ padding: '0.4rem' }}>
                {r.verdict ? (
                  <span style={{ color: '#fff', background: verdictColor(r.verdict), padding: '1px 6px', borderRadius: 10, fontSize: '0.8rem', fontWeight: 600 }}>
                    {r.verdict}
                  </span>
                ) : (
                  <span style={{ color: '#999' }}>\u2014</span>
                )}
              </td>
              <td style={{ padding: '0.4rem' }}>
                <span style={{
                  padding: '1px 6px',
                  borderRadius: 10,
                  fontSize: '0.8rem',
                  fontWeight: 600,
                  color: '#fff',
                  background: matchResultColor(r.labelValue),
                }}>
                  {r.labelValue}
                </span>
              </td>
              <td style={{ padding: '0.4rem', maxWidth: 300, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: '#666' }}>
                {r.labelDescription ?? r.reasonSummary ?? ''}
              </td>
              <td style={{ padding: '0.4rem', color: '#666' }}>{new Date(r.labelCreatedAt).toLocaleString()}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ── App ───────────────────────────────────────────────────

// ── Audit Run Detail Modal ──────────────────────────────

function AuditRunDetail({ runId, adminToken, onClose }: { runId: string; adminToken: string; onClose: () => void }) {
  const [detail, setDetail] = useState<PackageDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [evidenceContent, setEvidenceContent] = useState<Record<string, unknown> | null>(null);
  const [loadingEvidence, setLoadingEvidence] = useState<string | null>(null);
  const [showOverride, setShowOverride] = useState(false);
  const [overrideTargetVerdict, setOverrideTargetVerdict] = useState<'ALLOW' | 'BLOCK' | 'QUARANTINE'>('ALLOW');
  const [overrideReason, setOverrideReason] = useState('');
  const [overrideMessage, setOverrideMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const [overrideSubmitting, setOverrideSubmitting] = useState(false);

  useEffect(() => {
    async function load() {
      try {
        const resp = await adminFetch(`${API_BASE}/admin/audit-run/${runId}`, adminToken);
        if (resp.ok) setDetail(await resp.json() as PackageDetail);
      } catch { /* */ }
      setLoading(false);
    }
    void load();
  }, [adminToken, runId]);

  const openEvidence = async (id: string) => {
    setLoadingEvidence(id);
    try {
      const resp = await adminFetch(`${API_BASE}/admin/evidence/${id}`, adminToken);
      if (resp.ok) setEvidenceContent(await resp.json());
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

            {/* Admin Override */}
            <div style={{ marginTop: '0.75rem' }}>
              <button
                onClick={() => setShowOverride(!showOverride)}
                style={{
                  padding: '0.4rem 0.8rem',
                  background: showOverride ? '#f5f5f5' : '#e65100',
                  color: showOverride ? '#333' : '#fff',
                  border: '1px solid #ccc',
                  borderRadius: 4,
                  cursor: 'pointer',
                  fontSize: '0.85rem',
                  fontWeight: 600,
                }}
              >
                {showOverride ? 'Cancel Override' : 'Admin Override'}
              </button>

              {showOverride && (
                <div style={{ marginTop: '0.5rem', padding: '0.75rem', border: '1px solid #e65100', borderRadius: 4, background: '#fff3e0' }}>
                  <h4 style={{ margin: '0 0 0.5rem', fontSize: '0.95rem', color: '#e65100' }}>Admin Override</h4>
                  <div style={{ display: 'grid', gap: '0.5rem' }}>
                    <div>
                      <label style={{ fontSize: '0.85rem', fontWeight: 600 }}>Package</label>
                      <input
                        type="text"
                        value={detail.packageName}
                        readOnly
                        style={{ width: '100%', padding: '0.3rem', fontSize: '0.85rem', border: '1px solid #ccc', borderRadius: 4, background: '#eee' }}
                      />
                    </div>
                    <div>
                      <label style={{ fontSize: '0.85rem', fontWeight: 600 }}>Version</label>
                      <input
                        type="text"
                        value={detail.version}
                        readOnly
                        style={{ width: '100%', padding: '0.3rem', fontSize: '0.85rem', border: '1px solid #ccc', borderRadius: 4, background: '#eee' }}
                      />
                    </div>
                    <div>
                      <label style={{ fontSize: '0.85rem', fontWeight: 600 }}>Target Verdict</label>
                      <select
                        value={overrideTargetVerdict}
                        onChange={(e) => setOverrideTargetVerdict(e.target.value as 'ALLOW' | 'BLOCK' | 'QUARANTINE')}
                        style={{ width: '100%', padding: '0.3rem', fontSize: '0.85rem', border: '1px solid #ccc', borderRadius: 4 }}
                      >
                        <option value="ALLOW">ALLOW</option>
                        <option value="BLOCK">BLOCK</option>
                        <option value="QUARANTINE">QUARANTINE</option>
                      </select>
                    </div>
                    <div>
                      <label style={{ fontSize: '0.85rem', fontWeight: 600 }}>Reason</label>
                      <textarea
                        value={overrideReason}
                        onChange={(e) => setOverrideReason(e.target.value)}
                        rows={3}
                        style={{ width: '100%', padding: '0.3rem', fontSize: '0.85rem', border: '1px solid #ccc', borderRadius: 4, resize: 'vertical' }}
                      />
                    </div>
                    <button
                      onClick={async () => {
                        if (!overrideReason.trim()) {
                          setOverrideMessage({ type: 'error', text: 'Reason is required.' });
                          return;
                        }
                        setOverrideSubmitting(true);
                        setOverrideMessage(null);
                        try {
                          const token = adminToken;
                          const resp = await fetch(`${API_BASE}/admin/override`, {
                            method: 'POST',
                            headers: {
                              'Content-Type': 'application/json',
                              ...(token ? { Authorization: `Bearer ${token}` } : {}),
                            },
                            body: JSON.stringify({
                              packageName: detail.packageName,
                              version: detail.version,
                              targetVerdict: overrideTargetVerdict,
                              reason: overrideReason,
                            }),
                          });
                          if (resp.ok) {
                            setOverrideMessage({ type: 'success', text: `Override submitted successfully. Verdict set to ${overrideTargetVerdict}.` });
                            setOverrideReason('');
                          } else {
                            const errBody = await resp.text().catch(() => 'Unknown error');
                            setOverrideMessage({ type: 'error', text: `Override failed (${resp.status}): ${errBody}` });
                          }
                        } catch (err) {
                          setOverrideMessage({ type: 'error', text: `Network error: ${err instanceof Error ? err.message : String(err)}` });
                        }
                        setOverrideSubmitting(false);
                      }}
                      disabled={overrideSubmitting}
                      style={{
                        padding: '0.4rem 0.8rem',
                        background: overrideSubmitting ? '#ccc' : '#e65100',
                        color: '#fff',
                        border: 'none',
                        borderRadius: 4,
                        cursor: overrideSubmitting ? 'not-allowed' : 'pointer',
                        fontSize: '0.85rem',
                        fontWeight: 600,
                      }}
                    >
                      {overrideSubmitting ? 'Submitting...' : 'Submit Override'}
                    </button>
                    {overrideMessage && (
                      <div style={{
                        padding: '0.4rem 0.6rem',
                        borderRadius: 4,
                        fontSize: '0.85rem',
                        background: overrideMessage.type === 'success' ? '#e8f5e9' : '#ffebee',
                        color: overrideMessage.type === 'success' ? '#2e7d32' : '#c62828',
                      }}>
                        {overrideMessage.text}
                      </div>
                    )}
                  </div>
                </div>
              )}
            </div>

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
                <div style={{ padding: '0.4rem 0.6rem', marginBottom: '0.5rem', background: '#fff8e1', borderRadius: 4, fontSize: '0.8rem', color: '#f57f17', border: '1px solid #ffe082' }}>
                  Sensitive fields (prompts, secrets, tokens, API keys) are redacted from this view for security.
                </div>
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
  const [page, setPage] = useState<'dashboard' | 'queue' | 'prompts' | 'campaigns' | 'evaluation'>('dashboard');
  const [detailRunId, setDetailRunId] = useState<string | null>(null);
  const [apiConnected, setApiConnected] = useState<boolean | null>(null);
  const [adminToken, setAdminToken] = useState('');
  const [showTokenInput, setShowTokenInput] = useState(false);

  // AC #18: Check API availability on mount
  useEffect(() => {
    async function checkApi() {
      try {
        const resp = await fetch(`${API_BASE}/health`);
        setApiConnected(resp.ok);
      } catch {
        setApiConnected(false);
      }
    }
    void checkApi();
  }, []);

  const navItems: Array<{ key: typeof page; label: string }> = [
    { key: 'dashboard', label: 'Dashboard' },
    { key: 'queue', label: 'Queue' },
    { key: 'prompts', label: 'Prompts' },
    { key: 'campaigns', label: 'Campaigns' },
    { key: 'evaluation', label: 'Evaluation' },
  ];

  function renderPage() {
    switch (page) {
      case 'dashboard': return <DashboardPage onCardClick={(id) => setDetailRunId(id)} adminToken={adminToken} />;
      case 'queue': return <QueuePage adminToken={adminToken} />;
      case 'prompts': return <PromptsPage adminToken={adminToken} />;
      case 'campaigns': return <CampaignsPage adminToken={adminToken} />;
      case 'evaluation': return <EvaluationPage adminToken={adminToken} />;
    }
  }

  return (
    <>
      {detailRunId && (
        <AuditRunDetail runId={detailRunId} adminToken={adminToken} onClose={() => setDetailRunId(null)} />
      )}
      <div style={{ fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif', maxWidth: 1200, margin: '0 auto', padding: '1rem' }}>
      <header style={{ display: 'flex', alignItems: 'center', gap: '1rem', marginBottom: '2rem', borderBottom: '1px solid #ddd', paddingBottom: '1rem' }}>
        <h1 style={{ margin: 0, fontSize: '1.5rem' }}>ModuleWarden</h1>
        <nav style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
          {navItems.map((item) => (
            <button
              key={item.key}
              onClick={() => setPage(item.key)}
              style={{
                padding: '0.5rem 1rem',
                border: 'none',
                borderRadius: 4,
                background: page === item.key ? '#1976d2' : '#e0e0e0',
                color: page === item.key ? '#fff' : '#333',
                cursor: 'pointer',
                fontWeight: page === item.key ? 600 : 400,
                fontSize: '0.9rem',
              }}
            >
              {item.label}
            </button>
          ))}
        </nav>
        <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
          {showTokenInput ? (
            <>
              <input
                type="text"
                value={adminToken}
                onChange={(e) => setAdminToken(e.target.value)}
                placeholder="Bearer token..."
                style={{ padding: '0.3rem', width: 180, fontSize: '0.85rem', border: '1px solid #ccc', borderRadius: 4 }}
              />
              <button onClick={() => setShowTokenInput(false)} style={{ padding: '0.3rem 0.5rem', fontSize: '0.8rem', cursor: 'pointer' }}>Save</button>
            </>
          ) : (
            <button onClick={() => setShowTokenInput(true)} style={{ padding: '0.3rem 0.5rem', fontSize: '0.8rem', cursor: 'pointer', color: adminToken ? '#2e7d32' : '#999' }}>
              {adminToken ? '🔑 Token set' : '🔑 Set token'}
            </button>
          )}
        </div>
      </header>

      {renderPage()}

      <footer style={{ marginTop: '3rem', paddingTop: '1rem', borderTop: '1px solid #eee', color: '#999', fontSize: '0.85rem', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <span>ModuleWarden v0.1.0 — Auto-refreshes every {REFRESH_INTERVAL / 1000}s</span>
        <span>
          API: {apiConnected === null ? (
            <span style={{ color: '#999' }}>Checking...</span>
          ) : apiConnected ? (
            <span style={{ color: '#2e7d32' }}>Connected</span>
          ) : (
            <span style={{ color: '#c62828' }}>Disconnected</span>
          )}
        </span>
      </footer>
    </div>
    </>
  );
}

// Retain QueuePage for navigation, now shows the queue stats table
function QueuePage({ adminToken }: { adminToken: string }) {
  const [stats, setStats] = useState<QueueStat[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function doFetch() {
      try {
        const resp = await adminFetch(`${API_BASE}/admin/queue-stats`, adminToken);
        if (resp.ok) setStats(await resp.json() as QueueStat[]);
      } catch { /* */ }
      setLoading(false);
    }
    void doFetch();
    const interval = setInterval(() => void doFetch(), REFRESH_INTERVAL);
    return () => clearInterval(interval);
  }, [adminToken]);

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
