import { getPrisma } from '@modulewarden/prisma-client';
import { fetchUpstreamPackument } from '@modulewarden/shared/services/upstream';
import { getBestActiveOverrideForPackageVersion } from '@modulewarden/prisma-client';
import type { JobQueue } from '../jobs/queue.js';
import type { Prisma } from '@prisma/client';

/**
 * Register the upstream subscription poll handler.
 *
 * This worker processes `upstream-subscription-poll` jobs. It checks
 * the upstream npm registry for new versions of subscribed packages
 * and enqueues version-diff audits for any new versions found.
 */
export async function registerSubscriptionPollHandler(queue: JobQueue): Promise<void> {
  const prisma = getPrisma();

  const pollSinglePackage = async (packageName: string) => {
    // 1. Fetch upstream packument
    const packument = await fetchUpstreamPackument(packageName);
    if (!packument) {
      console.log(`[subscriptions] Package ${packageName} not found upstream — skipping`);
      return;
    }

    const upstreamVersions = Object.entries(packument.versions);
    const knownVersions = await prisma.packageVersion.findMany({
      where: { packageName, registrySource: 'npm' },
      select: { version: true, tarballHash: true },
    });
    const knownVersionSet = new Set(knownVersions.map((v) => `${v.version}::${v.tarballHash}`));

    const newVersions = upstreamVersions.filter(
      ([version, versionData]) => !knownVersionSet.has(`${version}::${versionData.dist?.integrity ?? versionData.dist?.shasum ?? `unresolved:${packageName}@${version}`}`)
    );

    if (newVersions.length === 0) {
      console.log(`[subscriptions] No new versions for ${packageName}`);
      return;
    }

    console.log(
      `[subscriptions] Found ${newVersions.length} new version(s) for ${packageName}: ${newVersions.map(([version]) => version).join(', ')}`
    );

    // 2. Find last allowed predecessor version for this package,
    // accounting for active overrides.
    const candidateVersions = await prisma.packageVersion.findMany({
      where: {
        packageName,
        registrySource: 'npm',
      },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        version: true,
        tarballHash: true,
        predecessorDecisions: {
          orderBy: { createdAt: 'desc' },
          take: 1,
          select: { verdict: true },
        },
      },
    });

    let lastAllowedVersion: { id: string; version: string; tarballHash: string } | null = null;

    for (const candidate of candidateVersions) {
      if (candidate.predecessorDecisions.length === 0) {
        continue;
      }

      const latestDecision = candidate.predecessorDecisions[0];
      if (!latestDecision) {
        continue;
      }
      const override = await getBestActiveOverrideForPackageVersion(candidate.id);
      const effectiveVerdict = override?.targetVerdict ?? latestDecision.verdict;

      if (effectiveVerdict === 'ALLOW') {
        lastAllowedVersion = {
          id: candidate.id,
          version: candidate.version,
          tarballHash: candidate.tarballHash,
        };
        break;
      }
    }

    for (const [version, versionData] of newVersions) {
      const tarballHash = versionData?.dist?.integrity ?? versionData?.dist?.shasum ?? `unresolved:${packageName}@${version}`;

      try {
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
            ...(packument.time?.[version] ? { publishDate: new Date(packument.time[version]) } : {}),
            ...(lastAllowedVersion ? { predecessorId: lastAllowedVersion.id } : {}),
          },
          update: lastAllowedVersion ? { predecessorId: lastAllowedVersion.id } : {},
        });

        // 3. Enqueue a package-review job (version-diff or cold-start)
        const auditContext = lastAllowedVersion
          ? `subscription:diff:v${lastAllowedVersion.version}->v${version}`
          : `subscription:cold-start:v${version}`;

        await queue.enqueuePackageReview(
          packageName,
          pv.version,
          pv.tarballHash,
          auditContext
        );

        console.log(`[subscriptions] Enqueued review for ${packageName}@${version} (${auditContext})`);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`[subscriptions] Failed to process ${packageName}@${version}: ${message}`);
      }
    }

    // 4. Record upstream metadata snapshot for active subscriptions
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
            versions: Object.fromEntries(upstreamVersions),
            distTags: packument['dist-tags'],
            newVersions: newVersions.length,
            fetchedAt: new Date().toISOString(),
          } as unknown as Prisma.InputJsonValue,
        },
      }).catch(() => {
        // Snapshot is best-effort
      });
    }
  };

  await queue.work('upstream-subscription-poll', async (job) => {
    const packageNames = job.data.packageName
      ? [job.data.packageName]
      : Array.from(new Set(
        (await prisma.packageSubscription.findMany({
          where: { active: true, registrySource: 'npm' },
          select: { packageName: true },
        })).map((subscription) => subscription.packageName)
      ));

    if (packageNames.length === 0) {
      console.log('[subscriptions] No active subscriptions to poll');
      return;
    }

    for (const targetPackage of packageNames) {
      await pollSinglePackage(targetPackage);
    }
  });
}
