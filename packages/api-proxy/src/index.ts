import Fastify from 'fastify';
import { getPrisma, disconnectPrisma } from '@modulewarden/prisma-client';
import { buildPostgresConnectionString, defaultConfig } from '@modulewarden/shared/config';
import { JobQueue } from '@modulewarden/worker/jobs/queue.js';
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
    return { status: 'ok', timestamp: new Date().toISOString() };
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
