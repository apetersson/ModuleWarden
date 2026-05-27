import type { NpmPackument } from '@modulewarden/shared/npm-types';

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
    throw new Error(`Failed to fetch upstream packument for ${packageName}: ${message}`);
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
    throw new Error(`Failed to fetch upstream tarball: ${message}`);
  }
}

/**
 * Stream a tarball from upstream into a Verdaccio instance.
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

  // Publish to Verdaccio using npm publish API
  // Verdaccio API: PUT /:package/-/:filename
  const filename = `${packageName}-${packageVersion}.tgz`;
  const putUrl = `${verdaccioUrl}/${encodeURIComponent(packageName)}/-/${encodeURIComponent(filename)}`;

  const response = await fetch(putUrl, {
    method: 'PUT',
    headers: {
      'Content-Type': tarball.contentType,
      'Content-Length': String(tarball.contentLength ?? 0),
      Authorization: `Bearer ${verdaccioToken}`,
    },
    body: tarball.stream,
  });

  if (!response.ok) {
    const body = await response.text().catch(() => '(empty)');
    throw new Error(
      `Verdaccio promotion failed for ${packageName}@${packageVersion}: ` +
        `${response.status} ${body.slice(0, 200)}`
    );
  }
}
