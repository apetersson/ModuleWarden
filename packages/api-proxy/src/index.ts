import Fastify from 'fastify';
import { getPrisma, disconnectPrisma } from '@modulewarden/prisma-client';
import { buildPostgresConnectionString, defaultConfig } from '@modulewarden/shared/config';
import { JobQueue } from '@modulewarden/worker/jobs/queue.js';
import { createHash } from 'node:crypto';
import { registerPackumentRoute } from './routes/packument.js';
import { registerTarballRoute } from './routes/tarball.js';
import { registerAdminRoutes } from './routes/admin.js';
import { registerStatusRoutes } from './routes/status.js';
import { registerInternalRoutes } from './routes/internal.js';
import { registerDashboardRoutes } from './routes/dashboard.js';

let _queue: JobQueue | null = null;

async function getQueue(): Promise<JobQueue> {
  if (!_queue) {
    const config = defaultConfig();
    const connectionString = buildPostgresConnectionString(config, true);
    _queue = new JobQueue({ connectionString, schema: config.postgres.schema });
    await _queue.start();
  }
  return _queue;
}

async function enqueuePackageReviewLight(
  packageName: string,
  packageVersion: string,
  tarballHash: string,
  auditContext: string
): Promise<string | null> {
  try {
    const queue = await getQueue();
    const jobId = await queue.send('package-review', {
      packageName,
      packageVersion,
      tarballHash,
      auditContext,
    });
    return jobId ?? null;
  } catch {
    return null;
  }
}

export async function buildServer() {
  const config = defaultConfig();
  const prisma = getPrisma();
  await prisma.$connect();

  const app = Fastify({
    logger: {
      level: process.env.NODE_ENV === 'development' ? 'info' : 'warn',
    },
  });

  // ── Registry endpoints ────────────────────────────────────────

  await registerPackumentRoute(app);

  await registerTarballRoute(
    app,
    config.verdaccio.registryUrl,
    async (data: Record<string, unknown>) => {
      return enqueuePackageReviewLight(
        String(data.packageName),
        String(data.packageVersion),
        String(data.tarballHash),
        String(data.auditContext)
      );
    }
  );

  // ── Admin & status endpoints ─────────────────────────────────

  await registerAdminRoutes(app);
  await registerStatusRoutes(app);

  // ── Internal RPC endpoints (audit bridge) ───────────────────

  await registerInternalRoutes(app);

  // ── Dashboard admin endpoints ────────────────────────────────

  await registerDashboardRoutes(app);

  // ── Health check ──────────────────────────────────────────────

  app.get('/health', async () => {
    const checks: Record<string, unknown> = {};
    let allHealthy = true;

    // Check Postgres connectivity
    try {
      await prisma.$queryRaw`SELECT 1`;
      checks.postgres = { status: 'ok' };
    } catch (err) {
      checks.postgres = { status: 'error', error: err instanceof Error ? err.message : String(err) };
      allHealthy = false;
    }

    // Check pg-boss connectivity
    try {
      const queue = await getQueue();
      if (queue.isStarted) {
        checks.pgboss = { status: 'ok' };
      } else {
        checks.pgboss = { status: 'error', error: 'pg-boss not started' };
        allHealthy = false;
      }
    } catch (err) {
      checks.pgboss = { status: 'error', error: err instanceof Error ? err.message : String(err) };
      allHealthy = false;
    }

    // Check Verdaccio connectivity (best-effort)
    try {
      const resp = await fetch(`${config.verdaccio.registryUrl}/-/ping`);
      checks.verdaccio = { status: resp.ok ? 'ok' : 'error', statusCode: resp.status };
      if (!resp.ok) allHealthy = false;
    } catch (err) {
      checks.verdaccio = { status: 'unreachable', error: err instanceof Error ? err.message : String(err) };
    }

    return {
      status: allHealthy ? 'ok' : 'degraded',
      timestamp: new Date().toISOString(),
      version: '0.1.0',
      checks,
    };
  });

  app.addHook('onClose', async () => {
    await disconnectPrisma();
    if (_queue) {
      await _queue.stop();
    }
  });

  return app;
}

// ── Server start (when run directly, not as module) ────────────

const port = parseInt(process.env.MW_API_PORT ?? '8080', 10);
const host = process.env.MW_API_HOST ?? '0.0.0.0';

async function start() {
  const app = await buildServer();
  await app.listen({ port, host });
  console.log(`ModuleWarden npm proxy listening on ${host}:${port}`);
}

start().catch((err) => {
  console.error('Failed to start proxy:', err);
  process.exit(1);
});
