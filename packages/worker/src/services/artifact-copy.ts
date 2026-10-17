// ── Shell-free copy of audit container output ────────────────────
// File names under the output directory are chosen by the audit container,
// which runs package code, and the evidence directory sits inside the same
// /workspace mount. So this never uses a shell, never follows a symlink on
// either side, and refuses any destination that resolves outside the
// evidence directory.

import {
  constants,
  copyFileSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  realpathSync,
  unlinkSync,
} from 'node:fs';
import { join, sep } from 'node:path';

export type SkipHandler = (path: string, reason: string) => void;

function isInside(root: string, path: string): boolean {
  return path === root || path.startsWith(root + sep);
}

/**
 * Copy every regular file under `sourceDir` to the same relative path under
 * `destDir` and return the destination paths. Symlinks are reported to
 * `onSkip` and not followed; FIFOs, sockets and devices are ignored, as
 * `find -type f` did. Files that cannot be copied safely are reported to
 * `onSkip` and left out.
 */
export function copyRegularFiles(
  sourceDir: string,
  destDir: string,
  onSkip: SkipHandler = () => {}
): string[] {
  // Both directories sit inside the container's mount, so either could have
  // been swapped for a symlink.
  for (const root of [sourceDir, destDir]) {
    if (!lstatSync(root).isDirectory()) {
      onSkip(root, 'not a real directory (symlink not followed)');
      return [];
    }
  }

  const sourceRoot = realpathSync(sourceDir);
  const destRoot = realpathSync(destDir);
  const copied: string[] = [];

  const visit = (relativeDir: string[]): void => {
    const dir = join(sourceDir, ...relativeDir);
    for (const name of readdirSync(dir).sort()) {
      const source = join(dir, name);
      const stats = lstatSync(source, { throwIfNoEntry: false });
      if (!stats) continue; // disappeared since readdir
      if (stats.isDirectory()) {
        visit([...relativeDir, name]);
      } else if (stats.isSymbolicLink()) {
        onSkip(source, 'symlink not followed');
      } else if (stats.isFile()) {
        try {
          copied.push(copyFileInside(source, sourceRoot, destDir, destRoot, relativeDir, name));
        } catch (err) {
          onSkip(source, err instanceof Error ? err.message : String(err));
        }
      }
    }
  };

  visit([]);
  return copied;
}

function copyFileInside(
  source: string,
  sourceRoot: string,
  destDir: string,
  destRoot: string,
  relativeDir: string[],
  name: string
): string {
  if (!isInside(sourceRoot, realpathSync(source))) {
    throw new Error(`source ${source} resolves outside ${sourceRoot}`);
  }

  // Create parent directories one level at a time; an existing symlink or
  // file in the way is refused, never followed.
  let parent = destDir;
  for (const segment of relativeDir) {
    parent = join(parent, segment);
    const stats = lstatSync(parent, { throwIfNoEntry: false });
    if (!stats) mkdirSync(parent);
    else if (!stats.isDirectory()) throw new Error(`destination ${parent} is not a directory`);
  }
  if (!isInside(destRoot, realpathSync(parent))) {
    throw new Error(`destination ${parent} resolves outside ${destDir}`);
  }

  const dest = join(parent, name);
  const existing = lstatSync(dest, { throwIfNoEntry: false });
  if (existing) {
    if (!existing.isFile()) throw new Error(`destination ${dest} is not a regular file`);
    unlinkSync(dest);
  }
  // COPYFILE_EXCL fails instead of writing through anything created at dest meanwhile.
  copyFileSync(source, dest, constants.COPYFILE_EXCL);
  return dest;
}
