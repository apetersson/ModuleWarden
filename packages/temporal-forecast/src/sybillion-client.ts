// ── Sybillion API HTTP client ────────────────────────────────────
// Handles submit, poll, wait-for-completion, and artifact download.
// Uses Node 18+ built-in fetch. All errors surfaced as SybillionError.

import type {
  ForecastRequestV1,
  ForecastSubmitResponse,
  JobStatusResponse,
  SybillionClientConfig,
} from './types.js';
import { SybillionError } from './types.js';

export class SybillionClient {
  private readonly baseUrl: string;
  private readonly token: string;
  private readonly timeoutMs: number;
  readonly pollIntervalMs: number;

  constructor(config: SybillionClientConfig) {
    this.baseUrl = config.baseUrl.replace(/\/$/, '');
    this.token = config.token;
    this.timeoutMs = config.timeoutMs;
    this.pollIntervalMs = config.pollIntervalMs;
  }

  /** POST /api/v1/forecasts — submit an async forecast job. */
  async submitForecast(body: ForecastRequestV1): Promise<ForecastSubmitResponse> {
    const url = `${this.baseUrl}/api/v1/forecasts`;
    const response = await this._request('POST', url, body);

    if (response.status !== 202) {
      await this._handleErrorResponse(response);
    }

    const json = (await response.json()) as ForecastSubmitResponse;
    if (!json.job_id) {
      throw new SybillionError('Missing job_id in submit response', 502);
    }
    return json;
  }

  /** GET /api/v1/forecasts/:id — poll job status once. */
  async getJobStatus(jobId: string): Promise<JobStatusResponse> {
    const url = `${this.baseUrl}/api/v1/forecasts/${encodeURIComponent(jobId)}`;
    const response = await this._request('GET', url);

    if (response.status === 404) {
      throw new SybillionError(
        `Job ${jobId} not found or outside visibility window`,
        404,
      );
    }

    if (!response.ok) {
      await this._handleErrorResponse(response);
    }

    return (await response.json()) as JobStatusResponse;
  }

  /** Poll until the job reaches a terminal state, or timeout. */
  async waitForCompletion(
    jobId: string,
    timeoutMs?: number,
  ): Promise<JobStatusResponse> {
    const deadline = Date.now() + (timeoutMs ?? this.timeoutMs);
    const terminalStates = new Set(['completed', 'failed', 'canceled']);

    while (Date.now() < deadline) {
      const status = await this.getJobStatus(jobId);

      if (terminalStates.has(status.status)) {
        return status;
      }

      await this._sleep(this.pollIntervalMs);
    }

    throw new SybillionError(
      `Forecast job ${jobId} timed out waiting for completion`,
      504,
    );
  }

  /** GET /api/v1/forecasts/:id/artifacts/:name — download an artifact. */
  async downloadArtifact(jobId: string, artifactName: string): Promise<Buffer> {
    const url = `${this.baseUrl}/api/v1/forecasts/${encodeURIComponent(jobId)}/artifacts/${encodeURIComponent(artifactName)}`;
    const response = await this._request('GET', url);

    if (response.status === 404) {
      throw new SybillionError(
        `Artifact ${artifactName} not found for job ${jobId}`,
        404,
      );
    }

    if (response.status === 409) {
      throw new SybillionError(
        `Job ${jobId} has not completed yet`,
        409,
      );
    }

    if (!response.ok) {
      await this._handleErrorResponse(response);
    }

    const arrayBuffer = await response.arrayBuffer();
    return Buffer.from(arrayBuffer);
  }

  /** Internal fetch wrapper with timeout via AbortController. */
  private async _request(
    method: string,
    url: string,
    body?: unknown,
  ): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const headers: Record<string, string> = {
        Authorization: `Bearer ${this.token}`,
      };

      if (body !== undefined) {
        headers['Content-Type'] = 'application/json';
      }

      const init: RequestInit = {
        method,
        headers,
        signal: controller.signal,
      };
      if (body !== undefined) {
        init.body = JSON.stringify(body);
      }

      const response = await fetch(url, init);

      return response;
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') {
        throw new SybillionError(`Request timed out after ${this.timeoutMs}ms`, 504);
      }
      throw new SybillionError(
        `Network error: ${err instanceof Error ? err.message : String(err)}`,
        502,
      );
    } finally {
      clearTimeout(timer);
    }
  }

  /** Parse error responses and throw typed SybillionError. */
  private async _handleErrorResponse(response: Response): Promise<never> {
    let body: Record<string, unknown> = {};
    try {
      body = (await response.json()) as Record<string, unknown>;
    } catch {
      // Non-JSON error body, use status text.
    }

    const message = (body.error as string) ?? response.statusText;
    const details = body.details as Array<{ field: string; message: string }> | undefined;

    switch (response.status) {
      case 400:
        throw new SybillionError(message, 400, 'bad_request', details);
      case 401:
        throw new SybillionError(message, 401, 'unauthorized');
      case 402:
        throw new SybillionError(message, 402, 'insufficient_balance');
      case 413:
        throw new SybillionError(message, 413, 'payload_too_large');
      case 422:
        throw new SybillionError(message, 422, 'validation_failed', details);
      case 429:
        throw new SybillionError(message, 429, 'rate_limited');
      default:
        throw new SybillionError(message, response.status);
    }
  }

  private _sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
