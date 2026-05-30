// ── ForecastSubmitter tests ───────────────────────────────────────

import { describe, it, expect } from 'vitest';
import { ForecastSubmitter } from '../forecast-submitter.js';

/** Build a valid monthly series with count points ending in the current month. */
function makeValidSeries(count = 40): Record<string, number> {
  const now = new Date();
  const currentYear = now.getUTCFullYear();
  const currentMonth = now.getUTCMonth() + 1; // 1-indexed
  const startOffset = count - 1; // months before current

  const series: Record<string, number> = {};
  for (let i = 0; i < count; i++) {
    const offsetFromNow = startOffset - i;
    const totalMonths = currentYear * 12 + currentMonth - 1 - offsetFromNow;
    const year = Math.floor(totalMonths / 12);
    const month = (totalMonths % 12) + 1;
    const key = `${year}-${String(month).padStart(2, '0')}-01`;
    series[key] = i + 1;
  }
  return series;
}



describe('ForecastSubmitter', () => {
  const submitter = new ForecastSubmitter();

  it('builds a valid request for commits metric', () => {
    const series = makeValidSeries();
    const request = submitter.buildRequest('react', 'commits', series);

    expect(request.pipeline_version).toBe('v1');
    expect(request.frequency).toBe('monthly');
    expect(request.soft_horizon).toBe(3);
    expect(request.hard_horizon).toBe(1);
    expect(request.backtest).toBe(false);
    expect(request.strictly_positive).toBe(true);
    expect(request.recency_factor).toBe(0.5);
    expect(request.timeseries_metadata.title).toContain('react');
    expect(request.timeseries_metadata.title).toContain('commit');
    expect(request.timeseries_metadata.keywords).toBeDefined();
    expect(request.timeseries_metadata.keywords!.length).toBeGreaterThan(0);
    expect(request.timeseries).toEqual(series);
  });

  it('builds a valid request for contributors metric', () => {
    const series = makeValidSeries();
    const request = submitter.buildRequest('lodash', 'contributors', series);

    expect(request.timeseries_metadata.title).toContain('lodash');
    expect(request.timeseries_metadata.title).toContain('contributor');
  });

  it('builds a valid request for code_quality metric', () => {
    const series = makeValidSeries();
    const request = submitter.buildRequest('express', 'code_quality', series);

    expect(request.timeseries_metadata.title).toContain('express');
    expect(request.timeseries_metadata.keywords!.some((k) => k.includes('integration'))).toBe(true);
  });

  it('builds a valid request for downloads metric', () => {
    const series = makeValidSeries();
    const request = submitter.buildRequest('axios', 'downloads', series);

    expect(request.timeseries_metadata.title).toContain('axios');
    expect(request.timeseries_metadata.keywords!.some((k) => k.includes('npm'))).toBe(true);
  });

  it('rejects invalid timeseries (too short)', () => {
    const series = { '2022-01-01': 1 };
    expect(() => submitter.buildRequest('pkg', 'commits', series)).toThrow(
      'Timeseries validation failed',
    );
  });

  it('applies custom soft/hard horizon', () => {
    const custom = new ForecastSubmitter({ softHorizon: 6, hardHorizon: 3 });
    const series = makeValidSeries(60); // need 60 for horizon 6
    const request = custom.buildRequest('pkg', 'commits', series);

    expect(request.soft_horizon).toBe(6);
    expect(request.hard_horizon).toBe(3);
  });

  it('respects custom recency factor', () => {
    const custom = new ForecastSubmitter({ recencyFactor: 0.8 });
    const series = makeValidSeries();
    const request = custom.buildRequest('pkg', 'commits', series);

    expect(request.recency_factor).toBe(0.8);
  });

  it('sets strictly_positive to false when configured', () => {
    const custom = new ForecastSubmitter({ strictlyPositive: false });
    const series = makeValidSeries();
    const request = custom.buildRequest('pkg', 'commits', series);

    expect(request.strictly_positive).toBe(false);
  });

  it('includes description with mean in metadata', () => {
    const custom = new ForecastSubmitter();
    const series = makeValidSeries(40);
    const request = custom.buildRequest('pkg', 'commits', series);
    expect(request.timeseries_metadata.description).toContain('Mean:');
  });
});
