import { getPrisma } from '../index.js';
import type { PackageVersion } from '@prisma/client';

export interface PackageVersionInput {
  packageName: string;
  version: string;
  registrySource?: string;
  tarballHash: string;
  tarballSize?: number;
  publishDate?: Date;
  deprecated?: boolean;
  description?: string;
  repositoryUrl?: string;
  homepageUrl?: string;
  license?: string;
  hasLifecycleScript?: boolean;
  hasObfuscation?: boolean;
  hasNativeBinary?: boolean;
  hasWasm?: boolean;
  predecessorId?: string;
}

export async function upsertPackageVersion(input: PackageVersionInput): Promise<PackageVersion> {
  const { packageName, version, registrySource = 'npm', tarballHash, ...rest } = input;
  return getPrisma().packageVersion.upsert({
    where: {
      packageName_version_registrySource_tarballHash: {
        packageName,
        version,
        registrySource,
        tarballHash,
      },
    },
    create: {
      packageName,
      version,
      registrySource,
      tarballHash,
      ...rest,
    },
    update: {
      ...rest,
    },
  });
}

export async function getPackageVersion(id: string): Promise<PackageVersion | null> {
  return getPrisma().packageVersion.findUnique({ where: { id } });
}

export async function findPackageVersion(
  packageName: string,
  version: string,
  registrySource = 'npm',
  tarballHash?: string
): Promise<PackageVersion | null> {
  if (tarballHash) {
    return getPrisma().packageVersion.findUnique({
      where: {
        packageName_version_registrySource_tarballHash: {
          packageName,
          version,
          registrySource,
          tarballHash,
        },
      },
    });
  }
  return getPrisma().packageVersion.findFirst({
    where: { packageName, version, registrySource },
    orderBy: { createdAt: 'desc' },
  });
}

export async function listPackageVersions(
  packageName: string,
  registrySource = 'npm'
): Promise<PackageVersion[]> {
  return getPrisma().packageVersion.findMany({
    where: { packageName, registrySource },
    orderBy: { publishDate: 'desc' },
  });
}

export async function getLatestAllowedVersion(
  packageName: string,
  registrySource = 'npm'
): Promise<PackageVersion | null> {
  return getPrisma().packageVersion.findFirst({
    where: {
      packageName,
      registrySource,
      predecessorDecisions: {
        some: { verdict: 'ALLOW' },
      },
    },
    orderBy: { publishDate: 'desc' },
  });
}

export async function setPackageVersionPredecessor(
  id: string,
  predecessorId: string
): Promise<PackageVersion> {
  return getPrisma().packageVersion.update({
    where: { id },
    data: { predecessorId },
  });
}
