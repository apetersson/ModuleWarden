import { describe, it, expect } from 'vitest';
import { filterToApproved, isVersionAllowed, isVersionDenied } from '../services/filter.js';
import type { VersionDecision } from '../services/filter.js';
import type { NpmPackument, NpmPackageVersion } from '@modulewarden/shared/npm-types';

function makePackument(versions: string[]): NpmPackument {
  const versionMap: Record<string, NpmPackageVersion> = {};
  for (const v of versions) {
    versionMap[v] = {
      name: 'test-pkg',
      version: v,
      dist: {
        tarball: `https://registry.npmjs.org/test-pkg/-/test-pkg-${v}.tgz`,
        integrity: `sha512-${v}`,
      },
    };
  }
  return {
    name: 'test-pkg',
    'dist-tags': { latest: versions[versions.length - 1] || '1.0.0' },
    versions: versionMap,
  };
}

function decisions(...allowVersions: string[]): Map<string, VersionDecision> {
  const map = new Map<string, VersionDecision>();
  for (const v of allowVersions) {
    map.set(v, { version: v, verdict: 'ALLOW', tarballHash: `hash-${v}` });
  }
  return map;
}

function addDecision(map: Map<string, VersionDecision>, version: string, verdict: 'ALLOW' | 'BLOCK' | 'QUARANTINE') {
  map.set(version, { version, verdict, tarballHash: `hash-${version}` });
}

describe('filterToApproved', () => {
  it('returns only allowed versions as non-deprecated', () => {
    const packument = makePackument(['1.0.0', '1.1.0', '2.0.0']);
    const decs = decisions('1.0.0', '2.0.0');

    const filtered = filterToApproved(packument, decs);

    expect(filtered.versions['1.0.0'].deprecated).toBeUndefined();
    expect(filtered.versions['2.0.0'].deprecated).toBeUndefined();
    expect(filtered.versions['1.1.0']).toBeDefined();
  });

  it('marks blocked versions as deprecated with explanation', () => {
    const packument = makePackument(['1.0.0', '1.1.0']);
    const decs = new Map<string, VersionDecision>();
    addDecision(decs, '1.0.0', 'ALLOW');
    addDecision(decs, '1.1.0', 'BLOCK');

    const filtered = filterToApproved(packument, decs);

    expect(filtered.versions['1.1.0'].deprecated).toContain('BLOCKED');
  });

  it('marks quarantined versions as deprecated', () => {
    const packument = makePackument(['1.0.0']);
    const decs = new Map<string, VersionDecision>();
    addDecision(decs, '1.0.0', 'QUARANTINE');

    const filtered = filterToApproved(packument, decs);

    expect(filtered.versions['1.0.0'].deprecated).toContain('QUARANTINED');
  });

  it('marks unreviewed versions as deprecated', () => {
    const packument = makePackument(['1.0.0']);
    const decs = new Map<string, VersionDecision>();

    const filtered = filterToApproved(packument, decs);

    expect(filtered.versions['1.0.0'].deprecated).toContain('UNREVIEWED');
  });

  it('rewrites dist-tags to newest allowed version', () => {
    const packument = makePackument(['1.0.0', '1.1.0', '2.0.0']);
    const decs = decisions('1.0.0');
    packument['dist-tags'] = { latest: '2.0.0', stable: '1.1.0' };

    const filtered = filterToApproved(packument, decs);

    // latest should be rewritten to 1.0.0 (the only allowed version)
    expect(filtered['dist-tags'].latest).toBe('1.0.0');
    expect(filtered['dist-tags'].stable).toBe('1.0.0');
  });

  it('omits tags when no allowed versions exist', () => {
    const packument = makePackument(['1.0.0']);
    const decs = new Map<string, VersionDecision>();

    const filtered = filterToApproved(packument, decs);

    expect(filtered['dist-tags'].latest).toBeUndefined();
  });

  it('preserves packument metadata', () => {
    const packument = makePackument(['1.0.0']);
    packument.description = 'Test package';
    packument.license = 'MIT';
    packument.homepage = 'https://example.com';
    const decs = decisions('1.0.0');

    const filtered = filterToApproved(packument, decs);

    expect(filtered.description).toBe('Test package');
    expect(filtered.license).toBe('MIT');
    expect(filtered.homepage).toBe('https://example.com');
  });

  it('includes repository when present', () => {
    const packument = makePackument(['1.0.0']);
    packument.repository = { type: 'git', url: 'https://github.com/test/pkg.git' } as any;
    const decs = decisions('1.0.0');

    const filtered = filterToApproved(packument, decs);

    expect(filtered.repository).toBeDefined();
    expect(filtered.repository!.url).toBe('https://github.com/test/pkg.git');
  });

  it('handles empty packument', () => {
    const packument = makePackument([]);
    const decs = new Map<string, VersionDecision>();

    const filtered = filterToApproved(packument, decs);

    expect(Object.keys(filtered.versions)).toHaveLength(0);
    expect(filtered.name).toBe('test-pkg');
  });
});

describe('isVersionAllowed / isVersionDenied', () => {
  it('detects allowed versions', () => {
    const decs = decisions('1.0.0');
    expect(isVersionAllowed('1.0.0', decs)).toBe(true);
    expect(isVersionAllowed('1.1.0', decs)).toBe(false);
  });

  it('detects denied versions', () => {
    const decs = new Map<string, VersionDecision>();
    decs.set('1.0.0', { version: '1.0.0', verdict: 'BLOCK', tarballHash: 'hash' });
    decs.set('1.1.0', { version: '1.1.0', verdict: 'QUARANTINE', tarballHash: 'hash' });

    expect(isVersionDenied('1.0.0', decs)).toBe(true);
    expect(isVersionDenied('1.1.0', decs)).toBe(true);
    expect(isVersionDenied('1.2.0', decs)).toBe(false);
  });
});
