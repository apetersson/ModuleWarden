// ── Git metric extraction service ────────────────────────────────
// Runs git log analysis on a shallow clone and stores monthly
// commit counts, contributor counts, and code-quality signals
// in the GitMetricCache table.

import { execSync } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { getPrisma } from '@modulewarden/prisma-client';
import { logger } from '@modulewarden/shared/services/logger';

export interface GitMetricResult {
  packageName: string;
  packageVersion: string;
  repoUrl: string | null;
  commitCount: number;
}

const MAX_CLONE_SECONDS = 120;
const MAX_LOG_SECONDS = 60;

/**
 * Extract monthly commit counts, contributor counts, and code-quality
 * signals from a git repository and persist to GitMetricCache.
 *
 * Uses shallow clone for speed. Handles missing repos gracefully.
 */
export class GitMetricExtractor {
  /**
   * Extract and cache all git metrics for a package version.
   * Skips if already cached.
   */
  async extractIfNeeded(
    packageName: string,
    packageVersion: string,
    repoUrl: string | null,
  ): Promise<GitMetricResult> {
    const prisma = getPrisma();

    // Check if already cached
    const existing = await prisma.gitMetricCache.findFirst({
      where: { packageName, packageVersion },
      select: { id: true, commitCount: true, repoUrl: true },
    });

    if (existing) {
      logger.info('Git metrics already cached', { packageName, packageVersion });
      return {
        packageName,
        packageVersion,
        repoUrl: existing.repoUrl,
        commitCount: existing.commitCount ?? 0,
      };
    }

    if (!repoUrl) {
      logger.info('No repo URL available, skipping git extraction', { packageName, packageVersion });
      return { packageName, packageVersion, repoUrl: null, commitCount: 0 };
    }

    const normalizedUrl = this._normalizeRepoUrl(repoUrl);
    if (!normalizedUrl) {
      logger.info('Could not normalize repo URL', { packageName, repoUrl });
      return { packageName, packageVersion, repoUrl: null, commitCount: 0 };
    }

    logger.info('Extracting git metrics', { packageName, packageVersion, repoUrl: normalizedUrl });

    let cloneDir: string | undefined;
    try {
      cloneDir = this._shallowClone(normalizedUrl);

      const commitsSeries = this._extractMonthlyCounts(cloneDir, 'commits');
      const contributorsSeries = this._extractMonthlyContributors(cloneDir);
      const qualitySeries = this._extractQualitySignals(cloneDir);

      const totalCommits = Object.values(commitsSeries).reduce((a, b) => a + b, 0);

      // Store all three metric types
      await prisma.gitMetricCache.createMany({
        data: [
          {
            packageName,
            packageVersion,
            metricType: 'commits',
            timeseries: commitsSeries,
            repoUrl: normalizedUrl,
            commitCount: totalCommits,
          },
          {
            packageName,
            packageVersion,
            metricType: 'contributors',
            timeseries: contributorsSeries,
            repoUrl: normalizedUrl,
            commitCount: totalCommits,
          },
          {
            packageName,
            packageVersion,
            metricType: 'code_quality',
            timeseries: qualitySeries,
            repoUrl: normalizedUrl,
            commitCount: totalCommits,
          },
        ],
        skipDuplicates: true,
      });

      logger.info('Git metrics cached', {
        packageName,
        packageVersion,
        totalCommits,
        monthsCommitted: Object.keys(commitsSeries).length,
        monthsContributors: Object.keys(contributorsSeries).length,
        monthsQuality: Object.keys(qualitySeries).length,
      });

      return {
        packageName,
        packageVersion,
        repoUrl: normalizedUrl,
        commitCount: totalCommits,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.warn('Git extraction failed (best-effort)', { packageName, packageVersion, error: message });
      return { packageName, packageVersion, repoUrl: normalizedUrl, commitCount: 0 };
    } finally {
      if (cloneDir) {
        try { rmSync(cloneDir, { recursive: true, force: true }); } catch { /* best-effort */ }
      }
    }
  }

  /** Clone a repo shallowly for fast log analysis. */
  private _shallowClone(repoUrl: string): string {
    const dir = mkdtempSync(join(tmpdir(), 'mw-git-'));
    try {
      execSync(
        `git clone --depth 1 --single-branch --no-tags "${repoUrl}" "${dir}"`,
        {
          encoding: 'utf-8',
          stdio: 'pipe',
          timeout: MAX_CLONE_SECONDS * 1000,
          maxBuffer: 10 * 1024 * 1024,
        },
      );
    } catch (err) {
      // Try fallback: clone with --no-checkout for speed
      try {
        rmSync(dir, { recursive: true, force: true });
        const fallbackDir = mkdtempSync(join(tmpdir(), 'mw-git-'));
        execSync(
          `git clone --depth 1 --single-branch --no-tags --no-checkout "${repoUrl}" "${fallbackDir}"`,
          { encoding: 'utf-8', stdio: 'pipe', timeout: MAX_CLONE_SECONDS * 1000 },
        );
        return fallbackDir;
      } catch {
        rmSync(dir, { recursive: true, force: true });
        throw err;
      }
    }
    return dir;
  }

  /**
   * Count commits per month from git log.
   * Returns { "YYYY-MM-01": count, ... } from earliest to latest month.
   */
  private _extractMonthlyCounts(
    cloneDir: string,
    _metric: string,
  ): Record<string, number> {
    const result: Record<string, number> = {};

    try {
      const output = execSync(
        `git -C "${cloneDir}" log --format="%ad" --date=format:"%Y-%m"`,
        { encoding: 'utf-8', stdio: 'pipe', timeout: MAX_LOG_SECONDS * 1000 },
      );

      const lines = output.trim().split('\n').filter(Boolean);

      for (const line of lines) {
        const key = line.trim() + '-01'; // "2023-05" → "2023-05-01"
        if (/^\d{4}-\d{2}-01$/.test(key)) {
          result[key] = (result[key] ?? 0) + 1;
        }
      }

      // Fill gaps with 0 so the series has no holes
      return this._fillGaps(result);
    } catch {
      return {};
    }
  }

  /**
   * Count unique contributors per month.
   */
  private _extractMonthlyContributors(
    cloneDir: string,
  ): Record<string, number> {
    const monthly: Record<string, Set<string>> = {};

    try {
      const output = execSync(
        `git -C "${cloneDir}" log --format="%ad %aE" --date=format:"%Y-%m"`,
        { encoding: 'utf-8', stdio: 'pipe', timeout: MAX_LOG_SECONDS * 1000 },
      );

      const lines = output.trim().split('\n').filter(Boolean);

      for (const line of lines) {
        const parts = line.split(' ');
        const month = parts[0]?.trim();
        const email = parts.slice(1).join(' ').trim();

        if (month && /^\d{4}-\d{2}$/.test(month) && email) {
          const key = month + '-01';
          if (!monthly[key]) monthly[key] = new Set();
          monthly[key]!.add(email);
        }
      }

      const result: Record<string, number> = {};
      for (const [key, set] of Object.entries(monthly)) {
        result[key] = set.size;
      }

      return this._fillGaps(result);
    } catch {
      return {};
    }
  }

  /**
   * Check for presence of CI, linter, and test files at the repo root.
   * Returns a single series where each month's value is a fraction (0-1)
   * of quality signals present.
   *
   * Since we shallow-clone only HEAD, we report a constant series.
   * For full historical quality tracking, a deeper clone would be needed.
   */
  private _extractQualitySignals(cloneDir: string): Record<string, number> {
    const signals: boolean[] = [];

    // CI: .github/workflows/*.yml, .circleci/, .travis.yml, etc.
    signals.push(
      existsSync(join(cloneDir, '.github', 'workflows')) ||
      existsSync(join(cloneDir, '.circleci')) ||
      existsSync(join(cloneDir, '.travis.yml')) ||
      existsSync(join(cloneDir, 'Jenkinsfile')),
    );

    // Linting: .eslintrc*, .prettierrc*, etc.
    signals.push(
      existsSync(join(cloneDir, '.eslintrc.js')) ||
      existsSync(join(cloneDir, '.eslintrc.cjs')) ||
      existsSync(join(cloneDir, '.eslintrc.json')) ||
      existsSync(join(cloneDir, '.eslintrc.yaml')) ||
      existsSync(join(cloneDir, '.eslintrc.yml')) ||
      existsSync(join(cloneDir, 'eslint.config.js')) ||
      existsSync(join(cloneDir, 'eslint.config.mjs')) ||
      existsSync(join(cloneDir, '.prettierrc')) ||
      existsSync(join(cloneDir, '.prettierrc.json')),
    );

    // Testing: __tests__/, *.test.*, *.spec.*, jest.config.*
    signals.push(
      existsSync(join(cloneDir, '__tests__')) ||
      existsSync(join(cloneDir, 'test')) ||
      existsSync(join(cloneDir, 'tests')) ||
      existsSync(join(cloneDir, 'jest.config.js')) ||
      existsSync(join(cloneDir, 'vitest.config.ts')),
    );

    const fraction = signals.filter(Boolean).length / signals.length;

    // Build a minimal series: latest 40 months at the same value.
    // This is a known limitation of shallow cloning.
    const series: Record<string, number> = {};
    const now = new Date();
    for (let i = 0; i < 40; i++) {
      const d = new Date(now);
      d.setMonth(d.getMonth() - i);
      const key = d.toISOString().slice(0, 7) + '-01';
      series[key] = Math.round(fraction * 100) / 100;
    }

    return series;
  }

  /** Fill gaps between min and max month with 0 values. */
  private _fillGaps(series: Record<string, number>): Record<string, number> {
    const keys = Object.keys(series).sort();
    if (keys.length < 2) return series;

    const first = keys[0]!;
    const last = keys[keys.length - 1]!;

    const start = new Date(first + 'T00:00:00Z');
    const end = new Date(last + 'T00:00:00Z');

    const filled: Record<string, number> = {};
    const cursor = new Date(start);

    while (cursor <= end) {
      const key = cursor.toISOString().slice(0, 7) + '-01';
      filled[key] = series[key] ?? 0;
      cursor.setMonth(cursor.getMonth() + 1);
    }

    return filled;
  }

  /** Normalize a repo URL to a clonable git URL. */
  private _normalizeRepoUrl(url: string): string | null {
    if (!url) return null;

    // Handle git+https://, git://, etc.
    let cleaned = url.replace(/^git\+/, '').replace(/\.git$/, '');

    // Handle GitHub shorthand: "owner/repo"
    if (/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/.test(cleaned)) {
      cleaned = `https://github.com/${cleaned}`;
    }

    try {
      new URL(cleaned);
      return cleaned + '.git';
    } catch {
      return null;
    }
  }
}
