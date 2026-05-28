import { disconnectPrisma } from '@modulewarden/prisma-client';
import { buildPostgresConnectionString, defaultConfig } from '@modulewarden/shared/config';
import { JobQueue } from './jobs/queue.js';
import { registerVerdaccioPromotionHandler } from './handlers/promotion.js';
import { registerAuditContainerHandler } from './handlers/audit.js';
import { registerSubscriptionPollHandler } from './handlers/subscriptions.js';
import { registerPackageReviewHandler } from './handlers/reviews.js';
import { registerModelEscalationHandler } from './handlers/model-escalation.js';
import { registerEvidencePostProcessHandler } from './handlers/evidence-post-process.js';
import { registerReAuditCampaignHandler } from './handlers/reaudit.js';
import { registerProjectReadyHandler } from './handlers/project-ready.js';
import { SCHEDULED_JOBS } from './jobs/definitions.js';

const config = defaultConfig();

async function main() {
  const connectionString = buildPostgresConnectionString(config, true);
  const queue = new JobQueue({
    connectionString,
    schema: config.postgres.schema,
    maxRetries: config.jobs.retryPolicy.maxRetries,
    backoffDelayMs: config.jobs.retryPolicy.backoffDelayMs,
    timeoutMs: config.jobs.retryPolicy.timeoutMs,
    concurrency: config.jobs.concurrency,
  });

  await queue.start();
  console.log('[worker] pg-boss started');

  // Register all job handlers
  await registerPackageReviewHandler(queue);
  await registerVerdaccioPromotionHandler(queue);
  await registerAuditContainerHandler(queue);
  await registerSubscriptionPollHandler(queue);
  await registerModelEscalationHandler(queue);
  await registerEvidencePostProcessHandler(queue);
  await registerReAuditCampaignHandler(queue);
  await registerProjectReadyHandler(queue);

  // Register scheduled jobs
  for (const scheduled of SCHEDULED_JOBS) {
    const payload = scheduled.queue === 're-audit-campaign'
      ? { reason: 'Scheduled re-audit sweep' }
      : {};
    await queue.schedule(
      scheduled.queue,
      scheduled.cron,
      payload,
      { tz: 'UTC' }
    );
    console.log(`[worker] Scheduled job registered: ${scheduled.queue} (${scheduled.cron})`);
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

export { JobQueue } from './jobs/queue.js';
