import React, { useState, useEffect, useCallback } from 'react';
import { createRoot } from 'react-dom/client';

const API_BASE = '';
const REFRESH_INTERVAL = 10_000;

// ── Types ─────────────────────────────────────────────────

interface PackageStatus {
  packageName: string;
  version: string;
  verdict?: string;
  status: string;
  updatedAt: string;
}

interface QueueStats {
  queue: string;
  count: number;
  running: number;
  completed: number;
  failed: number;
}

// ── Helpers ───────────────────────────────────────────────

function statusColor(verdict?: string): string {
  switch (verdict) {
    case 'ALLOW': return '#2e7d32';
    case 'BLOCK': return '#c62828';
    case 'QUARANTINE': return '#f57f17';
    default: return '#757575';
  }
}

function timeAgo(date: string): string {
  const ms = Date.now() - new Date(date).getTime();
  const sec = Math.floor(ms / 1000);
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  return `${hr}h ago`;
}

// ── Status Page ───────────────────────────────────────────

function StatusPage() {
  const [packages, setPackages] = useState<PackageStatus[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<string>('');

  const fetchStatus = useCallback(async () => {
    try {
      // Fetch all package statuses via the explain endpoint listing
      // (In v1, this uses the status route for individual packages.
      // A bulk status endpoint can be added in a later iteration.)
      try {
        const resp = await fetch(`${API_BASE}/health`);
        if (resp.ok) {
          setPackages([]); // No bulk status endpoint yet
        }
      } catch { /* */ }
      }
    } catch { /* server may not be running */ }
    setLoading(false);
  }, []);

  useEffect(() => {
    fetchStatus();
    const interval = setInterval(fetchStatus, REFRESH_INTERVAL);
    return () => clearInterval(interval);
  }, [fetchStatus]);

  const filtered = filter
    ? packages.filter((p) =>
        p.packageName.toLowerCase().includes(filter.toLowerCase()) ||
        p.version.includes(filter)
      )
    : packages;

  return (
    <div>
      <div style={{ display: 'flex', gap: '1rem', alignItems: 'center', marginBottom: '1rem' }}>
        <h2 style={{ margin: 0 }}>Package Status</h2>
        <input
          type="text"
          placeholder="Filter by name or version..."
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          style={{ padding: '0.5rem', flex: 1, maxWidth: 400, borderRadius: 4, border: '1px solid #ccc' }}
        />
        <span style={{ color: '#666', fontSize: '0.9rem' }}>{packages.length} packages</span>
      </div>

      {loading ? (
        <p>Loading...</p>
      ) : filtered.length === 0 ? (
        <p style={{ color: '#666' }}>No packages found. Run <code>modulewarden preflight</code> to import packages.</p>
      ) : (
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead>
            <tr style={{ textAlign: 'left', borderBottom: '2px solid #ddd' }}>
              <th style={{ padding: '0.5rem' }}>Package</th>
              <th style={{ padding: '0.5rem' }}>Version</th>
              <th style={{ padding: '0.5rem' }}>Verdict</th>
              <th style={{ padding: '0.5rem' }}>Status</th>
              <th style={{ padding: '0.5rem' }}>Updated</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((pkg, i) => (
              <tr key={`${pkg.packageName}@${pkg.version}`} style={{ borderBottom: '1px solid #eee' }}>
                <td style={{ padding: '0.5rem', fontFamily: 'monospace' }}>{pkg.packageName}</td>
                <td style={{ padding: '0.5rem' }}>{pkg.version}</td>
                <td style={{ padding: '0.5rem' }}>
                  {pkg.verdict ? (
                    <span style={{
                      color: '#fff',
                      background: statusColor(pkg.verdict),
                      padding: '2px 8px',
                      borderRadius: 12,
                      fontSize: '0.85rem',
                      fontWeight: 600,
                    }}>
                      {pkg.verdict}
                    </span>
                  ) : (
                    <span style={{ color: '#999' }}>—</span>
                  )}
                </td>
                <td style={{ padding: '0.5rem' }}>{pkg.status}</td>
                <td style={{ padding: '0.5rem', color: '#666', fontSize: '0.9rem' }}>{timeAgo(pkg.updatedAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

// ── Queue Page ────────────────────────────────────────────

function QueuePage() {
  const [queues, setQueues] = useState<QueueStats[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function fetchQueues() {
      try {
        // Queue stats endpoint not yet implemented in v1
        // This will be wired when admin endpoints are expanded
        setQueues([]);
      } catch { /* */ }
      setLoading(false);
    }
    fetchQueues();
    const interval = setInterval(fetchQueues, REFRESH_INTERVAL);
    return () => clearInterval(interval);
  }, []);

  return (
    <div>
      <h2>Queue Status</h2>
      {loading ? (
        <p>Loading...</p>
      ) : queues.length === 0 ? (
        <p style={{ color: '#666' }}>No queue data available.</p>
      ) : (
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead>
            <tr style={{ textAlign: 'left', borderBottom: '2px solid #ddd' }}>
              <th style={{ padding: '0.5rem' }}>Queue</th>
              <th style={{ padding: '0.5rem' }}>Pending</th>
              <th style={{ padding: '0.5rem' }}>Running</th>
              <th style={{ padding: '0.5rem' }}>Completed</th>
              <th style={{ padding: '0.5rem' }}>Failed</th>
            </tr>
          </thead>
          <tbody>
            {queues.map((q) => (
              <tr key={q.queue} style={{ borderBottom: '1px solid #eee' }}>
                <td style={{ padding: '0.5rem', fontFamily: 'monospace' }}>{q.queue}</td>
                <td style={{ padding: '0.5rem' }}>{q.count}</td>
                <td style={{ padding: '0.5rem' }}>{q.running}</td>
                <td style={{ padding: '0.5rem' }}>{q.completed}</td>
                <td style={{ padding: '0.5rem', color: q.failed > 0 ? '#c62828' : 'inherit' }}>
                  {q.failed}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

// ── App ───────────────────────────────────────────────────

function App() {
  const [page, setPage] = useState<'status' | 'queue'>('status');

  return (
    <div style={{ fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif', maxWidth: 960, margin: '0 auto', padding: '1rem' }}>
      <header style={{ display: 'flex', alignItems: 'center', gap: '2rem', marginBottom: '2rem', borderBottom: '1px solid #ddd', paddingBottom: '1rem' }}>
        <h1 style={{ margin: 0, fontSize: '1.5rem' }}>ModuleWarden</h1>
        <nav style={{ display: 'flex', gap: '0.5rem' }}>
          <button
            onClick={() => setPage('status')}
            style={{
              padding: '0.5rem 1rem',
              border: 'none',
              borderRadius: 4,
              background: page === 'status' ? '#1976d2' : '#e0e0e0',
              color: page === 'status' ? '#fff' : '#333',
              cursor: 'pointer',
              fontWeight: page === 'status' ? 600 : 400,
            }}
          >
            Package Status
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

      {page === 'status' ? <StatusPage /> : <QueuePage />}

      <footer style={{ marginTop: '3rem', paddingTop: '1rem', borderTop: '1px solid #eee', color: '#999', fontSize: '0.85rem' }}>
        ModuleWarden v0.1.0 — Data refreshes every {REFRESH_INTERVAL / 1000}s
      </footer>
    </div>
  );
}

const root = document.getElementById('root');
if (root) {
  createRoot(root).render(<App />);
}

export default App;
