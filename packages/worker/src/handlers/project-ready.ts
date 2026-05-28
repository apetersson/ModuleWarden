import { getPrisma } from '@modulewarden/prisma-client';
import type { JobQueue } from '../jobs/queue.js';

/**
 * Register the project-ready handler.
 *
 * This worker checks if all imported package versions for a project have
 * decisions and enables registry access only when the project is fully
 * reviewed.
 */
export async function registerProjectReadyHandler(queue: JobQueue): Promise<void> {
  await queue.work('project-ready', async (job) => {
    const { projectId, reason } = job.data;
    const prisma = getPrisma();

    const versions = await prisma.importedPackageVersion.findMany({
      where: { projectId },
      select: {
        packageVersion: {
          select: {
            predecessorDecisions: {
              select: { id: true },
              take: 1,
            },
          },
        },
      },
    });

    const total = versions.length;
    const decided = versions.filter((entry) => entry.packageVersion.predecessorDecisions.length > 0).length;

    if (total === 0 || decided < total) {
      console.log(
        `[project-ready] Project ${projectId} not ready (${decided}/${total}); reason=${reason}`
      );
      return;
    }

    await prisma.project.update({
      where: { id: projectId },
      data: {
        graphState: 'READY',
        registryEnabled: true,
      },
    });

    console.log(`[project-ready] Project ${projectId} marked READY: ${reason}`);
  });
}
