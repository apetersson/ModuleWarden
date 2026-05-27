import { getPrisma } from '../index.js';
import type { PackageSubscription, UpstreamMetadataSnapshot } from '@prisma/client';
import type { Prisma } from '@prisma/client';

export interface SubscriptionInput {
  projectId: string;
  packageName: string;
  registrySource?: string;
}

export async function subscribePackage(input: SubscriptionInput): Promise<PackageSubscription> {
  const { projectId, packageName, registrySource = 'npm' } = input;
  return getPrisma().packageSubscription.upsert({
    where: {
      projectId_packageName_registrySource: {
        projectId,
        packageName,
        registrySource,
      },
    },
    create: { projectId, packageName, registrySource },
    update: { active: true },
  });
}

export async function unsubscribePackage(id: string): Promise<PackageSubscription> {
  return getPrisma().packageSubscription.update({
    where: { id },
    data: { active: false },
  });
}

export async function listActiveSubscriptions(): Promise<PackageSubscription[]> {
  return getPrisma().packageSubscription.findMany({
    where: { active: true },
    include: { project: true },
    orderBy: { subscribedAt: 'asc' },
  });
}

export async function listSubscriptionsByProject(projectId: string): Promise<PackageSubscription[]> {
  return getPrisma().packageSubscription.findMany({
    where: { projectId, active: true },
  });
}

export async function recordUpstreamSnapshot(
  subscriptionId: string,
  packageName: string,
  registrySource: string,
  metadata: Prisma.InputJsonValue
): Promise<UpstreamMetadataSnapshot> {
  return getPrisma().upstreamMetadataSnapshot.create({
    data: { subscriptionId, packageName, registrySource, metadata },
  });
}

export async function getLatestSnapshot(
  subscriptionId: string
): Promise<UpstreamMetadataSnapshot | null> {
  return getPrisma().upstreamMetadataSnapshot.findFirst({
    where: { subscriptionId },
    orderBy: { fetchedAt: 'desc' },
  });
}
