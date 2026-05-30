// ── Time-series validation and formatting ────────────────────────
// Enforces Sybillion API constraints: YYYY-MM-01 alignment, no gaps,
// minimum length, finite values, recency, strictly_positive.

import type { Frequency, Timeseries } from './types.js';

/** Regex for YYYY-MM-01 (first day of month). */
const MONTHLY_KEY_RE = /^\d{4}-(?:0[1-9]|1[0-2])-01$/;

/** Check if a date string is a valid first-day-of-month. */
function isMonthlyKey(key: string): boolean {
  return MONTHLY_KEY_RE.test(key);
}

/** Parse YYYY-MM-01 into a numeric month index for gap checking. */
function monthIndex(key: string): number {
  const [y, m] = key.split('-') as [string, string];
  return parseInt(y, 10) * 12 + parseInt(m, 10) - 1;
}

/**
 * Validate a monthly time series for Sybillion submission.
 *
 * Checks:
 * 1. Non-empty
 * 2. All keys are YYYY-MM-01 aligned
 * 3. All values are finite
 * 4. No gaps in the monthly grid
 * 5. Meets minimum length for the given horizon
 * 6. Latest observation within past 12 months
 * 7. Optional strictly_positive check
 *
 * Returns validated series (sorted) or throws with a description.
 */
export function validateTimeseries(
  series: Timeseries,
  options: {
    frequency: Frequency;
    horizonMax: number;
    strictlyPositive?: boolean;
    now?: Date;
  },
): { sorted: Timeseries; errors: string[] } {
  const errors: string[] = [];
  const { horizonMax, strictlyPositive = false, now = new Date() } = options;

  // 1. Non-empty
  const entries = Object.entries(series);
  if (entries.length === 0) {
    errors.push('timeseries must be non-empty');
    return { sorted: {}, errors };
  }

  // 2. Keys must be YYYY-MM-01 aligned
  for (const [key] of entries) {
    if (!isMonthlyKey(key)) {
      errors.push(`timeseries key "${key}" is not aligned to first day of month (YYYY-MM-01)`);
    }
  }
  if (errors.length > 0) return { sorted: {}, errors };

  // 3. All values must be finite
  for (const [key, value] of entries) {
    if (!Number.isFinite(value)) {
      errors.push(`timeseries["${key}"] must be finite, got ${value}`);
    }
  }
  if (errors.length > 0) return { sorted: {}, errors };

  // 4. strictly_positive check
  if (strictlyPositive) {
    for (const [key, value] of entries) {
      if (value < 0) {
        errors.push(
          `timeseries["${key}"] must be >= 0 (strictly_positive is true), got ${value}`,
        );
        break; // fail-fast
      }
    }
  }
  if (errors.length > 0) return { sorted: {}, errors };

  // Sort by month index
  const sorted = Object.fromEntries(
    [...entries].sort((a, b) => monthIndex(a[0]) - monthIndex(b[0])),
  );

  const sortedKeys = Object.keys(sorted);

  // 5. No gaps in monthly grid
  for (let i = 1; i < sortedKeys.length; i++) {
    const prev = monthIndex(sortedKeys[i - 1]!);
    const curr = monthIndex(sortedKeys[i]!);
    if (curr - prev !== 1) {
      errors.push(
        `timeseries has a gap between ${sortedKeys[i - 1]} and ${sortedKeys[i]}`,
      );
      break; // fail-fast
    }
  }
  if (errors.length > 0) return { sorted, errors };

  // 6. Minimum length check
  const minPoints = horizonMax <= 3 ? 40 : horizonMax <= 6 ? 60 : 120;
  if (sortedKeys.length < minPoints) {
    errors.push(
      `timeseries has ${sortedKeys.length} points, need at least ${minPoints} for horizon ${horizonMax}`,
    );
    return { sorted, errors };
  }

  // 7. Recency: latest observation within past 12 months
  const latestKey = sortedKeys[sortedKeys.length - 1]!;
  const latestDate = new Date(latestKey + 'T00:00:00Z');
  const twelveMonthsAgo = new Date(now);
  twelveMonthsAgo.setMonth(twelveMonthsAgo.getMonth() - 12);

  if (latestDate < twelveMonthsAgo) {
    errors.push(
      `timeseries latest observation ${latestKey} is older than 12 months from now`,
    );
  }

  return { sorted, errors };
}

/**
 * Compute the mean of a time series values.
 */
export function seriesMean(series: Timeseries): number {
  const values = Object.values(series);
  if (values.length === 0) return 0;
  const sum = values.reduce((a, b) => a + b, 0);
  return sum / values.length;
}

/**
 * Compute the Average Demand Interval (ADI) for intermittent-demand detection.
 * ADI = total_periods / non_zero_periods. Returns Infinity if all are zero.
 */
export function computeADI(series: Timeseries): number {
  const values = Object.values(series);
  const total = values.length;
  if (total === 0) return Infinity;

  const nonZero = values.filter((v) => v !== 0).length;
  if (nonZero === 0) return Infinity;

  return total / nonZero;
}
