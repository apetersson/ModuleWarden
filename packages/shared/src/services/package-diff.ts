import { execSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

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
 */
export function unpackTarball(tarballPath: string, targetDir: string): FileEntry[] {
  if (!existsSync(tarballPath)) {
    throw new Error(`Tarball not found: ${tarballPath}`);
  }

  const entries: FileEntry[] = [];

  // Extract tarball
  execSync(`tar -xzf "${tarballPath}" -C "${targetDir}" 2>/dev/null`, { stdio: 'pipe' });

  // List all files
  const output = execSync(
    `find "${targetDir}" -type f -o -type l -o -type d | sort`,
    { encoding: 'utf-8', stdio: 'pipe' }
  );

  for (const line of output.trim().split('\n').filter(Boolean)) {
    const fullPath = line.trim();
    const stat = execSync(`stat -f "%Sp|%z" "${fullPath}" 2>/dev/null || stat -c "%A|%s" "${fullPath}" 2>/dev/null`, { encoding: 'utf-8' }).trim();
    const [mode, sizeStr] = stat.split('|');
    const relativePath = fullPath.replace(targetDir, '').replace(/^\//, '');
    const size = parseInt(sizeStr ?? '0', 10);
    const isDir = execSync(`test -d "${fullPath}" && echo yes || echo no`, { encoding: 'utf-8' }).trim() === 'yes';

    entries.push({
      path: relativePath || '/',
      size,
      mode: mode ?? 'unknown',
      isDir,
      isExecutable: (mode?.includes('x') ?? false),
    });
  }

  return entries;
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
