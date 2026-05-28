import Fastify from 'fastify';
import { getPrisma, disconnectPrisma } from '@modulewarden/prisma-client';
import { buildPostgresConnectionString, defaultConfig } from '@modulewarden/shared/config';
import { registerPackumentRoute } from './routes/packument.js';
import { registerTarballRoute } from './routes/tarball.js';
import PgBoss from 'pg-boss';

export async function buildServer() {
  const config = defaultConfig();
  const prisma = getPrisma();
  await prisma.$connect();
  const connectionString = buildPostgresConnectionString(config, true);

  const boss = new PgBoss({
    connectionString,
    schema: config.postgres.schema,
  });
  await boss.start();
  await boss.createQueue('package-review');

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
    async (queue: string, data: Record<string, unknown>) => {
      return boss.send(queue, data, {
        singletonKey: String(data.idempotencyKey),
        singletonSeconds: 86400,
        retryLimit: config.jobs.retryPolicy.maxRetries,
        retryBackoff: true,
        retryDelay: config.jobs.retryPolicy.backoffDelayMs,
        expireInSeconds: Math.ceil(config.jobs.retryPolicy.timeoutMs / 1000),
      });
    }
  );

  // ── Health check ──────────────────────────────────────────────

  app.get('/health', async () => {
    return { status: 'ok', timestamp: new Date().toISOString() };
  });

  app.addHook('onClose', async () => {
    await boss.stop();
    await disconnectPrisma();
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
