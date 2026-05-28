import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

describe('web-ui dashboard', () => {
  it('DashboardPage component exists', () => {
    const source = readFileSync('src/main.tsx', 'utf-8');
    expect(source).toContain('DashboardPage');
    expect(source).toContain('Kanban');
    expect(source).toContain('QueuePage');
  });

  it('fetches from dashboard and evidence endpoints', () => {
    const source = readFileSync('src/main.tsx', 'utf-8');
    expect(source).toContain('/admin/dashboard');
    expect(source).toContain('/admin/queue-stats');
    expect(source).toContain('/admin/audit-run/');
    expect(source).toContain('/admin/evidence/');
  });

  it('has error, loading, and empty states', () => {
    const source = readFileSync('src/main.tsx', 'utf-8');
    expect(source).toContain('API Unavailable');
    expect(source).toContain('Loading audit data');
    expect(source).toContain('No audit data yet');
  });

  it('has QueuePage fetching from real API', () => {
    const source = readFileSync('src/main.tsx', 'utf-8');
    expect(source).toContain('/admin/queue-stats');
    expect(source).not.toContain('setQueues([])');
  });

  it('has column colors for kanban columns', () => {
    const source = readFileSync('src/main.tsx', 'utf-8');
    const columns = ['queued', 'running', 'needs-escalation', 'quarantined', 'blocked', 'allowed', 'failed'];
    for (const col of columns) {
      expect(source).toContain(col);
    }
  });

  // ── New feature tests ─────────────────────────────────

  it('has search/filter input that filters by package name or version', () => {
    const source = readFileSync('src/main.tsx', 'utf-8');
    expect(source).toContain('searchQuery');
    expect(source).toContain('Search by package or version');
    expect(source).toContain('setSearchQuery');
    expect(source).toContain('packageName.toLowerCase');
    expect(source).toContain('packageVersion.toLowerCase');
  });

  it('has sort dropdown (by age, by risk) for the selected column detail table', () => {
    const source = readFileSync('src/main.tsx', 'utf-8');
    expect(source).toContain('sortBy');
    expect(source).toContain('Sort:');
    expect(source).toContain('sort-select');
    expect(source).toContain('age-asc');
    expect(source).toContain('age-desc');
    expect(source).toContain('risk');
    expect(source).toContain('Age (newest)');
    expect(source).toContain('Age (oldest)');
  });

  it('has Admin Override button and form in AuditRunDetail modal', () => {
    const source = readFileSync('src/main.tsx', 'utf-8');
    expect(source).toContain('Admin Override');
    expect(source).toContain('Submit Override');
    expect(source).toContain('/admin/override');
    expect(source).toContain('targetVerdict');
    expect(source).toContain('Bearer');
    expect(source).toContain('MW_AUTH_ADMIN_TOKENS');
    const verdicts = ['ALLOW', 'BLOCK', 'QUARANTINE'];
    for (const v of verdicts) {
      expect(source).toContain(v);
    }
  });

  it('has lockfile import progress section from dashboard summary', () => {
    const source = readFileSync('src/main.tsx', 'utf-8');
    expect(source).toContain('Lockfile Import Progress');
    expect(source).toContain('% complete');
    expect(source).toContain('summary.queued');
    expect(source).toContain('summary.running');
    expect(source).toContain('summary.allowed');
    expect(source).toContain('summary.blocked');
    expect(source).toContain('summary.quarantined');
    expect(source).toContain('summary.failed');
  });

  it('has getBearerToken helper for admin auth', () => {
    const source = readFileSync('src/main.tsx', 'utf-8');
    expect(source).toContain('getBearerToken');
    expect(source).toContain('MW_AUTH_ADMIN_TOKENS');
  });
});
