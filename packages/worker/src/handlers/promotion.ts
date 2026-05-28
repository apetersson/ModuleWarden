import { getPrisma } from '@modulewarden/prisma-client';
import { defaultConfig } from '@modulewarden/shared/config';
import type { JobQueue } from '../jobs/queue.js';
import { fetchUpstreamTarball, promoteTarballToVerdaccio } from '@modulewarden/shared/services/upstream';
import { getBestActiveOverrideForPackageVersion } from '@modulewarden/prisma-client';

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
        id: true,
        verdict: true,
        createdAt: true,
        packageVersionId: true,
        packageVersion: {
          select: {
            packageName: true,
            version: true,
            registrySource: true,
            tarballHash: true,
          },
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

    if (
      decision.packageVersion.packageName !== packageName ||
      decision.packageVersion.version !== packageVersion ||
      decision.packageVersion.registrySource !== 'npm' ||
      decision.packageVersion.tarballHash !== tarballHash
    ) {
      throw new Error(`Promotion payload does not match decision ${decisionId}`);
    }

    const newerDecision = await prisma.decision.findFirst({
      where: {
        packageVersionId: decision.packageVersionId,
        OR: [
          { createdAt: { gt: decision.createdAt } },
          {
            createdAt: decision.createdAt,
            id: { not: decision.id },
          },
        ],
      },
      orderBy: { createdAt: 'desc' },
    });
    if (newerDecision) {
      throw new Error(
        `Decision ${decisionId} for ${packageName}@${packageVersion} is not the latest decision`
      );
    }

    const directOverride = await prisma.override.findFirst({
      where: {
        active: true,
        decisionId,
      },
    });
    if (directOverride && directOverride.targetVerdict !== 'ALLOW') {
      throw new Error(
        `Decision ${decisionId} for ${packageName}@${packageVersion} has direct ${directOverride.targetVerdict} override ${directOverride.id}`
      );
    }

    const activeOverride = await getBestActiveOverrideForPackageVersion(decision.packageVersionId);
    if (activeOverride && activeOverride.targetVerdict !== 'ALLOW') {
      throw new Error(
        `Decision ${decisionId} for ${packageName}@${packageVersion} has active ${activeOverride.targetVerdict} override ${activeOverride.id}`
      );
    }

    // 2. Fetch the tarball from upstream npm
    // Scoped packages: @scope/name -> name-version.tgz; Unscoped: name-version.tgz (H-1)
    const unscopedName = packageName.startsWith('@') ? packageName.split('/')[1] : packageName;
    const tarballUrl = `https://registry.npmjs.org/${encodeURIComponent(packageName)}/-/${unscopedName}-${packageVersion}.tgz`;
    const tarball = await fetchUpstreamTarball(tarballUrl);

    if (!tarball) {
      throw new Error(`Tarball not found upstream for ${packageName}@${packageVersion}`);
    }

    // 3. Promote into Verdaccio
    const verdaccioUrl = config.verdaccio.registryUrl;
    // For v1, use a configurable static token for Verdaccio
    const verdaccioToken = process.env.MW_VERDACCIO_TOKEN;
    if (!verdaccioToken) {
      throw new Error(
        'MW_VERDACCIO_TOKEN is not set. A Verdaccio promotion token must be ' +
        'configured before tarballs can be promoted to the backing registry.'
      );
    }

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
        storagePath: `${encodeURIComponent(packageName)}/-/${unscopedName}-${packageVersion}.tgz`,
      },
    });

    console.log(`[promotion] Successfully promoted ${packageName}@${packageVersion} to Verdaccio`);
  });
}
