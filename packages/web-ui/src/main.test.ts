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

  // ── Prompts Page (AC #11) ─────────────────────────────────

  it('has PromptsPage with fetch to /admin/prompts', () => {
    const source = readFileSync('src/main.tsx', 'utf-8');
    expect(source).toContain('PromptsPage');
    expect(source).toContain('/admin/prompts');
    expect(source).toContain('Core Prompts');
    expect(source).toContain('Custom Prompts');
    expect(source).toContain('Prompt Packs');
  });

  it('PromptsPage has loading, error, and empty states', () => {
    const source = readFileSync('src/main.tsx', 'utf-8');
    expect(source).toContain('Loading prompts');
    expect(source).toContain('Unable to load prompts');
    expect(source).toContain('No prompt packs found');
  });

  // ── Campaigns Page (AC #15) ─────────────────────────────

  it('has CampaignsPage with fetch to /admin/campaigns', () => {
    const source = readFileSync('src/main.tsx', 'utf-8');
    expect(source).toContain('CampaignsPage');
    expect(source).toContain('/admin/campaigns');
    expect(source).toContain('Re-Audit Campaigns');
    expect(source).toContain('campaignStatusColor');
    expect(source).toContain('triggerType');
  });

  it('CampaignsPage has loading, error, and empty states', () => {
    const source = readFileSync('src/main.tsx', 'utf-8');
    expect(source).toContain('Loading campaigns');
    expect(source).toContain('Unable to load campaigns');
    expect(source).toContain('No re-audit campaigns found');
    expect(source).toContain('COMPLETED');
    expect(source).toContain('RUNNING');
    expect(source).toContain('PENDING');
    expect(source).toContain('CANCELLED');
  });

  // ── Evaluation Page (AC #16) ────────────────────────────

  it('has EvaluationPage with fetch to /admin/evaluation', () => {
    const source = readFileSync('src/main.tsx', 'utf-8');
    expect(source).toContain('EvaluationPage');
    expect(source).toContain('/admin/evaluation');
    expect(source).toContain('Evaluation Results');
  });

  it('EvaluationPage has loading, error, and empty states', () => {
    const source = readFileSync('src/main.tsx', 'utf-8');
    expect(source).toContain('Loading evaluation data');
    expect(source).toContain('Unable to load evaluation results');
    expect(source).toContain('No evaluation results available');
  });

  // ── Nav tabs (AC #11, #15, #16) ─────────────────────────

  it('has Prompts, Campaigns, Evaluation nav tabs', () => {
    const source = readFileSync('src/main.tsx', 'utf-8');
    expect(source).toContain("key: 'prompts'");
    expect(source).toContain("key: 'campaigns'");
    expect(source).toContain("key: 'evaluation'");
    expect(source).toContain("label: 'Prompts'");
    expect(source).toContain("label: 'Campaigns'");
    expect(source).toContain("label: 'Evaluation'");
  });

  // ── Evidence redaction notice (AC #17) ─────────────────

  it('shows redaction notice in evidence content viewer', () => {
    const source = readFileSync('src/main.tsx', 'utf-8');
    expect(source).toContain('redacted from this view');
    expect(source).toContain('prompts, secrets, tokens, API keys');
  });

  // ── API connectivity in footer (AC #18) ─────────────────

  it('checks API availability on mount with /health', () => {
    const source = readFileSync('src/main.tsx', 'utf-8');
    expect(source).toContain('/health');
    expect(source).toContain('apiConnected');
    expect(source).toContain('Connected');
    expect(source).toContain('Disconnected');
  });

  // ── Dashboard API endpoint tests ───────────────────────

  it('dashboard.ts has prompts, evaluation endpoints', () => {
    const dashboardSource = readFileSync('../api-proxy/src/routes/dashboard.ts', 'utf-8');
    expect(dashboardSource).toContain('/admin/prompts');
    expect(dashboardSource).toContain('promptPack.findMany');
    expect(dashboardSource).toContain('/admin/evaluation');
    expect(dashboardSource).toContain('EVALUATION_RESULT');
  });

  it('dashboard.ts has campaigns endpoint', () => {
    const dashboardSource = readFileSync('../api-proxy/src/routes/dashboard.ts', 'utf-8');
    expect(dashboardSource).toContain('/admin/campaigns');
    expect(dashboardSource).toContain('reAuditCampaign.findMany');
  });
});
