import { disconnectPrisma } from '@modulewarden/prisma-client';
import { defaultConfig } from '@modulewarden/shared/config';
import { JobQueue } from './jobs/queue.js';
import { registerVerdaccioPromotionHandler } from './handlers/promotion.js';
import { registerAuditContainerHandler } from './handlers/audit.js';
import { registerSubscriptionPollHandler } from './handlers/subscriptions.js';
import { SCHEDULED_JOBS, DEFAULT_WORKER_CONFIG } from './jobs/definitions.js';

const config = defaultConfig();

async function main() {
  const queue = new JobQueue({
    connectionString: `postgresql://${config.postgres.user}:${config.postgres.password}@${config.postgres.host}:${config.postgres.port}/${config.postgres.database}`,
    schema: 'pgboss',
    maxRetries: config.jobs.retryPolicy.maxRetries,
    backoffDelayMs: config.jobs.retryPolicy.backoffDelayMs,
    timeoutMs: config.jobs.retryPolicy.timeoutMs,
    concurrency: config.jobs.concurrency,
  });

  await queue.start();
  console.log('[worker] pg-boss started');

  // Register all job handlers
  await registerVerdaccioPromotionHandler(queue);
  await registerAuditContainerHandler(queue);
  await registerSubscriptionPollHandler(queue);

  // Register scheduled jobs
  for (const scheduled of SCHEDULED_JOBS) {
    await queue.schedule(
      scheduled.name,
      scheduled.cron,
      {},
      { tz: 'UTC' }
    );
    console.log(`[worker] Scheduled job registered: ${scheduled.name} (${scheduled.cron})`);
  }

  console.log('[worker] All handlers registered, waiting for jobs...');

  // Handle shutdown
  const shutdown = async () => {
    console.log('[worker] Shutting down...');
    await queue.stop();
    await disconnectPrisma();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  console.error('[worker] Failed to start:', err);
  process.exit(1);
});
