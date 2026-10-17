import { existsSync, lstatSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import type { Stats } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { extractTarballSafely } from './safe-tar.js';

export { UnsafeTarballError } from './safe-tar.js';

export interface FileEntry {
  path: string;
  size: number;
  mode: string;
  isDir: boolean;
  isExecutable: boolean;
}

export interface FileDiff {
  added: FileEntry[];
  removed: FileEntry[];
  changed: Array<{ path: string; oldSize: number; newSize: number; oldMode?: string; newMode?: string }>;
}

export interface DependencyDiff {
  added: Record<string, string>;
  removed: Record<string, string>;
  changed: Record<string, { old: string; new: string }>;
}

export interface LifecycleScript {
  name: string;
  command: string;
  new: boolean; // true if added in new version
}

export interface LifecycleScriptDiff {
  scripts: LifecycleScript[];
}

/**
 * Unpack a tarball to a temp directory and return file listing.
 *
 * Entry names come from the package, so nothing here goes through a shell:
 * extraction is done in-process (see safe-tar.ts) and the listing uses lstat,
 * which never follows links. Tarballs with entries that would land outside
 * `targetDir` are refused with UnsafeTarballError.
 */
export function unpackTarball(tarballPath: string, targetDir: string): FileEntry[] {
  if (!existsSync(tarballPath)) {
    throw new Error(`Tarball not found: ${tarballPath}`);
  }

  // Extract tarball
  extractTarballSafely(tarballPath, targetDir);

  // List all files, directories and symlinks (the target directory itself is '/')
  const entries: FileEntry[] = [];
  const visit = (fullPath: string, relativePath: string): void => {
    const stats = lstatSync(fullPath);
    const mode = formatMode(stats);
    entries.push({
      path: relativePath || '/',
      size: stats.size,
      mode,
      isDir: stats.isDirectory(),
      isExecutable: mode.includes('x'),
    });
    if (stats.isDirectory()) {
      for (const name of readdirSync(fullPath)) {
        visit(join(fullPath, name), relativePath ? `${relativePath}/${name}` : name);
      }
    }
  };
  visit(targetDir, '');

  // Target directory first, then by path
  const sortKey = (entry: FileEntry): string => (entry.path === '/' ? '' : entry.path);
  return entries.sort((a, b) => {
    const [x, y] = [sortKey(a), sortKey(b)];
    return x < y ? -1 : x > y ? 1 : 0;
  });
}

/** Symbolic mode string as printed by `ls -l` (e.g. "-rwxr-xr-x"). */
function formatMode(stats: Stats): string {
  let type = '?';
  if (stats.isDirectory()) type = 'd';
  else if (stats.isSymbolicLink()) type = 'l';
  else if (stats.isFile()) type = '-';
  const triplet = (shift: number, specialBit: number, specialChar: string): string => {
    const read = stats.mode & (0o4 << shift) ? 'r' : '-';
    const write = stats.mode & (0o2 << shift) ? 'w' : '-';
    const exec = (stats.mode & (0o1 << shift)) !== 0;
    let execChar = exec ? 'x' : '-';
    if (stats.mode & specialBit) execChar = exec ? specialChar : specialChar.toUpperCase();
    return read + write + execChar;
  };
  return type + triplet(6, 0o4000, 's') + triplet(3, 0o2000, 's') + triplet(0, 0o1000, 't');
}

/**
 * Diff two tarballs (old and new version).
 */
export function diffTarballs(
  oldTarballPath: string | null,
  newTarballPath: string
): FileDiff {
  const oldDir = oldTarballPath ? mkdtempSync(join(tmpdir(), 'mw-diff-old-')) : null;
  const newDir = mkdtempSync(join(tmpdir(), 'mw-diff-new-'));

  try {
    const newFiles = unpackTarball(newTarballPath, newDir);
    let oldFiles: FileEntry[] = [];

    if (oldDir && oldTarballPath) {
      oldFiles = unpackTarball(oldTarballPath, oldDir);
    }

    const oldPaths = new Set(oldFiles.map((f) => f.path));
    const newPaths = new Set(newFiles.map((f) => f.path));

    const added = newFiles.filter((f) => !oldPaths.has(f.path) && !f.isDir);
    const removed = oldFiles.filter((f) => !newPaths.has(f.path) && !f.isDir);
    const changed: FileDiff['changed'] = [];

    for (const newFile of newFiles) {
      if (newFile.isDir) continue;
      const oldFile = oldFiles.find((f) => f.path === newFile.path);
      if (oldFile && (oldFile.size !== newFile.size || oldFile.isExecutable !== newFile.isExecutable)) {
        changed.push({
          path: newFile.path,
          oldSize: oldFile.size,
          newSize: newFile.size,
          oldMode: oldFile.mode,
          newMode: newFile.mode,
        });
      }
    }

    return { added, removed, changed };
  } finally {
    if (oldDir) rmSync(oldDir, { recursive: true, force: true });
    rmSync(newDir, { recursive: true, force: true });
  }
}

/**
 * Extract dependency declarations from a package.json file.
 */
export function extractDependencies(packageJsonPath: string): Record<string, string> {
  if (!existsSync(packageJsonPath)) return {};
  try {
    const pkg = JSON.parse(readFileSync(packageJsonPath, 'utf-8'));
    return {
      ...(pkg.dependencies ?? {}),
      ...(pkg.devDependencies ?? {}),
      ...(pkg.peerDependencies ?? {}),
      ...(pkg.optionalDependencies ?? {}),
    };
  } catch {
    return {};
  }
}

/**
 * Diff dependencies between two versions.
 */
export function diffDependencies(
  oldPackageJsonPath: string | null,
  newPackageJsonPath: string
): DependencyDiff {
  const oldDeps = oldPackageJsonPath ? extractDependencies(oldPackageJsonPath) : {};
  const newDeps = extractDependencies(newPackageJsonPath);

  const added: Record<string, string> = {};
  const removed: Record<string, string> = {};
  const changed: Record<string, { old: string; new: string }> = {};

  for (const [name, version] of Object.entries(newDeps)) {
    const oldVersion = oldDeps[name];
    if (oldVersion === undefined) {
      added[name] = version;
    } else if (oldVersion !== version) {
      changed[name] = { old: oldVersion, new: version };
    }
  }

  for (const [name, version] of Object.entries(oldDeps)) {
    if (!(name in newDeps)) {
      removed[name] = version;
    }
  }

  return { added, removed, changed };
}

/**
 * Extract lifecycle scripts from a package.json.
 */
export function extractLifecycleScripts(packageJsonPath: string): LifecycleScript[] {
  if (!existsSync(packageJsonPath)) return [];
  try {
    const pkg = JSON.parse(readFileSync(packageJsonPath, 'utf-8'));
    const scripts = pkg.scripts ?? {};
    const lifecycleNames = ['preinstall', 'install', 'postinstall', 'prepublish', 'prepare', 'prepack', 'postpack'];
    return lifecycleNames
      .filter((name) => scripts[name])
      .map((name) => ({
        name,
        command: scripts[name],
        new: false, // Will be determined when diffing
      }));
  } catch {
    return [];
  }
}

/**
 * Diff lifecycle scripts between two versions.
 */
export function diffLifecycleScripts(
  oldPackageJsonPath: string | null,
  newPackageJsonPath: string
): LifecycleScriptDiff {
  const oldScripts = oldPackageJsonPath ? extractLifecycleScripts(oldPackageJsonPath) : [];
  const newScripts = extractLifecycleScripts(newPackageJsonPath);
  const oldNames = new Set(oldScripts.map((s) => s.name));

  return {
    scripts: newScripts.map((s) => ({
      ...s,
      new: !oldNames.has(s.name),
    })),
  };
}
