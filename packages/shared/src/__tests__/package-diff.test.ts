/**
 * Tarball unpacking tests.
 *
 * Covers:
 * - Normal npm tarballs unpack with the same listing as before
 * - Shell metacharacters in entry names are treated as data (no command runs)
 * - Path traversal, absolute names and escaping links are refused
 *
 * Tarballs are built in memory from the entries below; nothing touches the network.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { gzipSync } from 'node:zlib';
import { diffTarballs, unpackTarball, UnsafeTarballError } from '../services/package-diff.js';

// ── Minimal ustar writer for fixtures ──────────────────────

interface FixtureEntry {
  name: string;
  type?: 'file' | 'directory' | 'symlink' | 'hardlink';
  content?: string;
  mode?: number;
  linkTarget?: string;
}

const TYPEFLAGS = { file: '0', directory: '5', symlink: '2', hardlink: '1' } as const;

function octal(value: number, width: number): string {
  return value.toString(8).padStart(width - 1, '0') + '\0';
}

function tarHeader(
  name: string,
  typeflag: string,
  size: number,
  mode: number,
  linkname = ''
): Buffer {
  const block = Buffer.alloc(512);
  block.write(name, 0, 100, 'utf-8');
  block.write(octal(mode, 8), 100, 'latin1');
  block.write(octal(0, 8), 108, 'latin1');
  block.write(octal(0, 8), 116, 'latin1');
  block.write(octal(size, 12), 124, 'latin1');
  block.write(octal(0, 12), 136, 'latin1');
  block.write(typeflag, 156, 'latin1');
  block.write(linkname, 157, 100, 'utf-8');
  block.write('ustar\0', 257, 'latin1');
  block.write('00', 263, 'latin1');
  block.fill(0x20, 148, 156);
  const sum = block.reduce((acc, byte) => acc + byte, 0);
  block.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 'latin1');
  return block;
}

function padToBlock(data: Buffer): Buffer {
  return Buffer.concat([data, Buffer.alloc((512 - (data.length % 512)) % 512)]);
}

/** One pax record; its length prefix counts itself. */
function paxRecord(key: string, value: string): string {
  const body = ` ${key}=${value}\n`;
  let length = Buffer.byteLength(body) + 1;
  while (String(length).length + Buffer.byteLength(body) !== length) {
    length = String(length).length + Buffer.byteLength(body);
  }
  return `${length}${body}`;
}

function buildTarGz(entries: FixtureEntry[]): Buffer {
  const blocks: Buffer[] = [];
  for (const entry of entries) {
    const type = entry.type ?? 'file';
    const data = Buffer.from(type === 'file' ? (entry.content ?? '') : '', 'utf-8');
    const linkname = entry.linkTarget ?? '';
    // Names over 100 bytes go in a pax header, as npm's packer does.
    if (Buffer.byteLength(entry.name) > 100 || Buffer.byteLength(linkname) > 100) {
      const pax = Buffer.from(
        paxRecord('path', entry.name) + (linkname ? paxRecord('linkpath', linkname) : ''),
        'utf-8'
      );
      blocks.push(tarHeader('PaxHeader', 'x', pax.length, 0o644), padToBlock(pax));
    }
    const mode = entry.mode ?? (type === 'directory' ? 0o755 : 0o644);
    blocks.push(
      tarHeader(entry.name, TYPEFLAGS[type], data.length, mode, linkname),
      padToBlock(data)
    );
  }
  blocks.push(Buffer.alloc(1024)); // end-of-archive marker
  return gzipSync(Buffer.concat(blocks));
}

// ── Tests ──────────────────────────────────────────────────

describe('unpackTarball', () => {
  let work: string;
  let dest: string;

  const writeTarball = (entries: FixtureEntry[], fileName = 'pkg.tgz'): string => {
    const path = join(work, fileName);
    writeFileSync(path, buildTarGz(entries));
    return path;
  };

  beforeEach(() => {
    work = mkdtempSync(join(tmpdir(), 'mw-unpack-test-'));
    dest = join(work, 'dest');
    mkdirSync(dest);
  });

  afterEach(() => {
    rmSync(work, { recursive: true, force: true });
  });

  describe('normal tarballs', () => {
    it('unpacks an npm-style tarball with contents, modes and long names', () => {
      const longName = `package/lib/${'a'.repeat(120)}.js`;
      const tarball = writeTarball([
        { name: 'package/package.json', content: '{"name":"demo","version":"1.0.0"}' },
        { name: 'package/index.js', content: 'module.exports = 1;\n' },
        { name: 'package/lib', type: 'directory' },
        { name: 'package/lib/util.js', content: 'exports.x = 2;\n' },
        { name: longName, content: 'long' },
        { name: 'package/bin/cli.js', content: '#!/usr/bin/env node\n', mode: 0o755 },
      ]);

      const entries = unpackTarball(tarball, dest);
      const byPath = new Map(entries.map((e) => [e.path, e]));

      expect([...byPath.keys()].sort()).toEqual(
        [
          '/',
          'package',
          'package/bin',
          'package/bin/cli.js',
          'package/index.js',
          'package/lib',
          longName,
          'package/lib/util.js',
          'package/package.json',
        ].sort()
      );
      expect(byPath.get('/')?.isDir).toBe(true);
      expect(byPath.get('package/lib')?.isDir).toBe(true);
      expect(byPath.get('package/index.js')).toMatchObject({
        size: 20,
        isDir: false,
        isExecutable: false,
      });
      expect(byPath.get('package/index.js')?.mode).toMatch(/^-rw/);
      expect(byPath.get('package/bin/cli.js')).toMatchObject({ isDir: false, isExecutable: true });
      expect(byPath.get('package/bin/cli.js')?.mode).toMatch(/^-rwx/);
      expect(readFileSync(join(dest, 'package', 'lib', 'util.js'), 'utf-8')).toBe(
        'exports.x = 2;\n'
      );
      expect(readFileSync(join(dest, ...longName.split('/')), 'utf-8')).toBe('long');
    });

    it('unpacks a tarball written by the system tar binary', () => {
      const src = join(work, 'src', 'package');
      mkdirSync(join(src, 'bin'), { recursive: true });
      writeFileSync(join(src, 'package.json'), '{"name":"demo"}');
      writeFileSync(join(src, 'bin', 'cli.js'), '#!/usr/bin/env node\n', { mode: 0o755 });
      const tarball = join(work, 'system.tgz');
      // argv array, no shell; COPYFILE_DISABLE stops macOS tar adding ._ files
      execFileSync('tar', ['-czf', tarball, '-C', join(work, 'src'), 'package'], {
        env: { ...process.env, COPYFILE_DISABLE: '1' },
        stdio: 'pipe',
      });

      const entries = unpackTarball(tarball, dest);
      const byPath = new Map(entries.map((e) => [e.path, e]));

      expect([...byPath.keys()].sort()).toEqual(
        ['/', 'package', 'package/bin', 'package/bin/cli.js', 'package/package.json'].sort()
      );
      expect(byPath.get('package/bin/cli.js')?.isExecutable).toBe(true);
      expect(byPath.get('package/package.json')).toMatchObject({ size: 15, isExecutable: false });
    });

    it('diffTarballs reports added, removed and changed files', () => {
      const oldTarball = writeTarball(
        [
          { name: 'package/package.json', content: '{}' },
          { name: 'package/index.js', content: 'a' },
          { name: 'package/old.js', content: 'old' },
          { name: 'package/run.sh', content: 'echo hi\n', mode: 0o644 },
        ],
        'old.tgz'
      );
      const newTarball = writeTarball(
        [
          { name: 'package/package.json', content: '{}' },
          { name: 'package/index.js', content: 'aa' },
          { name: 'package/new.js', content: 'new' },
          { name: 'package/run.sh', content: 'echo hi\n', mode: 0o755 },
        ],
        'new.tgz'
      );

      const diff = diffTarballs(oldTarball, newTarball);

      expect(diff.added.map((f) => f.path)).toEqual(['package/new.js']);
      expect(diff.removed.map((f) => f.path)).toEqual(['package/old.js']);
      expect(diff.changed.map((c) => [c.path, c.oldSize, c.newSize]).sort()).toEqual([
        ['package/index.js', 1, 2],
        ['package/run.sh', 8, 8],
      ]);
    });

    it('keeps a symlink that stays inside the package', () => {
      const tarball = writeTarball([
        { name: 'package/index.js', content: 'module.exports = 1;\n' },
        { name: 'package/alias.js', type: 'symlink', linkTarget: 'index.js' },
      ]);

      const entries = unpackTarball(tarball, dest);

      const alias = entries.find((e) => e.path === 'package/alias.js');
      expect(alias?.mode).toMatch(/^l/);
      expect(alias?.isDir).toBe(false);
      expect(readlinkSync(join(dest, 'package', 'alias.js'))).toBe('index.js');
    });
  });

  describe('shell metacharacters in entry names', () => {
    // Before this fix every listed path was interpolated into
    // `stat ... "<path>"` and `test -d "<path>"` shell strings, so each of
    // these names ran `touch` on the machine doing the check. The canary path
    // is passed through the environment so the payload stays one path segment.
    const payloads: Array<[string, string]> = [
      ['$(...)', 'package/$(touch $MW_TEST_CANARY)'],
      ['backticks', 'package/`touch $MW_TEST_CANARY`'],
      ['quote and ;', 'package/x"; touch $MW_TEST_CANARY; echo "'],
    ];

    afterEach(() => {
      delete process.env.MW_TEST_CANARY;
    });

    it.each(payloads)('treats %s in an entry name as data, not a command', (_label, name) => {
      const canary = join(work, 'pwned');
      process.env.MW_TEST_CANARY = canary;
      const tarball = writeTarball([
        { name: 'package/package.json', content: '{}' },
        { name, content: 'payload' },
      ]);

      const entries = unpackTarball(tarball, dest);

      expect(existsSync(canary)).toBe(false);
      expect(entries.map((e) => e.path)).toContain(name);
      expect(readFileSync(join(dest, ...name.split('/')), 'utf-8')).toBe('payload');
    });
  });

  describe('path traversal', () => {
    it.each(['../evil', 'package/../../evil'])(
      'refuses the entry %s and writes nothing',
      (name) => {
        const tarball = writeTarball([
          { name: 'package/index.js', content: 'ok' },
          { name, content: 'pwned' },
        ]);

        expect(() => unpackTarball(tarball, dest)).toThrow(UnsafeTarballError);
        expect(existsSync(join(work, 'evil'))).toBe(false);
        expect(readdirSync(dest)).toEqual([]);
      }
    );

    it('refuses an absolute entry name', () => {
      const outside = join(work, 'abs-evil');
      const tarball = writeTarball([{ name: outside, content: 'pwned' }]);

      expect(() => unpackTarball(tarball, dest)).toThrow(UnsafeTarballError);
      expect(existsSync(outside)).toBe(false);
      expect(readdirSync(dest)).toEqual([]);
    });

    it.each(['../../outside', '/etc'])('refuses a symlink pointing to %s', (linkTarget) => {
      const tarball = writeTarball([
        { name: 'package/index.js', content: 'ok' },
        { name: 'package/link', type: 'symlink', linkTarget },
      ]);

      expect(() => unpackTarball(tarball, dest)).toThrow(UnsafeTarballError);
      expect(lstatSync(join(dest, 'package', 'link'), { throwIfNoEntry: false })).toBeUndefined();
    });

    it('refuses a symlink that escapes through another symlink', () => {
      // Each target looks inside on its own; together `escape` resolves to dest/..
      const tarball = writeTarball([
        { name: 'package/up', type: 'symlink', linkTarget: '..' },
        { name: 'package/escape', type: 'symlink', linkTarget: 'up/..' },
      ]);

      expect(() => unpackTarball(tarball, dest)).toThrow(UnsafeTarballError);
      expect(lstatSync(join(dest, 'package', 'up'), { throwIfNoEntry: false })).toBeUndefined();
      expect(lstatSync(join(dest, 'package', 'escape'), { throwIfNoEntry: false })).toBeUndefined();
    });

    it('refuses an entry written through a symlink', () => {
      const tarball = writeTarball([
        { name: 'package/real', type: 'directory' },
        { name: 'package/link', type: 'symlink', linkTarget: 'real' },
        { name: 'package/link/file.js', content: 'via link' },
      ]);

      expect(() => unpackTarball(tarball, dest)).toThrow(UnsafeTarballError);
      expect(readdirSync(dest)).toEqual([]);
    });

    it.each(['../../outside.txt', '/etc/hosts'])('refuses a hard link to %s', (linkTarget) => {
      writeFileSync(join(work, 'outside.txt'), 'secret');
      const tarball = writeTarball([
        { name: 'package/index.js', content: 'ok' },
        { name: 'package/stolen', type: 'hardlink', linkTarget },
      ]);

      expect(() => unpackTarball(tarball, dest)).toThrow(UnsafeTarballError);
      expect(readdirSync(dest)).toEqual([]);
    });
  });
});
