// ── Time-series validation tests ──────────────────────────────────

import { describe, it, expect } from 'vitest';
import { validateTimeseries, seriesMean, computeADI } from '../time-series.js';

// ── validateTimeseries ────────────────────────────────────────────

describe('validateTimeseries', () => {
  const baseOpts = { frequency: 'monthly' as const, horizonMax: 3 };

  it('accepts a valid 40-point monthly series', () => {
    const now = new Date();
    const currentYear = now.getUTCFullYear();
    const currentMonth = now.getUTCMonth() + 1;
    const series: Record<string, number> = {};
    for (let i = 0; i < 40; i++) {
      const offsetFromNow = 39 - i; // 39..0 months before current
      const totalMonths = currentYear * 12 + currentMonth - 1 - offsetFromNow;
      const year = Math.floor(totalMonths / 12);
      const month = (totalMonths % 12) + 1;
      const key = `${year}-${String(month).padStart(2, '0')}-01`;
      series[key] = i;
    }
    const { errors } = validateTimeseries(series, baseOpts);
    expect(errors).toHaveLength(0);
  });

  it('rejects empty timeseries', () => {
    const { errors } = validateTimeseries({}, baseOpts);
    expect(errors).toContainEqual(expect.stringContaining('non-empty'));
  });

  it('rejects misaligned keys (not first of month)', () => {
    const { errors } = validateTimeseries({ '2022-01-15': 5 }, baseOpts);
    expect(errors).toContainEqual(expect.stringContaining('not aligned'));
  });

  it('rejects NaN values', () => {
    const { errors } = validateTimeseries({ '2022-01-01': NaN }, baseOpts);
    expect(errors).toContainEqual(expect.stringContaining('must be finite'));
  });

  it('rejects Infinity values', () => {
    const { errors } = validateTimeseries({ '2022-01-01': Infinity }, baseOpts);
    expect(errors).toContainEqual(expect.stringContaining('must be finite'));
  });

  it('rejects gaps in the monthly grid', () => {
    const { errors } = validateTimeseries(
      {
        '2022-01-01': 1,
        '2022-02-01': 2,
        '2022-04-01': 4, // gap: March missing
      },
      baseOpts,
    );
    expect(errors).toContainEqual(expect.stringContaining('gap'));
  });

  it('rejects too-short series for horizon 3 (needs 40)', () => {
    const series: Record<string, number> = {};
    for (let i = 0; i < 10; i++) {
      const key = `2022-${String(i + 1).padStart(2, '0')}-01`;
      series[key] = i;
    }
    const { errors } = validateTimeseries(series, baseOpts);
    expect(errors).toContainEqual(expect.stringContaining('need at least 40'));
  });

  it('rejects negative values when strictlyPositive is true', () => {
    const series: Record<string, number> = { '2022-01-01': -5 };
    const { errors } = validateTimeseries(series, {
      ...baseOpts,
      strictlyPositive: true,
    });
    expect(errors).toContainEqual(expect.stringContaining('must be >= 0'));
  });

  it('allows zero values when strictlyPositive is true', () => {
    const series: Record<string, number> = { '2022-01-01': 0, '2022-02-01': 0 };
    const { errors } = validateTimeseries(series, {
      ...baseOpts,
      strictlyPositive: true,
    });
    // Length will fail (need 40), but no strictly_positive error.
    expect(errors.find((e) => e.includes('must be >= 0'))).toBeUndefined();
  });

  it('rejects stale data (latest > 12 months ago)', () => {
    const now = new Date('2026-06-01');
    const series: Record<string, number> = {};
    for (let i = 0; i < 40; i++) {
      const year = 2020 + Math.floor(i / 12);
      const month = (i % 12) + 1;
      const key = `${year}-${String(month).padStart(2, '0')}-01`;
      series[key] = i;
    }
    const { errors } = validateTimeseries(series, { ...baseOpts, now });
    expect(errors).toContainEqual(expect.stringContaining('older than 12 months'));
  });

  it('accepts a series with latest within 12 months', () => {
    const now = new Date('2026-06-01');
    const series: Record<string, number> = {};
    for (let i = 0; i < 40; i++) {
      const year = 2023 + Math.floor(i / 12);
      const month = (i % 12) + 1;
      const key = `${year}-${String(month).padStart(2, '0')}-01`;
      series[key] = i;
    }
    const { errors } = validateTimeseries(series, { ...baseOpts, now });
    expect(errors).toHaveLength(0);
  });

  it('returns sorted keys in chronological order', () => {
    const series = {
      '2022-03-01': 3,
      '2022-01-01': 1,
      '2022-02-01': 2,
    };
    // Will fail on min length but we test sorting anyway
    const { sorted } = validateTimeseries(series, baseOpts);
    const keys = Object.keys(sorted);
    // Only check the keys that were in the input (min-length check would fail)
    expect(keys.slice(0, 3)).toEqual(['2022-01-01', '2022-02-01', '2022-03-01']);
  });
});

// ── seriesMean ─────────────────────────────────────────────────────

describe('seriesMean', () => {
  it('computes mean of non-empty series', () => {
    expect(seriesMean({ '2022-01-01': 1, '2022-02-01': 2, '2022-03-01': 3 })).toBe(2);
  });

  it('returns 0 for empty series', () => {
    expect(seriesMean({})).toBe(0);
  });

  it('handles all-zero series', () => {
    expect(seriesMean({ '2022-01-01': 0, '2022-02-01': 0 })).toBe(0);
  });
});

// ── computeADI ────────────────────────────────────────────────────

describe('computeADI', () => {
  it('returns 1.0 for all-non-zero series', () => {
    expect(computeADI({ '2022-01-01': 5, '2022-02-01': 10 })).toBe(1);
  });

  it('returns Infinity for all-zero series', () => {
    expect(computeADI({ '2022-01-01': 0, '2022-02-01': 0 })).toBe(Infinity);
  });

  it('returns Infinity for empty series', () => {
    expect(computeADI({})).toBe(Infinity);
  });

  it('computes ADI for mixed series', () => {
    // 4 periods, 2 non-zero => ADI = 4/2 = 2
    expect(
      computeADI({
        '2022-01-01': 0,
        '2022-02-01': 5,
        '2022-03-01': 0,
        '2022-04-01': 10,
      }),
    ).toBe(2);
  });
});
