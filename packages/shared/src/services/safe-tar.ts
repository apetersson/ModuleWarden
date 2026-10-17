/**
 * Shell-free, traversal-safe extraction of npm package tarballs (.tgz).
 *
 * Everything inside a package tarball is publisher-controlled: entry names,
 * link targets and modes. This reader never hands any of it to a shell or to
 * an external `tar` binary. It parses the whole archive in memory, refuses it
 * if any entry could land outside the target directory, and only then writes
 * to disk.
 *
 * A tarball is refused with UnsafeTarballError when it contains:
 * - an absolute entry name, or a name with a `..` segment;
 * - a symlink whose target is absolute or resolves outside the target
 *   directory, directly or through other links;
 * - a hard link to anything other than an earlier regular file in the archive;
 * - an entry that would be written through a symlink;
 * - a device, FIFO or other special entry;
 * - more than MAX_UNPACKED_BYTES of uncompressed data.
 */

import {
  linkSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, sep } from 'node:path';
import { gunzipSync } from 'node:zlib';

/** Upper bound on the decompressed archive size (archive-bomb guard). */
export const MAX_UNPACKED_BYTES = 1024 * 1024 * 1024;

export class UnsafeTarballError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnsafeTarballError';
  }
}

type EntryType = 'file' | 'directory' | 'symlink' | 'hardlink';

interface TarEntry {
  /** Relative, '/'-separated path with no empty, '.' or '..' segments. */
  path: string;
  type: EntryType;
  /** Permission bits from the header (0o777 mask). */
  mode: number;
  /** File content; empty for anything but regular files. */
  data: Buffer;
  /** Symlink target as stored, or the normalised archive path a hard link points to. */
  linkTarget: string;
}

const BLOCK_SIZE = 512;

/**
 * Extract a gzipped tarball into an existing directory without a shell.
 * Throws UnsafeTarballError (before writing anything, where the archive
 * itself shows the problem) if an entry could escape `targetDir`.
 */
export function extractTarballSafely(tarballPath: string, targetDir: string): void {
  const entries = readEntries(decompress(readFileSync(tarballPath)));
  checkEntries(entries);
  writeEntries(entries, targetDir);
}

// ── Parsing ────────────────────────────────────────────────

function decompress(compressed: Buffer): Buffer {
  try {
    return gunzipSync(compressed, { maxOutputLength: MAX_UNPACKED_BYTES });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ERR_BUFFER_TOO_LARGE') {
      throw new UnsafeTarballError(`tarball unpacks to more than ${MAX_UNPACKED_BYTES} bytes`);
    }
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Tarball is not valid gzip: ${message}`, { cause: err });
  }
}

function readEntries(archive: Buffer): TarEntry[] {
  const entries: TarEntry[] = [];
  // Extended headers apply to the next real entry only.
  let pax = new Map<string, string>();
  let longName: string | undefined;
  let longLink: string | undefined;
  let offset = 0;

  while (offset + BLOCK_SIZE <= archive.length) {
    const header = archive.subarray(offset, offset + BLOCK_SIZE);
    if (header.every((byte) => byte === 0)) break; // end-of-archive marker
    if (!checksumMatches(header)) {
      throw new UnsafeTarballError(`corrupt tar header at offset ${offset}`);
    }

    const typeflag = String.fromCharCode(header[156] ?? 0);
    const isExtension =
      typeflag === 'x' || typeflag === 'g' || typeflag === 'L' || typeflag === 'K';
    const paxSize = isExtension ? undefined : pax.get('size');
    const size = paxSize === undefined ? readNumber(header, 124, 12) : parseDecimal(paxSize);
    const dataStart = offset + BLOCK_SIZE;
    if (dataStart + size > archive.length) {
      throw new UnsafeTarballError(`truncated tar archive at offset ${offset}`);
    }
    const data = archive.subarray(dataStart, dataStart + size);
    offset = dataStart + Math.ceil(size / BLOCK_SIZE) * BLOCK_SIZE;

    if (typeflag === 'x') {
      pax = parsePax(data);
      continue;
    }
    if (typeflag === 'g') {
      // A global header that renames or resizes entries is never produced by
      // npm and would make every later name ambiguous.
      const global = parsePax(data);
      if (global.has('path') || global.has('linkpath') || global.has('size')) {
        throw new UnsafeTarballError('global pax header overrides entry names or sizes');
      }
      continue;
    }
    if (typeflag === 'L') {
      longName = readString(data, 0, data.length);
      continue;
    }
    if (typeflag === 'K') {
      longLink = readString(data, 0, data.length);
      continue;
    }

    const rawName = pax.get('path') ?? longName ?? headerName(header);
    const rawLink = pax.get('linkpath') ?? longLink ?? readString(header, 157, 100);
    pax = new Map();
    longName = undefined;
    longLink = undefined;

    const entry = toEntry(typeflag, rawName, rawLink, readNumber(header, 100, 8) & 0o777, data);
    if (entry) entries.push(entry);
  }

  return entries;
}

function toEntry(
  typeflag: string,
  rawName: string,
  rawLink: string,
  mode: number,
  data: Buffer
): TarEntry | null {
  let type: EntryType;
  switch (typeflag) {
    case '0':
    case '\0':
    case '7':
      // Pre-POSIX archives mark directories with a trailing slash.
      type = rawName.endsWith('/') ? 'directory' : 'file';
      break;
    case '5':
      type = 'directory';
      break;
    case '2':
      type = 'symlink';
      break;
    case '1':
      type = 'hardlink';
      break;
    default:
      throw new UnsafeTarballError(
        `entry ${JSON.stringify(rawName)} has unsupported type ${JSON.stringify(typeflag)}`
      );
  }

  const path = normaliseEntryPath(rawName);
  if (path === '') {
    if (type === 'directory') return null; // "./" names the target directory itself
    throw new UnsafeTarballError(`entry ${JSON.stringify(rawName)} has no file name`);
  }

  let linkTarget = '';
  if (type === 'symlink') linkTarget = rawLink;
  if (type === 'hardlink') linkTarget = normaliseEntryPath(rawLink);

  return { path, type, mode, data: type === 'file' ? data : Buffer.alloc(0), linkTarget };
}

function headerName(header: Buffer): string {
  const name = readString(header, 0, 100);
  // Only POSIX ustar uses the prefix field; GNU tar stores other data there.
  const isUstar = header.subarray(257, 263).toString('latin1') === 'ustar\0';
  const prefix = isUstar ? readString(header, 345, 155) : '';
  return prefix ? `${prefix}/${name}` : name;
}

function readString(buf: Buffer, start: number, length: number): string {
  const field = buf.subarray(start, start + length);
  const nul = field.indexOf(0);
  return field.subarray(0, nul === -1 ? field.length : nul).toString('utf-8');
}

/** Read an octal header number, or a GNU base-256 one (high bit set). */
function readNumber(buf: Buffer, start: number, length: number): number {
  const field = buf.subarray(start, start + length);
  const first = field[0] ?? 0;
  if (first & 0x80) {
    if (first & 0x40) throw new UnsafeTarballError('negative number in tar header');
    let value = first & 0x3f;
    for (const byte of field.subarray(1)) value = value * 256 + byte;
    if (!Number.isSafeInteger(value)) {
      throw new UnsafeTarballError('number too large in tar header');
    }
    return value;
  }
  const text = readString(buf, start, length).trim();
  if (text === '') return 0;
  if (!/^[0-7]+$/.test(text)) {
    throw new UnsafeTarballError(`invalid number ${JSON.stringify(text)} in tar header`);
  }
  return parseInt(text, 8);
}

function parseDecimal(text: string): number {
  if (!/^\d+$/.test(text) || !Number.isSafeInteger(Number(text))) {
    throw new UnsafeTarballError(`invalid pax size ${JSON.stringify(text)}`);
  }
  return Number(text);
}

/** Accept the standard unsigned checksum and the signed variant old tars wrote. */
function checksumMatches(header: Buffer): boolean {
  const stored = readNumber(header, 148, 8);
  let unsigned = 0;
  let signed = 0;
  for (let i = 0; i < BLOCK_SIZE; i++) {
    const byte = i >= 148 && i < 156 ? 0x20 : (header[i] ?? 0);
    unsigned += byte;
    signed += byte > 127 ? byte - 256 : byte;
  }
  return stored === unsigned || stored === signed;
}

/** Parse pax records of the form "<length> <key>=<value>\n". */
function parsePax(data: Buffer): Map<string, string> {
  const records = new Map<string, string>();
  let pos = 0;
  while (pos < data.length) {
    const space = data.indexOf(0x20, pos);
    if (space === -1) break;
    const lengthText = data.subarray(pos, space).toString('latin1');
    const length = Number(lengthText);
    if (!/^\d+$/.test(lengthText) || length <= space - pos || pos + length > data.length) {
      throw new UnsafeTarballError('malformed pax header');
    }
    const record = data.subarray(space + 1, pos + length - 1).toString('utf-8');
    const eq = record.indexOf('=');
    if (eq > 0) records.set(record.slice(0, eq), record.slice(eq + 1));
    pos += length;
  }
  return records;
}

// ── Validation (before anything is written) ────────────────

function isAbsoluteName(name: string): boolean {
  return name.startsWith('/') || name.startsWith('\\') || /^[A-Za-z]:/.test(name);
}

function normaliseEntryPath(raw: string): string {
  const shown = JSON.stringify(raw);
  if (raw.includes('\0')) throw new UnsafeTarballError(`entry name ${shown} contains a NUL byte`);
  if (isAbsoluteName(raw)) throw new UnsafeTarballError(`entry name ${shown} is an absolute path`);
  if (raw.split(/[\\/]/).includes('..')) {
    throw new UnsafeTarballError(`entry name ${shown} contains a ".." path segment`);
  }
  return raw
    .split('/')
    .filter((segment) => segment !== '' && segment !== '.')
    .join('/');
}

function checkEntries(entries: TarEntry[]): void {
  const symlinks = new Set(entries.filter((e) => e.type === 'symlink').map((e) => e.path));
  const seen = new Set<string>();
  const linkableFiles = new Set<string>();

  for (const entry of entries) {
    const segments = entry.path.split('/');
    for (let i = 1; i < segments.length; i++) {
      const ancestor = segments.slice(0, i).join('/');
      if (symlinks.has(ancestor)) {
        throw new UnsafeTarballError(
          `entry ${JSON.stringify(entry.path)} would be written through symlink ${JSON.stringify(ancestor)}`
        );
      }
    }
    if (symlinks.has(entry.path) && seen.has(entry.path)) {
      throw new UnsafeTarballError(
        `symlink ${JSON.stringify(entry.path)} collides with another entry`
      );
    }

    if (entry.type === 'symlink') checkSymlinkTarget(entry);
    if (entry.type === 'hardlink') {
      if (entry.linkTarget === entry.path || !linkableFiles.has(entry.linkTarget)) {
        throw new UnsafeTarballError(
          `hard link ${JSON.stringify(entry.path)} must point to an earlier regular file, not ${JSON.stringify(entry.linkTarget)}`
        );
      }
    }

    if (entry.type === 'file' || entry.type === 'hardlink') linkableFiles.add(entry.path);
    else linkableFiles.delete(entry.path);
    seen.add(entry.path);
  }
}

/**
 * Resolve a symlink target lexically from the link's own directory and refuse
 * it if any step climbs above the target directory. Links that pass through
 * other links are checked again on disk after extraction.
 */
function checkSymlinkTarget(entry: TarEntry): void {
  const target = entry.linkTarget;
  const shown = `symlink ${JSON.stringify(entry.path)} -> ${JSON.stringify(target)}`;
  if (target === '' || target.includes('\0')) {
    throw new UnsafeTarballError(`${shown} has an empty or invalid target`);
  }
  if (isAbsoluteName(target)) throw new UnsafeTarballError(`${shown} points to an absolute path`);

  let depth = entry.path.split('/').length - 1;
  for (const segment of target.split(/[\\/]/)) {
    if (segment === '..') depth -= 1;
    else if (segment !== '' && segment !== '.') depth += 1;
    if (depth < 0) throw new UnsafeTarballError(`${shown} points outside the package`);
  }
}

// ── Writing ────────────────────────────────────────────────

function writeEntries(entries: TarEntry[], targetDir: string): void {
  const root = realpathSync(targetDir);
  const realDirs = new Set<string>([root]);
  const symlinks: TarEntry[] = [];

  // Symlinks are created last, so no file or directory is written through one.
  for (const entry of entries) {
    if (entry.type === 'symlink') {
      symlinks.push(entry);
      continue;
    }
    const dest = prepareDestination(root, entry.path, realDirs);
    if (entry.type === 'directory') {
      // Owner rwx is always kept so later entries (and cleanup) can write here.
      ensureRealDirectory(dest, entry.mode | 0o700);
      realDirs.add(dest);
    } else if (entry.type === 'file') {
      removeExistingFile(dest);
      writeFileSync(dest, entry.data, { mode: entry.mode, flag: 'wx' });
    } else {
      removeExistingFile(dest);
      linkSync(join(root, ...entry.linkTarget.split('/')), dest);
    }
  }

  const created: string[] = [];
  try {
    for (const entry of symlinks) {
      const dest = prepareDestination(root, entry.path, realDirs);
      symlinkSync(entry.linkTarget, dest);
      created.push(dest);
    }
    for (const link of created) assertLinkInside(root, link);
  } catch (err) {
    for (const link of created) rmSync(link, { force: true });
    throw err;
  }
}

/**
 * Make sure every parent of `relativePath` is a real directory under `root`
 * (creating missing ones) and return the entry's absolute path. Parents are
 * checked with lstat, so an existing symlink is refused, never followed.
 */
function prepareDestination(root: string, relativePath: string, realDirs: Set<string>): string {
  const segments = relativePath.split('/');
  let current = root;
  for (const segment of segments.slice(0, -1)) {
    current = join(current, segment);
    if (realDirs.has(current)) continue;
    ensureRealDirectory(current, 0o777);
    realDirs.add(current);
  }
  return join(current, segments[segments.length - 1] ?? '');
}

function ensureRealDirectory(path: string, mode: number): void {
  const stats = lstatSync(path, { throwIfNoEntry: false });
  if (!stats) {
    mkdirSync(path, { mode });
    return;
  }
  if (stats.isSymbolicLink()) {
    throw new UnsafeTarballError(`refusing to write through symlink ${JSON.stringify(path)}`);
  }
  if (!stats.isDirectory()) throw new Error(`Cannot unpack into ${path}: not a directory`);
}

/** A later entry replaces an earlier one, as with tar; directories are never replaced. */
function removeExistingFile(path: string): void {
  const stats = lstatSync(path, { throwIfNoEntry: false });
  if (stats && !stats.isDirectory()) unlinkSync(path);
}

/**
 * Follow a symlink on disk one segment at a time, as the kernel would, and
 * refuse it if any step leaves `root`. Unlike the lexical check this sees
 * through other links, including case-insensitive aliases on macOS.
 */
function assertLinkInside(root: string, linkPath: string): void {
  const target = readlinkSync(linkPath);
  let current = realpathSync(dirname(linkPath));
  for (const segment of target.split('/')) {
    if (segment === '' || segment === '.') continue;
    current = realpathIfExists(segment === '..' ? dirname(current) : join(current, segment));
    if (current !== root && !current.startsWith(root + sep)) {
      throw new UnsafeTarballError(
        `symlink ${JSON.stringify(linkPath)} -> ${JSON.stringify(target)} resolves outside the package`
      );
    }
  }
}

function realpathIfExists(path: string): string {
  try {
    return realpathSync(path);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return path;
    if (code === 'ELOOP') throw new UnsafeTarballError(`symlink loop at ${JSON.stringify(path)}`);
    throw err;
  }
}
