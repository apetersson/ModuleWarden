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

/**
 * Normalize audit contexts that should dedupe to a shared review lane.
 *
 * Preflight tarball misses, lockfile imports, and subscription polling are
 * all discovery-driven review requests for the same package hash and should
 * collapse to one active package-review job. Re-audit requests stay distinct
 * per campaign to preserve explicit re-evaluation runs.
 */
export function canonicalReviewAuditContext(auditContext: string): string {
  if (auditContext.startsWith('re-audit:')) {
    return auditContext;
  }

  if (
    auditContext.startsWith('preflight:') ||
    auditContext.startsWith('subscription:') ||
    auditContext.startsWith('lockfile-import:')
  ) {
    return 'shared-review:discovery';
  }

  return auditContext;
}

export function buildPackageIdentityKey(
  name: string,
  version: string,
  registrySource: string,
  tarballHash: string
): string {
  return `${registrySource}:${name}:${version}:${tarballHash}`;
}
