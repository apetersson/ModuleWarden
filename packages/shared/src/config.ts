export interface ModuleWardenConfig {
  postgres: {
    host: string;
    port: number;
    database: string;
    user: string;
    password: string;
    schema: string;
  };
  verdaccio: {
    host: string;
    port: number;
    registryUrl: string;
  };
  auth: {
    tokenType: 'static';
    adminTokens: string[];
    developerTokens: string[];
  };
  modelEndpoint: {
    baseUrl: string;
    apiKey: string;
    modelName: string;
  };
  piOrchestration: {
    auditImageName: string;
    rpcPort: number;
    containerTimeoutMs: number;
  };
  auditRunner: {
    imageName: string;
    containerWorkspacePath: string;
    workspaceRoot?: string;
    preserveSessions: boolean;
    sessionArchiveRoot?: string;
    recordedOpenEgress: boolean;
  };
  jobs: {
    concurrency: Record<string, number>;
    retryPolicy: {
      maxRetries: number;
      backoffDelayMs: number;
      timeoutMs: number;
    };
  };
  webUi: {
    host: string;
    port: number;
  };
}

export function buildPostgresConnectionString(config: ModuleWardenConfig, includeSchema = false): string {
  const baseUrl = `postgresql://${config.postgres.user}:${config.postgres.password}` +
    `@${config.postgres.host}:${config.postgres.port}/${config.postgres.database}`;

  if (!includeSchema) {
    return baseUrl;
  }

  const delimiter = baseUrl.includes('?') ? '&' : '?';
  return `${baseUrl}${delimiter}schema=${encodeURIComponent(config.postgres.schema)}`;
}

/**
 * Read a required string env var. Throws at startup if missing or empty.
 */
function readRequiredString(name: string): string {
  const value = process.env[name];
  if (!value || value.trim() === '') {
    const hints: Record<string, string> = {
      MW_MODEL_ENDPOINT_BASE_URL: 'An OpenAI-compatible /v1 endpoint URL (e.g. https://api.deepseek.com/v1)',
      MW_MODEL_ENDPOINT_API_KEY: 'The API key credential for the model endpoint',
      MW_MODEL_ENDPOINT_MODEL: 'A model slug (e.g. deepseek-chat, gpt-4o, llama-3-70b)',
      MW_POSTGRES_HOST: 'PostgreSQL hostname (e.g. postgres or localhost)',
      MW_POSTGRES_DB: 'PostgreSQL database name',
      MW_POSTGRES_USER: 'PostgreSQL user',
      MW_POSTGRES_PASSWORD: 'PostgreSQL password',
    };
    const hint = hints[name] ? ` — ${hints[name]}` : '';
    throw new Error(
      `${name} is not set. This environment variable is required.${hint}\n` +
      `Set it in your .env file or shell before starting ModuleWarden.`
    );
  }
  return value.trim();
}

export function defaultConfig(): ModuleWardenConfig {
  const readList = (name: string, fallback: string[]) =>
    process.env[name]?.split(',').map((value) => value.trim()).filter(Boolean) ?? fallback;
  const readInt = (name: string, fallback: number) => {
    const value = process.env[name];
    return value ? Number.parseInt(value, 10) : fallback;
  };
  const readConcurrency = (queue: string, fallback: number) => {
    const key = `MW_JOB_CONCURRENCY_${queue.toUpperCase().replace(/-/g, '_')}`;
    const value = readInt(key, fallback);
    return Number.isNaN(value) ? fallback : value;
  };

  return {
    postgres: {
      host: readRequiredString('MW_POSTGRES_HOST'),
      port: readInt('MW_POSTGRES_PORT', 5432),
      database: readRequiredString('MW_POSTGRES_DB'),
      user: readRequiredString('MW_POSTGRES_USER'),
      password: readRequiredString('MW_POSTGRES_PASSWORD'),
      schema: process.env.MW_POSTGRES_SCHEMA ?? 'public',
    },
    verdaccio: {
      host: process.env.MW_VERDACCIO_HOST ?? 'verdaccio',
      port: readInt('MW_VERDACCIO_PORT', 4873),
      registryUrl: process.env.MW_VERDACCIO_URL ?? `http://${process.env.MW_VERDACCIO_HOST ?? 'verdaccio'}:${process.env.MW_VERDACCIO_PORT ?? '4873'}`,
    },
    auth: {
      tokenType: 'static',
      adminTokens: readList('MW_AUTH_ADMIN_TOKENS', ['mw-admin-token-change-me']),
      developerTokens: readList('MW_AUTH_DEV_TOKENS', ['mw-dev-token-change-me']),
    },
    modelEndpoint: {
      baseUrl: readRequiredString('MW_MODEL_ENDPOINT_BASE_URL'),
      apiKey: readRequiredString('MW_MODEL_ENDPOINT_API_KEY'),
      modelName: readRequiredString('MW_MODEL_ENDPOINT_MODEL'),
    },
    piOrchestration: {
      auditImageName: process.env.MW_AUDIT_IMAGE ?? 'modulewarden-audit-runner',
      rpcPort: readInt('MW_PI_RPC_PORT', 9090),
      containerTimeoutMs: readInt('MW_AUDIT_CONTAINER_TIMEOUT_MS', 300_000),
    },
    auditRunner: {
      imageName: process.env.MW_AUDIT_IMAGE ?? 'modulewarden-audit-runner',
      containerWorkspacePath: process.env.MW_AUDIT_CONTAINER_WORKSPACE ?? '/workspace',
      ...(process.env.MW_AUDIT_WORKSPACE_ROOT ? { workspaceRoot: process.env.MW_AUDIT_WORKSPACE_ROOT } : {}),
      preserveSessions: process.env.MW_PRESERVE_AUDIT_SESSIONS === 'true',
      ...(process.env.MW_AUDIT_SESSION_ARCHIVE_ROOT ? { sessionArchiveRoot: process.env.MW_AUDIT_SESSION_ARCHIVE_ROOT } : {}),
      recordedOpenEgress: process.env.MW_RECORDED_OPEN_EGRESS !== 'false',
    },
    jobs: {
      concurrency: {
        'package-review': readConcurrency('package-review', 4),
        'upstream-subscription-poll': readConcurrency('upstream-subscription-poll', 2),
        'audit-container-exec': readConcurrency('audit-container-exec', 2),
        'model-escalation': readConcurrency('model-escalation', 1),
        're-audit-campaign': readConcurrency('re-audit-campaign', 1),
        'project-ready': readConcurrency('project-ready', 1),
        'evidence-post-process': readConcurrency('evidence-post-process', 4),
        'verdaccio-promotion': readConcurrency('verdaccio-promotion', 4),
      },
      retryPolicy: {
        maxRetries: readInt('MW_JOB_MAX_RETRIES', 3),
        backoffDelayMs: readInt('MW_JOB_BACKOFF_DELAY_MS', 30_000),
        timeoutMs: readInt('MW_JOB_TIMEOUT_MS', 600_000),
      },
    },
    webUi: {
      host: process.env.MW_WEB_UI_HOST ?? '0.0.0.0',
      port: readInt('MW_WEB_UI_PORT', 3000),
    },
  };
}
