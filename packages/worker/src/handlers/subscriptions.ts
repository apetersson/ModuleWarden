import { getPrisma } from '@modulewarden/prisma-client';
import { fetchUpstreamPackument } from '@modulewarden/shared/services/upstream';
import type { JobQueue } from '../jobs/queue.js';

/**
 * Register the upstream subscription poll handler.
 *
 * This worker processes `upstream-subscription-poll` jobs. It checks
 * the upstream npm registry for new versions of subscribed packages
 * and enqueues version-diff audits for any new versions found.
 */
export async function registerSubscriptionPollHandler(queue: JobQueue): Promise<void> {
  await queue.work('upstream-subscription-poll', async (job) => {
    const { packageName } = job.data;
    const prisma = getPrisma();

    // 1. Fetch upstream packument
    const packument = await fetchUpstreamPackument(packageName);
    if (!packument) {
      console.log(`[subscriptions] Package ${packageName} not found upstream — skipping`);
      return;
    }

    const upstreamVersions = Object.keys(packument.versions);

    // 2. Get known versions for this package
    const knownVersions = await prisma.packageVersion.findMany({
      where: { packageName, registrySource: 'npm' },
      select: { version: true, tarballHash: true },
    });
    const knownVersionSet = new Set(knownVersions.map((v) => v.version));

    // 3. Find new versions (in upstream but not in our DB)
    const newVersions = upstreamVersions.filter((v) => !knownVersionSet.has(v));

    if (newVersions.length === 0) {
      console.log(`[subscriptions] No new versions for ${packageName}`);
      return;
    }

    console.log(
      `[subscriptions] Found ${newVersions.length} new version(s) for ${packageName}: ${newVersions.join(', ')}`
    );

    // 4. For each new version, find the last allowed predecessor
    const lastAllowedVersion = await prisma.packageVersion.findFirst({
      where: {
        packageName,
        predecessorDecisions: {
          some: { verdict: 'ALLOW' },
        },
      },
      orderBy: { createdAt: 'desc' },
      select: { version: true, tarballHash: true },
    });

    // 5. Create package versions and enqueue reviews for each new version
    for (const version of newVersions) {
      const versionData = packument.versions[version];
      const tarballHash = versionData?.dist?.integrity ?? `sha512-${packageName}-${version}`;

      try {
        // Upsert the package version
        const pv = await prisma.packageVersion.upsert({
          where: {
            packageName_version_registrySource_tarballHash: {
              packageName,
              version,
              registrySource: 'npm',
              tarballHash,
            },
          },
          create: {
            packageName,
            version,
            registrySource: 'npm',
            tarballHash,
            hasLifecycleScript: typeof versionData?.scripts === 'object' && Object.keys(versionData.scripts ?? {}).length > 0,
            publishDate: packument.time?.[version]
              ? new Date(packument.time[version])
              : undefined,
          },
          update: {},
        });

        // Set predecessor link if one exists
        if (lastAllowedVersion) {
          await prisma.packageVersion.update({
            where: { id: pv.id },
            data: {
              predecessorId: (
                await prisma.packageVersion.findFirst({
                  where: {
                    packageName,
                    version: lastAllowedVersion.version,
                    registrySource: 'npm',
                  },
                  select: { id: true },
                  orderBy: { createdAt: 'desc' },
                })
              )?.id ?? undefined,
            },
          });
        }

        // Enqueue a package-review job (version-diff or cold-start)
        const auditContext = lastAllowedVersion
          ? `subscription:diff:v${lastAllowedVersion.version}->v${version}`
          : `subscription:cold-start:v${version}`;

        await queue.enqueuePackageReview(
          packageName,
          version,
          tarballHash,
          auditContext
        );

        console.log(`[subscriptions] Enqueued review for ${packageName}@${version} (${auditContext})`);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`[subscriptions] Failed to process ${packageName}@${version}: ${message}`);
      }
    }

    // 6. Record upstream metadata snapshot for active subscriptions
    const subscriptions = await prisma.packageSubscription.findMany({
      where: { packageName, registrySource: 'npm', active: true },
      select: { id: true },
    });

    for (const sub of subscriptions) {
      await prisma.upstreamMetadataSnapshot.create({
        data: {
          subscriptionId: sub.id,
          packageName,
          registrySource: 'npm',
          metadata: {
            versions: upstreamVersions,
            distTags: packument['dist-tags'],
            newVersions: newVersions.length,
            fetchedAt: new Date().toISOString(),
          },
        },
      }).catch(() => {
        // Snapshot is best-effort
      });
    }
  });
}
