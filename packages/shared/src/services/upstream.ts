import type { NpmPackument } from '@modulewarden/shared/npm-types';
import { createHash } from 'node:crypto';
import { Buffer } from 'node:buffer';

const NPM_REGISTRY = 'https://registry.npmjs.org';

/**
 * Fetch a packument from the upstream npm registry.
 * Used to discover package metadata before filtering to approved versions.
 */
export async function fetchUpstreamPackument(packageName: string): Promise<NpmPackument | null> {
  try {
    const response = await fetch(`${NPM_REGISTRY}/${encodeURIComponent(packageName)}`, {
      headers: {
        Accept: 'application/vnd.npm.install-v1+json',
      },
    });

    if (!response.ok) {
      if (response.status === 404) return null;
      throw new Error(`Upstream registry returned ${response.status} for ${packageName}`);
    }

    return (await response.json()) as NpmPackument;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to fetch upstream packument for ${packageName}: ${message}`, { cause: err });
  }
}

/**
 * Fetch the FULL (unabbreviated) packument from upstream npm.
 * The abbreviated format (application/vnd.npm.install-v1+json) omits
 * metadata fields like repository, homepage, license needed for git
 * metric extraction.
 */
export async function fetchUpstreamPackumentFull(packageName: string): Promise<NpmPackument | null> {
  try {
    const response = await fetch(`${NPM_REGISTRY}/${encodeURIComponent(packageName)}`);

    if (!response.ok) {
      if (response.status === 404) return null;
      throw new Error(`Upstream registry returned ${response.status} for ${packageName}`);
    }

    return (await response.json()) as NpmPackument;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to fetch upstream packument for ${packageName}: ${message}`, { cause: err });
  }
}

/**
 * Fetch a tarball from the upstream npm registry.
 * Returns the raw response for streaming to the client or Verdaccio.
 */
export async function fetchUpstreamTarball(
  tarballUrl: string
): Promise<{ stream: ReadableStream; contentType: string; contentLength: number | null } | null> {
  try {
    const response = await fetch(tarballUrl);

    if (!response.ok) {
      if (response.status === 404) return null;
      throw new Error(`Upstream tarball fetch returned ${response.status}`);
    }

    const contentLength = response.headers.get('content-length');
    return {
      stream: response.body!,
      contentType: response.headers.get('content-type') || 'application/octet-stream',
      contentLength: contentLength ? parseInt(contentLength, 10) : null,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to fetch upstream tarball: ${message}`, { cause: err });
  }
}

export async function promoteTarballToVerdaccio(
  verdaccioUrl: string,
  packageName: string,
  packageVersion: string,
  tarballUrl: string,
  integrity: string,
  verdaccioToken: string
): Promise<void> {
  // Fetch the tarball from upstream
  const tarball = await fetchUpstreamTarball(tarballUrl);
  if (!tarball) {
    throw new Error(`Tarball not found upstream for ${packageName}@${packageVersion}`);
  }

  // Buffer the entire tarball to verify integrity before promoting (H-2, TOCTOU)
  const reader = tarball.stream.getReader();
  const chunks: Uint8Array[] = [];
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
  }
  const totalLen = chunks.reduce((a, c) => a + c.length, 0);
  const buf = new Uint8Array(totalLen);
  let offset = 0;
  for (const chunk of chunks) { buf.set(chunk, offset); offset += chunk.length; }

  // Verify integrity hash
  const hashAlgo = integrity.startsWith('sha512-') ? 'sha512'
    : integrity.startsWith('sha384-') ? 'sha384'
    : integrity.startsWith('sha256-') ? 'sha256'
    : 'sha256';
  const expectedHash = integrity.replace(/^(sha512|sha256|sha384)-/, '');
  const actualHash = createHash(hashAlgo).update(buf).digest('base64');
  if (actualHash !== expectedHash) {
    throw new Error(
      `Integrity mismatch for ${packageName}@${packageVersion}: ` +
      `expected ${hashAlgo}-${expectedHash.slice(0, 16)}..., got ${actualHash.slice(0, 16)}...`
    );
  }

  // Hash verified — publish to Verdaccio using the npm registry document API.
  const unscopedName = packageName.startsWith('@') ? packageName.split('/')[1] : packageName;
  const filename = `${unscopedName}-${packageVersion}.tgz`;
  const publishUrl = `${verdaccioUrl}/${encodeURIComponent(packageName)}`;
  const shasum = createHash('sha1').update(buf).digest('hex');
  const packument = await fetchUpstreamPackument(packageName);
  const upstreamVersion = packument?.versions?.[packageVersion] ?? {
    name: packageName,
    version: packageVersion,
    dist: { tarball: tarballUrl, integrity, shasum },
  };
  const verdaccioTarballUrl = `${verdaccioUrl}/${encodeURIComponent(packageName)}/-/${encodeURIComponent(filename)}`;
  const versionDocument = {
    ...upstreamVersion,
    name: packageName,
    version: packageVersion,
    dist: {
      ...(upstreamVersion.dist ?? {}),
      tarball: verdaccioTarballUrl,
      integrity,
      shasum,
    },
  };
  const publishDocument = {
    _id: packageName,
    name: packageName,
    description: packument?.description ?? '',
    'dist-tags': { latest: packageVersion },
    versions: {
      [packageVersion]: versionDocument,
    },
    _attachments: {
      [filename]: {
        content_type: tarball.contentType,
        data: Buffer.from(buf).toString('base64'),
        length: totalLen,
      },
    },
  };

  const response = await fetch(publishUrl, {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${verdaccioToken}`,
    },
    body: JSON.stringify(publishDocument),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => '(empty)');
    if (response.status === 409 && body.toLowerCase().includes('already present')) {
      return;
    }
    throw new Error(
      `Verdaccio promotion failed for ${packageName}@${packageVersion}: ` +
        `${response.status} ${body.slice(0, 200)}`
    );
  }
}
