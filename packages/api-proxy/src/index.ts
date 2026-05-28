import Fastify from 'fastify';
import { getPrisma, disconnectPrisma } from '@modulewarden/prisma-client';
import { defaultConfig } from '@modulewarden/shared/config';
import { buildIdempotencyKey } from '@modulewarden/shared/constants';
import { registerPackumentRoute } from './routes/packument.js';
import { registerTarballRoute } from './routes/tarball.js';
import { registerAdminRoutes } from './routes/admin.js';
import { registerStatusRoutes } from './routes/status.js';
import { registerInternalRoutes } from './routes/internal.js';

/**
 * Lightweight pg-boss enqueue function for the api-proxy.
 * Does NOT start a full JobQueue worker — it directly inserts a job
 * into pg-boss's queue using a raw SQL call. The dedicated worker
 * service handles job processing (C-4).
 */
import { randomBytes } from 'node:crypto';

async function enqueuePackageReviewLight(
  packageName: string,
  packageVersion: string,
  tarballHash: string,
  auditContext: string
): Promise<string | null> {
  const prisma = getPrisma();
  const idempotencyKey = buildIdempotencyKey('package-review', packageName, packageVersion, tarballHash, auditContext);
  const jobId = `mw:${Date.now()}:${randomBytes(4).toString('hex')}`;

  try {
    // Direct pg-boss insert via raw query — lightweight, no worker overhead
    await prisma.$executeRawUnsafe(`
      INSERT INTO pgboss.schedule (name, data) VALUES ($1, $2)
      ON CONFLICT DO NOTHING
    `, [
      `package-review:${packageName}@${packageVersion}`,
      JSON.stringify({
        type: 'package-review',
        data: {
          packageName,
          packageVersion,
          tarballHash,
          auditContext,
          idempotencyKey,
          pgBossJobId: jobId,
        },
      }),
    ]);
    return jobId;
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

  // ── Health check ──────────────────────────────────────────────

  app.get('/health', async () => {
    return { status: 'ok', timestamp: new Date().toISOString() };
  });

  app.addHook('onClose', async () => {
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
