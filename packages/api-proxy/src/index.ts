import Fastify from 'fastify';
import { getPrisma, disconnectPrisma } from '@modulewarden/prisma-client';
import { defaultConfig } from '@modulewarden/shared/config';
import { registerPackumentRoute } from './routes/packument.js';
import { registerTarballRoute } from './routes/tarball.js';

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
    // Inline pg-boss send for tarball review enqueueing
    // Worker will register the actual handler for package-review
    async (queue: string, data: Record<string, unknown>) => {
      // TODO: wire pg-boss send through shared JobQueue
      // For now, this is a no-op placeholder — the worker package
      // will provide the actual JobQueue instance in production.
      console.log(`[proxy] Would enqueue ${queue}:`, JSON.stringify(data).slice(0, 200));
      return 'placeholder';
    }
  );

  // ── Health check ──────────────────────────────────────────────

  app.get('/health', async () => {
    return { status: 'ok', timestamp: new Date().toISOString() };
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
