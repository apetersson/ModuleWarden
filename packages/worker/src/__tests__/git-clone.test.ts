/**
 * Repository clone tests for the git metric extractor.
 *
 * The repository URL comes from package metadata, so these tests prove a
 * crafted URL cannot run a command and that a normal URL still clones.
 * Git is limited to the local file transport, so nothing touches the network.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { normalizeRepoUrl, shallowClone, shallowCloneArgs } from '../services/git-clone.js';

// Before this fix the URL went into `git clone ... "<url>" "<dir>"` run by a
// shell, so this repository.url ran `touch` on the worker.
const PAYLOAD = 'https://github.com/a/b"; touch $MW_TEST_CANARY; echo "';

const TEST_ENV = {
  MW_TEST_CANARY: '',
  // An https clone fails before any network access; file:// still works.
  GIT_ALLOW_PROTOCOL: 'file',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: '/dev/null',
};

describe('git clone of a package repository URL', () => {
  let work: string;
  let canary: string;
  const savedEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    work = mkdtempSync(join(tmpdir(), 'mw-git-test-'));
    canary = join(work, 'pwned');
    for (const [key, value] of Object.entries({ ...TEST_ENV, MW_TEST_CANARY: canary })) {
      savedEnv[key] = process.env[key];
      process.env[key] = value;
    }
  });

  afterEach(() => {
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(work, { recursive: true, force: true });
  });

  it('refuses a repository URL that carries shell syntax', () => {
    expect(normalizeRepoUrl(PAYLOAD)).toBeNull();
    expect(normalizeRepoUrl(`git+${PAYLOAD}.git`)).toBeNull();
  });

  it.each([
    'http://github.com/a/b',
    'git+ssh://git@github.com/a/b.git',
    'file:///etc/passwd',
    'ext::sh -c touch% /tmp/pwned',
    '-uhttps://github.com/a/b',
    'https://github.com/a/b`id`',
    "https://github.com/a/b'",
    'https://github.com/a/b\tc',
  ])('refuses %s', (url) => {
    expect(normalizeRepoUrl(url)).toBeNull();
  });

  it.each([
    ['git+https://github.com/a/b.git', 'https://github.com/a/b.git'],
    ['git://github.com/a/b.git', 'https://github.com/a/b.git'],
    ['https://github.com/a/b', 'https://github.com/a/b.git'],
    ['a/b', 'https://github.com/a/b.git'],
    ['https://gitlab.com/group/project', 'https://gitlab.com/group/project.git'],
  ])('normalizes %s to %s', (url, expected) => {
    expect(normalizeRepoUrl(url)).toBe(expected);
  });

  it('passes a normal URL to git as the same argv, after --', () => {
    expect(shallowCloneArgs('https://github.com/a/b.git', '/tmp/mw-git-x')).toEqual([
      'clone',
      '--depth',
      '500',
      '--single-branch',
      '--no-tags',
      '--',
      'https://github.com/a/b.git',
      '/tmp/mw-git-x',
    ]);
    expect(shallowCloneArgs('https://github.com/a/b.git', '/tmp/mw-git-x', true)).toEqual([
      'clone',
      '--depth',
      '500',
      '--single-branch',
      '--no-tags',
      '--no-checkout',
      '--',
      'https://github.com/a/b.git',
      '/tmp/mw-git-x',
    ]);
  });

  it('does not run a command embedded in the URL even if it reaches git', () => {
    let error: unknown;
    try {
      rmSync(shallowClone(PAYLOAD, 30_000), { recursive: true, force: true });
    } catch (err) {
      error = err;
    }

    expect(existsSync(canary)).toBe(false);
    expect(error).toBeInstanceOf(Error);
  });

  it('still clones a normal repository', () => {
    const bare = join(work, 'origin.git');
    const seed = join(work, 'seed');
    const git = (...args: string[]) =>
      execFileSync('git', args, { encoding: 'utf-8', stdio: 'pipe' });
    git('init', '-q', '--bare', '--initial-branch=main', bare);
    git('init', '-q', '--initial-branch=main', seed);
    git(
      '-C',
      seed,
      '-c',
      'user.name=test',
      '-c',
      'user.email=test@example.com',
      'commit',
      '-q',
      '--allow-empty',
      '-m',
      'initial'
    );
    git('-C', seed, 'push', '-q', bare, 'main');

    const dir = shallowClone(`file://${bare}`, 30_000);
    try {
      expect(git('-C', dir, 'log', '--format=%s').trim()).toBe('initial');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
