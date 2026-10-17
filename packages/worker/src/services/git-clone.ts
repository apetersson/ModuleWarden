// ── Shell-free git clone helpers ─────────────────────────────────
// The repository URL comes from the package's own metadata, so it is
// accepted only as a plain https URL and handed to git as a single argv
// element after '--'. Nothing here goes through a shell.

import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// Quotes, backticks, backslashes and whitespace never appear in a real
// repository URL; refuse them outright rather than rely on URL parsing.
const UNSAFE_URL_CHARS = /[\s"'`\\]/;

function hasControlChars(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

/**
 * Normalize a package.json repository URL to a clonable https git URL.
 * Returns null for anything that is not a plain https URL.
 */
export function normalizeRepoUrl(url: string): string | null {
  if (!url || url.startsWith('-') || UNSAFE_URL_CHARS.test(url) || hasControlChars(url)) {
    return null;
  }

  // Handle git+https://, git://, etc.
  let cleaned = url.replace(/^git\+/, '').replace(/\.git$/, '');

  // Normalize git:// protocol to https:// (GitHub disabled git:// in 2022)
  cleaned = cleaned.replace(/^git:\/\//, 'https://');

  // Handle GitHub shorthand: "owner/repo"
  if (/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/.test(cleaned)) {
    cleaned = `https://github.com/${cleaned}`;
  }

  let parsed: URL;
  try {
    parsed = new URL(cleaned);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'https:' || !parsed.hostname) return null;
  return cleaned + '.git';
}

/** git argv for a shallow single-branch clone; '--' ends option parsing before the URL. */
export function shallowCloneArgs(repoUrl: string, dir: string, noCheckout = false): string[] {
  // --depth 500 gets at least ~40 months of history for time-series,
  // while staying shallow enough to avoid multi-GB clones on large repos.
  return [
    'clone',
    '--depth',
    '500',
    '--single-branch',
    '--no-tags',
    ...(noCheckout ? ['--no-checkout'] : []),
    '--',
    repoUrl,
    dir,
  ];
}

/**
 * Shallow-clone a repo into a new temp directory and return its path.
 * Retries once with --no-checkout; temp directories are removed on failure.
 */
export function shallowClone(repoUrl: string, timeoutMs: number): string {
  const dir = mkdtempSync(join(tmpdir(), 'mw-git-'));
  try {
    execFileSync('git', shallowCloneArgs(repoUrl, dir), {
      encoding: 'utf-8',
      stdio: 'pipe',
      timeout: timeoutMs,
      maxBuffer: 10 * 1024 * 1024,
    });
  } catch (err) {
    // Try fallback: clone with --no-checkout for speed
    rmSync(dir, { recursive: true, force: true });
    const fallbackDir = mkdtempSync(join(tmpdir(), 'mw-git-'));
    try {
      execFileSync('git', shallowCloneArgs(repoUrl, fallbackDir, true), {
        encoding: 'utf-8',
        stdio: 'pipe',
        timeout: timeoutMs,
      });
      return fallbackDir;
    } catch {
      rmSync(fallbackDir, { recursive: true, force: true });
      throw err;
    }
  }
  return dir;
}
