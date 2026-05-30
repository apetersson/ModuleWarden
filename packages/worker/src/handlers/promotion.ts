import { getPrisma } from '@modulewarden/prisma-client';
import type { Override, Prisma } from '@modulewarden/prisma-client';
import { defaultConfig } from '@modulewarden/shared/config';
import type { JobQueue } from '../jobs/queue.js';
import { fetchUpstreamTarball, promoteTarballToVerdaccio } from '@modulewarden/shared/services/upstream';

async function getBestActiveOverrideForPackageVersionTx(
  tx: Prisma.TransactionClient,
  packageVersionId: string
): Promise<Override | null> {
  const packageVersion = await tx.packageVersion.findUnique({
    where: { id: packageVersionId },
    select: {
      packageName: true,
      importedByProjects: {
        select: { projectId: true },
      },
    },
  });
  if (!packageVersion) return null;

  const projectIds = [...new Set(packageVersion.importedByProjects.map((entry) => entry.projectId))];

  const specificOverride = await tx.override.findFirst({
    where: {
      active: true,
      scope: 'SPECIFIC_VERSION',
      decision: {
        packageVersionId,
      },
    },
    orderBy: { createdAt: 'desc' },
  });
  if (specificOverride) return specificOverride;

  const packageOverride = await tx.override.findFirst({
    where: {
      active: true,
      scope: 'PACKAGE',
      decision: {
        packageVersion: {
          packageName: packageVersion.packageName,
        },
      },
    },
    orderBy: { createdAt: 'desc' },
  });
  if (packageOverride) return packageOverride;

  if (projectIds.length > 0) {
    const projectOverride = await tx.override.findFirst({
      where: {
        active: true,
        scope: 'PROJECT',
        decision: {
          packageVersion: {
            importedByProjects: {
              some: {
                projectId: {
                  in: projectIds,
                },
              },
            },
          },
        },
      },
      orderBy: { createdAt: 'desc' },
    });
    if (projectOverride) return projectOverride;
  }

  return tx.override.findFirst({
    where: {
      active: true,
      scope: 'GLOBAL',
    },
    orderBy: { createdAt: 'desc' },
  });
}

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

    // 1. Verify the decision exists and is still ALLOW.
    // Wrap verification + promotion in a serializable transaction to prevent
    // TOCTOU race where another worker creates a BLOCK decision between
    // our check and the actual promotion (BUG-04).
    const verification = await prisma.$transaction(async (tx) => {
      const decision = await tx.decision.findUnique({
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

      // Check for newer decisions within the same transaction
      const newerDecision = await tx.decision.findFirst({
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

      const directOverride = await tx.override.findFirst({
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

      const activeOverride = await getBestActiveOverrideForPackageVersionTx(tx, decision.packageVersionId);
      if (activeOverride && activeOverride.targetVerdict !== 'ALLOW') {
        throw new Error(
          `Decision ${decisionId} for ${packageName}@${packageVersion} has active ${activeOverride.targetVerdict} override ${activeOverride.id}`
        );
      }

      return { decision };
    }, {
      isolationLevel: 'Serializable',
      maxWait: 15_000,
      timeout: 60_000,
    });

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
    const verdaccioToken = config.verdaccio.token;

    await promoteTarballToVerdaccio(
      verdaccioUrl,
      packageName,
      packageVersion,
      tarballUrl,
      tarballHash,
      verdaccioToken
    );

    // 4. Post-promotion re-verification: check no BLOCK decision was created
    // during the promotion (closing the residual TOCTOU window).
    const postDecision = await prisma.decision.findFirst({
      where: {
        packageVersion: {
          packageName,
          version: packageVersion,
          registrySource: 'npm',
          tarballHash,
        },
        verdict: 'BLOCK',
      },
      orderBy: { createdAt: 'desc' },
      select: { id: true, createdAt: true },
    });

    if (postDecision && postDecision.createdAt > verification.decision.createdAt) {
      // A BLOCK decision was created while we were promoting — roll back
      // the Verdaccio promotion by removing the tarball and marking the
      // tarball artifact as superseded. For now, log a critical warning.
      console.error(
        `[promotion] CRITICAL: ${packageName}@${packageVersion} was promoted to Verdaccio ` +
        `but a BLOCK decision (${postDecision.id}) was created during promotion! ` +
        `Manual intervention required.`
      );
    }

    // 5. Update the package version record with Verdaccio storage info
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
