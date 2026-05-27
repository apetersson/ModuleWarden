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
    fallbackBaseUrl?: string;
    fallbackApiKey?: string;
    fallbackModelName?: string;
  };
  piOrchestration: {
    auditImageName: string;
    rpcPort: number;
    containerTimeoutMs: number;
  };
  auditRunner: {
    imageName: string;
    containerWorkspacePath: string;
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

export function defaultConfig(): ModuleWardenConfig {
  return {
    postgres: {
      host: 'postgres',
      port: 5432,
      database: 'modulewarden',
      user: 'modulewarden',
      password: 'modulewarden',
      schema: 'public',
    },
    verdaccio: {
      host: 'verdaccio',
      port: 4873,
      registryUrl: 'http://verdaccio:4873',
    },
    auth: {
      tokenType: 'static',
      adminTokens: ['mw-admin-token-change-me'],
      developerTokens: ['mw-dev-token-change-me'],
    },
    modelEndpoint: {
      baseUrl: 'http://model-endpoint:8080/v1',
      apiKey: 'sk-change-me',
      modelName: 'llama-3-70b',
      fallbackBaseUrl: 'http://fallback-model:8080/v1',
      fallbackApiKey: 'sk-fallback-change-me',
      fallbackModelName: 'llama-3-8b',
    },
    piOrchestration: {
      auditImageName: 'modulewarden-audit-runner',
      rpcPort: 9090,
      containerTimeoutMs: 300_000,
    },
    auditRunner: {
      imageName: 'modulewarden-audit-runner',
      containerWorkspacePath: '/workspace',
      recordedOpenEgress: true,
    },
    jobs: {
      concurrency: {
        'package-review': 4,
        'upstream-subscription-poll': 2,
        'audit-container-exec': 2,
        'model-escalation': 1,
        're-audit-campaign': 1,
        'evidence-post-process': 4,
        'verdaccio-promotion': 4,
      },
      retryPolicy: {
        maxRetries: 3,
        backoffDelayMs: 30_000,
        timeoutMs: 600_000,
      },
    },
    webUi: {
      host: '0.0.0.0',
      port: 3000,
    },
  };
}
