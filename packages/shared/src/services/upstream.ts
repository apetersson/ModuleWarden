import type { NpmPackument } from '@modulewarden/shared/npm-types';
import { createHash } from 'node:crypto';

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

/**
/**
 * Stream a tarball from upstream into a Verdaccio instance.
 * Verifies the tarball integrity hash before promoting (H-2).
 */
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
    : integrity.startsWith('sha256-') || integrity.startsWith('sha384-') ? 'sha256'
    : 'sha256';
  const expectedHash = integrity.replace(/^(sha512|sha256|sha384)-/, '');
  const actualHash = createHash(hashAlgo).update(buf).digest('base64');
  if (actualHash !== expectedHash) {
    throw new Error(
      `Integrity mismatch for ${packageName}@${packageVersion}: ` +
      `expected ${hashAlgo}-${expectedHash.slice(0, 16)}..., got ${actualHash.slice(0, 16)}...`
    );
  }

  // Hash verified — promote to Verdaccio
  const unscopedName = packageName.startsWith('@') ? packageName.split('/')[1] : packageName;
  const filename = `${unscopedName}-${packageVersion}.tgz`;
  const putUrl = `${verdaccioUrl}/${encodeURIComponent(packageName)}/-/${encodeURIComponent(filename)}`;

  const response = await fetch(putUrl, {
    method: 'PUT',
    headers: {
      'Content-Type': tarball.contentType,
      'Content-Length': String(totalLen),
      Authorization: `Bearer ${verdaccioToken}`,
    },
    body: buf,
  });

  if (!response.ok) {
    const body = await response.text().catch(() => '(empty)');
    throw new Error(
      `Verdaccio promotion failed for ${packageName}@${packageVersion}: ` +
        `${response.status} ${body.slice(0, 200)}`
    );
  }
}
