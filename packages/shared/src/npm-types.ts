/**
 * npm registry packument (package document) types.
 * https://github.com/npm/registry/blob/main/docs/responses/package-metadata.md
 */

export interface NpmDistTag {
  [tag: string]: string;
}

export interface NpmPackageVersion {
  name: string;
  version: string;
  dist: {
    tarball: string;
    integrity: string;
    shasum?: string;
    fileCount?: number;
    unpackedSize?: number;
    signatures?: Array<{ keyid: string; sig: string }>;
  };
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  [key: string]: unknown;
}

export interface NpmPackument {
  name: string;
  'dist-tags': NpmDistTag;
  versions: Record<string, NpmPackageVersion>;
  time?: Record<string, string>;
  description?: string;
  license?: string;
  readme?: string;
  homepage?: string;
  repository?: { type: string; url: string };
  bugs?: { url: string };
  [key: string]: unknown;
}

/**
 * Approved-only filtered packument returned to npm clients.
 * - `versions` only contains approved package versions
 * - `dist-tags` is rewritten to newest approved versions
 * - Blocked/quarantined/unreviewed versions are excluded
 */
export interface FilteredPackument {
  name: string;
  'dist-tags': NpmDistTag;
  versions: Record<string, NpmPackageVersion>;
  description?: string;
  license?: string;
  homepage?: string;
  repository?: { type: string; url: string };
  modified: string;
}

/**
 * Error response body sent to npm clients when a version is
 * unapproved, blocked, or the project is not yet ready.
 */
export interface RegistryError {
  error: string;
  reason: string;
  package: string;
  requestedVersion?: string;
  statusUrl?: string;
  cliCommand?: string;
}
