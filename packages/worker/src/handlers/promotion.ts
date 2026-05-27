import { getPrisma } from '@modulewarden/prisma-client';
import { defaultConfig } from '@modulewarden/shared/config';
import type { JobQueue } from '../jobs/queue.js';
import { fetchUpstreamTarball, promoteTarballToVerdaccio } from '@modulewarden/shared/services/upstream';

/**
 * Register the Verdaccio promotion job handler.
 *
 * This worker processes `verdaccio-promotion` jobs. It fetches the
 * allowed tarball from the upstream npm registry and publishes it
 * into Verdaccio so the npm proxy can serve it to developers.
 *
 * Only versions with an ALLOW decision (not superseded by an active
 * override) should be promoted. The worker verifies the decision
 * is still valid before promoting.
 */
export async function registerVerdaccioPromotionHandler(queue: JobQueue): Promise<void> {
  const config = defaultConfig();

  await queue.work('verdaccio-promotion', async (job) => {
    const { decisionId, packageName, packageVersion, tarballHash } = job.data;
    const prisma = getPrisma();

    // 1. Verify the decision exists and is still ALLOW
    const decision = await prisma.decision.findUnique({
      where: { id: decisionId },
      select: {
        verdict: true,
        overrides: {
          where: { active: true },
          take: 1,
          select: { id: true },
        },
      },
    });

    if (!decision) {
      throw new Error(`Decision ${decisionId} not found — cannot promote ${packageName}@${packageVersion}`);
    }

    if (decision.verdict !== 'ALLOW') {
      throw new Error(
        `Decision ${decisionId} for ${packageName}@${packageVersion} is ${decision.verdict}, not ALLOW — skipping promotion`
      );
    }

    if (decision.overrides.length > 0) {
      throw new Error(
        `Decision ${decisionId} for ${packageName}@${packageVersion} has active override — skipping promotion`
      );
    }

    // 2. Fetch the tarball from upstream npm
    const tarballUrl = `https://registry.npmjs.org/${encodeURIComponent(packageName)}/-/${encodeURIComponent(packageName)}-${packageVersion}.tgz`;
    const tarball = await fetchUpstreamTarball(tarballUrl);

    if (!tarball) {
      throw new Error(`Tarball not found upstream for ${packageName}@${packageVersion}`);
    }

    // 3. Promote into Verdaccio
    const verdaccioUrl = config.verdaccio.registryUrl;
    // For v1, use a configurable static token for Verdaccio
    const verdaccioToken = process.env.MW_VERDACCIO_TOKEN ?? 'modulewarden-promotion-token';

    await promoteTarballToVerdaccio(
      verdaccioUrl,
      packageName,
      packageVersion,
      tarballUrl,
      tarballHash,
      verdaccioToken
    );

    // 4. Update the package version record with Verdaccio storage info
    await prisma.tarballArtifact.create({
      data: {
        packageVersion: {
          connect: {
            packageName_version_registrySource_tarballHash: {
              packageName,
              version: packageVersion,
              registrySource: 'npm',
              tarballHash,
            },
          },
        },
        storagePath: `${encodeURIComponent(packageName)}/-/${encodeURIComponent(packageName)}-${packageVersion}.tgz`,
      },
    });

    console.log(`[promotion] Successfully promoted ${packageName}@${packageVersion} to Verdaccio`);
  });
}
