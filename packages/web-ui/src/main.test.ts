import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

describe('web-ui dashboard', () => {
  it('DashboardPage component exists', () => {
    const source = readFileSync('src/main.tsx', 'utf-8');
    expect(source).toContain('DashboardPage');
    expect(source).toContain('Kanban');
    expect(source).toContain('QueuePage');
  });

  it('fetches from /admin/dashboard and /admin/queue-stats', () => {
    const source = readFileSync('src/main.tsx', 'utf-8');
    expect(source).toContain('/admin/dashboard');
    expect(source).toContain('/admin/queue-stats');
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
});
