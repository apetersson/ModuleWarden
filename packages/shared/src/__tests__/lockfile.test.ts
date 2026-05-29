import { describe, it, expect } from 'vitest';
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { parseLockfile, parseLockfileContent } from '../services/lockfile';

function withTempDir(fn: (dir: string) => void) {
  const dir = mkdtempSync(join(tmpdir(), 'lockfile-test-'));
  try {
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('parseLockfile — npm', () => {
  it('parses npm v7+ lockfile (packages format)', () => {
    withTempDir((dir) => {
      const path = join(dir, 'package-lock.json');
      writeFileSync(path, JSON.stringify({
        name: 'test-project',
        lockfileVersion: 3,
        packages: {
          '': { name: 'test-project' },
          'node_modules/lodash': {
            version: '4.17.21',
            integrity: 'sha512-hash-lodash',
            resolved: 'https://registry.npmjs.org/lodash/-/lodash-4.17.21.tgz',
          },
          'node_modules/express': {
            version: '4.18.2',
            integrity: 'sha512-hash-express',
            dependencies: { accepts: '1.3.8' },
          },
        },
      }, null, 2));

      const result = parseLockfile(path);
      expect(result.format).toBe('npm');
      expect(result.entries).toHaveLength(2);
      expect(result.entries[0]!.packageName).toBe('lodash');
      expect(result.entries[0]!.version).toBe('4.17.21');
      expect(result.entries[1]!.packageName).toBe('express');
      expect(result.entries[1]!.version).toBe('4.18.2');
    });
  });

  it('parses npm v6 lockfile (dependencies format)', () => {
    withTempDir((dir) => {
      const path = join(dir, 'package-lock.json');
      writeFileSync(path, JSON.stringify({
        name: 'test',
        version: '1.0.0',
        lockfileVersion: 1,
        dependencies: {
          lodash: {
            version: '4.17.21',
            integrity: 'sha512-hash-lodash',
          },
        },
      }, null, 2));

      const result = parseLockfile(path);
      expect(result.entries).toHaveLength(1);
      expect(result.entries[0]!.packageName).toBe('lodash');
    });
  });

  it('handles empty or malformed npm lockfiles', () => {
    withTempDir((dir) => {
      const path = join(dir, 'package-lock.json');
      writeFileSync(path, 'not valid json');

      const result = parseLockfile(path);
      expect(result.errors.length).toBeGreaterThan(0);
      expect(result.entries).toHaveLength(0);
    });
  });
});

describe('parseLockfile — pnpm', () => {
  it('parses pnpm v5/v6 lockfile (leading slash keys)', () => {
    withTempDir((dir) => {
      const path = join(dir, 'pnpm-lock.yaml');
      writeFileSync(path, [
        "lockfileVersion: '6.0'",
        '',
        'packages:',
        '  /lodash@4.17.21:',
        '    resolution:',
        '      integrity: sha512-hash-lodash',
        '    dev: false',
        '  /express@4.18.2:',
        '    resolution:',
        '      integrity: sha512-hash-express',
        '    dependencies:',
        '      accepts: 1.3.8',
        '',
      ].join('\n'));

      const result = parseLockfile(path);
      expect(result.format).toBe('pnpm');
      expect(result.entries).toHaveLength(2);
      expect(result.entries[0]!.packageName).toBe('lodash');
      expect(result.entries[0]!.version).toBe('4.17.21');
      expect(result.entries[1]!.packageName).toBe('express');
      expect(result.entries[1]!.version).toBe('4.18.2');
    });
  });

  it('parses pnpm v9 lockfile (no leading slash for unscoped packages)', () => {
    // pnpm v9 format: unscoped packages don't have leading slash
    const content = [
      "lockfileVersion: '9.0'",
      '',
      'settings:',
      '  autoInstallPeers: true',
      '  excludeLinksFromLockfile: false',
      '',
      'importers:',
      '  .:',
      '    dependencies:',
      '      lodash:',
      '        specifier: ^4.17.21',
      '        version: 4.17.21',
      '      express:',
      '        specifier: ^4.18.0',
      '        version: 4.18.2',
      '',
      'packages:',
      '  lodash@4.17.21:',
      '    resolution:',
      '      integrity: sha512-hash-lodash-v9',
      '    dev: false',
      '  express@4.18.2:',
      '    resolution:',
      '      integrity: sha512-hash-express-v9',
      '    dependencies:',
      '      accepts: 1.3.8',
      '  /@scope/name@2.0.0:',
      '    resolution:',
      '      integrity: sha512-scoped-v9',
      '    dev: false',
      '',
      'snapshots:',
      '  lodash@4.17.21:',
      '    dev: false',
      '  express@4.18.2:',
      '    dependencies:',
      '      accepts: 1.3.8',
      '  /@scope/name@2.0.0:',
      '    dev: false',
    ].join('\n');

    const result = parseLockfileContent(content, 'pnpm');
    expect(result.format).toBe('pnpm');
    expect(result.entries).toHaveLength(3);
    expect(result.entries[0]!.packageName).toBe('lodash');
    expect(result.entries[0]!.version).toBe('4.17.21');
    expect(result.entries[0]!.integrity).toBe('sha512-hash-lodash-v9');
    expect(result.entries[1]!.packageName).toBe('express');
    expect(result.entries[1]!.version).toBe('4.18.2');
    expect(result.entries[2]!.packageName).toBe('@scope/name');
    expect(result.entries[2]!.version).toBe('2.0.0');
  });
});

describe('parseLockfile — yarn', () => {
  it('parses yarn.lock format', () => {
    withTempDir((dir) => {
      const path = join(dir, 'yarn.lock');
      writeFileSync(path, [
        '# THIS IS AN AUTOGENERATED FILE. DO NOT EDIT THIS FILE DIRECTLY.',
        '# yarn lockfile v1',
        '',
        'lodash@^4.17.21:',
        '  version "4.17.21"',
        '  integrity sha512-hash-lodash',
        '  resolved "https://registry.yarnpkg.com/lodash/-/lodash-4.17.21.tgz"',
        '',
        'express@^4.18.0:',
        '  version "4.18.2"',
        '  integrity sha512-hash-express',
        '',
      ].join('\n'));

      const result = parseLockfile(path);
      expect(result.format).toBe('yarn');
      expect(result.entries).toHaveLength(2);
      expect(result.entries[0]!.packageName).toBe('lodash');
      expect(result.entries[0]!.version).toBe('4.17.21');
    });
  });
});

describe('parseLockfileContent — direct content parsing', () => {
  it('parses npm lockfile from content', () => {
    const content = JSON.stringify({
      name: 'test',
      lockfileVersion: 3,
      packages: {
        'node_modules/left-pad': {
          version: '1.3.0',
          integrity: 'sha512-hash',
        },
      },
    });
    const result = parseLockfileContent(content, 'npm');
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]!.packageName).toBe('left-pad');
  });

  it('auto-detects format from content', () => {
    const content = JSON.stringify({
      name: 'test',
      lockfileVersion: 3,
      packages: {},
    });
    const result = parseLockfileContent(content);
    expect(result.format).toBe('npm');
  });

  it('rejects unrecognized format', () => {
    const result = parseLockfileContent('some random text');
    expect(result.entries).toHaveLength(0);
    expect(result.errors.length).toBeGreaterThan(0);
  });
});

describe('parseLockfile — detection', () => {
  it('rejects unknown filename', () => {
    withTempDir((dir) => {
      const path = join(dir, 'unknown.lock');
      writeFileSync(path, '{}');

      const result = parseLockfile(path);
      expect(result.errors.length).toBeGreaterThan(0);
      expect(result.entries).toHaveLength(0);
    });
  });
});
