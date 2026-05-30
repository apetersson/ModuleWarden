// ── SybillionClient tests (nock-based) ───────────────────────────

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { SybillionClient } from '../sybillion-client.js';
import { SybillionError } from '../types.js';
import type { ForecastRequestV1 } from '../types.js';

const BASE_URL = 'https://api.sybilion.dev';
const TOKEN = 'test-token-12345';

function makeClient(overrides: Partial<{ pollIntervalMs: number; timeoutMs: number }> = {}): SybillionClient {
  return new SybillionClient({
    baseUrl: BASE_URL,
    token: TOKEN,
    timeoutMs: overrides.timeoutMs ?? 5000,
    pollIntervalMs: overrides.pollIntervalMs ?? 100,
  });
}

function makeForecastRequest(pkgName = 'test-pkg'): ForecastRequestV1 {
  return {
    pipeline_version: 'v1',
    frequency: 'monthly',
    soft_horizon: 3,
    hard_horizon: 1,
    recency_factor: 0.5,
    strictly_positive: true,
    timeseries_metadata: {
      title: `Monthly commits for ${pkgName}`,
      keywords: ['open source', 'git commits'],
    },
    timeseries: Object.fromEntries(
      Array.from({ length: 40 }, (_, i) => [`2022-${String(i + 1).padStart(2, '0')}-01`, i + 1]),
    ),
  };
}

// ── Error class ───────────────────────────────────────────────────

describe('SybillionError', () => {
  it('preserves statusCode and code', () => {
    const err = new SybillionError('Insufficient balance', 402, 'insufficient_balance');
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(SybillionError);
    expect(err.name).toBe('SybillionError');
    expect(err.message).toBe('Insufficient balance');
    expect(err.statusCode).toBe(402);
    expect(err.code).toBe('insufficient_balance');
  });

  it('handles validation details', () => {
    const details = [{ field: 'soft_horizon', message: 'must be between 1 and 12' }];
    const err = new SybillionError('Validation failed', 422, 'validation_failed', details);
    expect(err.details).toEqual(details);
  });

  it('handles no details', () => {
    const err = new SybillionError('Not found', 404);
    expect(err.details).toBeUndefined();
    expect(err.code).toBeUndefined();
  });
});

// ── submitForecast ────────────────────────────────────────────────

describe('SybillionClient.submitForecast', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('returns job_id and poll_url on 202', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      status: 202,
      ok: true,
      json: () => Promise.resolve({
        job_id: 'abc-123',
        poll_url: '/api/v1/forecasts/abc-123',
      }),
    });
    vi.stubGlobal('fetch', mockFetch);

    const client = makeClient();
    const result = await client.submitForecast(makeForecastRequest());

    expect(result.job_id).toBe('abc-123');
    expect(result.poll_url).toBe('/api/v1/forecasts/abc-123');
    expect(mockFetch).toHaveBeenCalledTimes(1);
    const fetchCall = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(fetchCall[0]).toBe(`${BASE_URL}/api/v1/forecasts`);
    expect(fetchCall[1]?.method).toBe('POST');
    const fetchHeaders = fetchCall[1]?.headers as Record<string, string> | undefined;
    expect(fetchHeaders?.['Authorization']).toBe(`Bearer ${TOKEN}`);
    expect(fetchHeaders?.['Content-Type']).toBe('application/json');
  });

  it('throws SybillionError on 402 insufficient balance', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      status: 402,
      ok: false,
      statusText: 'Payment Required',
      json: () => Promise.resolve({ error: 'insufficient available credits for hold' }),
    });
    vi.stubGlobal('fetch', mockFetch);

    const client = makeClient();
    await expect(client.submitForecast(makeForecastRequest()))
      .rejects.toThrow(SybillionError);

    try {
      await client.submitForecast(makeForecastRequest());
    } catch (err) {
      expect(err).toBeInstanceOf(SybillionError);
      if (err instanceof SybillionError) {
        expect(err.statusCode).toBe(402);
        expect(err.code).toBe('insufficient_balance');
      }
    }
  });

  it('throws SybillionError on 422 validation failure', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      status: 422,
      ok: false,
      statusText: 'Unprocessable Entity',
      json: () => Promise.resolve({
        error: 'validation_failed',
        details: [{ field: 'soft_horizon', message: 'must be between 1 and 12' }],
      }),
    });
    vi.stubGlobal('fetch', mockFetch);

    const client = makeClient();
    try {
      await client.submitForecast(makeForecastRequest());
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(SybillionError);
      if (err instanceof SybillionError) {
        expect(err.statusCode).toBe(422);
        expect(err.code).toBe('validation_failed');
        expect(err.details).toHaveLength(1);
        expect(err.details![0]!.field).toBe('soft_horizon');
      }
    }
  });

  it('throws SybillionError on 429 rate limited', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      status: 429,
      ok: false,
      statusText: 'Too Many Requests',
      json: () => Promise.resolve({ error: 'rate limit exceeded' }),
    });
    vi.stubGlobal('fetch', mockFetch);

    const client = makeClient();
    try {
      await client.submitForecast(makeForecastRequest());
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(SybillionError);
      if (err instanceof SybillionError) {
        expect(err.statusCode).toBe(429);
        expect(err.code).toBe('rate_limited');
      }
    }
  });
});

// ── getJobStatus ──────────────────────────────────────────────────

describe('SybillionClient.getJobStatus', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('returns job status on 200 completed', async () => {
    const statusResponse = {
      job_id: 'abc-123',
      pipeline_type: 'forecast',
      status: 'completed',
      created_at: '2026-05-30T10:00:00Z',
      settled_at: '2026-05-30T10:05:00Z',
      settled: true,
      eur_cents_final: 5,
      artifacts: [
        { name: 'forecast.json', size: 4096, content_type: 'application/json', href: '/api/v1/forecasts/abc-123/artifacts/forecast.json' },
      ],
    };

    const mockFetch = vi.fn().mockResolvedValue({
      status: 200,
      ok: true,
      json: () => Promise.resolve(statusResponse),
    });
    vi.stubGlobal('fetch', mockFetch);

    const client = makeClient();
    const result = await client.getJobStatus('abc-123');

    expect(result.status).toBe('completed');
    expect(result.job_id).toBe('abc-123');
    expect(result.settled).toBe(true);
    expect(result.eur_cents_final).toBe(5);
    expect(result.artifacts).toHaveLength(1);
  });

  it('throws SybillionError on 404 not found', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      status: 404,
      ok: false,
      statusText: 'Not Found',
      json: () => Promise.resolve({}),
    });
    vi.stubGlobal('fetch', mockFetch);

    const client = makeClient();
    try {
      await client.getJobStatus('non-existent');
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(SybillionError);
      if (err instanceof SybillionError) {
        expect(err.statusCode).toBe(404);
      }
    }
  });
});

// ── downloadArtifact ──────────────────────────────────────────────

describe('SybillionClient.downloadArtifact', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('returns Buffer on 200', async () => {
    const content = JSON.stringify({ version: '1.1', data: { forecast_horizon: 3 } });
    const mockFetch = vi.fn().mockResolvedValue({
      status: 200,
      ok: true,
      arrayBuffer: () => Promise.resolve(new TextEncoder().encode(content).buffer),
    });
    vi.stubGlobal('fetch', mockFetch);

    const client = makeClient();
    const result = await client.downloadArtifact('abc-123', 'forecast.json');

    expect(result).toBeInstanceOf(Buffer);
    expect(JSON.parse(result.toString())).toEqual({ version: '1.1', data: { forecast_horizon: 3 } });
  });

  it('throws SybillionError on 409 not completed', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      status: 409,
      ok: false,
      statusText: 'Conflict',
      json: () => Promise.resolve({}),
    });
    vi.stubGlobal('fetch', mockFetch);

    const client = makeClient();
    try {
      await client.downloadArtifact('abc-123', 'forecast.json');
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(SybillionError);
      if (err instanceof SybillionError) {
        expect(err.statusCode).toBe(409);
      }
    }
  });
});

// ── Constructor ───────────────────────────────────────────────────

describe('SybillionClient constructor', () => {
  it('has pollIntervalMs set during construction', () => {
    const client = makeClient({ pollIntervalMs: 5000 });
    expect(client.pollIntervalMs).toBe(5000);
  });

  it('default pollIntervalMs', () => {
    const client = makeClient();
    expect(client.pollIntervalMs).toBe(100);
  });
});
