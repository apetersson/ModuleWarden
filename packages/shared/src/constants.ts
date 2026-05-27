export const MODULEWARDEN_VERSION = '0.1.0';

export const DEFAULT_RPC_PORT = 9090;
export const DEFAULT_API_PORT = 8080;
export const DEFAULT_VERDACCIO_PORT = 4873;

export const JOB_IDEMPOTENCY_KEY_PREFIX = 'mw:job:';

export function buildIdempotencyKey(
  jobType: string,
  packageName: string,
  packageVersion: string,
  tarballHash: string,
  auditContext: string
): string {
  return `${JOB_IDEMPOTENCY_KEY_PREFIX}${jobType}:${packageName}:${packageVersion}:${tarballHash}:${auditContext}`;
}

export function buildPackageIdentityKey(
  name: string,
  version: string,
  registrySource: string,
  tarballHash: string
): string {
  return `${registrySource}:${name}:${version}:${tarballHash}`;
}
