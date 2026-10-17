/**
 * Evidence copy tests for the container runner.
 *
 * Output file names are written by the audit container, which runs package
 * code. These tests use names with shell syntax and planted symlinks, and
 * check that no command runs and no link is followed. Docker is not needed.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { copyRegularFiles } from '../services/artifact-copy.js';

describe('copyRegularFiles (container output to evidence)', () => {
  let work: string;
  let output: string;
  let evidence: string;
  let outside: string;
  let canary: string;

  beforeEach(() => {
    work = mkdtempSync(join(tmpdir(), 'mw-artifact-test-'));
    output = join(work, 'output');
    evidence = join(work, 'evidence');
    outside = join(work, 'outside');
    for (const dir of [output, evidence, outside]) mkdirSync(dir);
    writeFileSync(join(outside, 'secret.txt'), 'host secret');
    canary = join(work, 'pwned');
    process.env.MW_TEST_CANARY = canary;
  });

  afterEach(() => {
    delete process.env.MW_TEST_CANARY;
    rmSync(work, { recursive: true, force: true });
  });

  it('copies regular files to the same relative paths', () => {
    writeFileSync(join(output, 'verdict.json'), '{"verdict":"quarantine"}');
    mkdirSync(join(output, 'inspection'));
    writeFileSync(join(output, 'inspection', 'env.txt'), 'A=1');

    const copied = copyRegularFiles(output, evidence);

    expect(copied.sort()).toEqual([
      join(evidence, 'inspection', 'env.txt'),
      join(evidence, 'verdict.json'),
    ]);
    expect(readFileSync(join(evidence, 'inspection', 'env.txt'), 'utf-8')).toBe('A=1');
    expect(readFileSync(join(evidence, 'verdict.json'), 'utf-8')).toBe('{"verdict":"quarantine"}');
  });

  // Before this fix each name went into `cp "<file>" "<dest>"` run by a
  // shell, so these ran `touch` on the worker host.
  it.each([
    ['$(...)', '$(touch $MW_TEST_CANARY)'],
    ['backticks', '`touch $MW_TEST_CANARY`'],
    ['quote and ;', 'x"; touch $MW_TEST_CANARY; echo "'],
  ])('treats %s in an output file name as data, not a command', (_label, name) => {
    writeFileSync(join(output, name), 'payload');

    const copied = copyRegularFiles(output, evidence);

    expect(existsSync(canary)).toBe(false);
    expect(copied).toEqual([join(evidence, name)]);
    expect(readFileSync(join(evidence, name), 'utf-8')).toBe('payload');
  });

  it('does not follow symlinks in the output directory', () => {
    symlinkSync(join(outside, 'secret.txt'), join(output, 'leak.txt'));
    symlinkSync(outside, join(output, 'leakdir'));
    const skipped: string[] = [];

    const copied = copyRegularFiles(output, evidence, (path) => skipped.push(path));

    expect(copied).toEqual([]);
    expect(readdirSync(evidence)).toEqual([]);
    expect(skipped.sort()).toEqual([join(output, 'leak.txt'), join(output, 'leakdir')]);
  });

  it('does not write through symlinks planted in the evidence directory', () => {
    // The evidence directory is inside the container's /workspace mount too.
    symlinkSync(outside, join(evidence, 'inspection'));
    symlinkSync(join(outside, 'secret.txt'), join(evidence, 'verdict.json'));
    mkdirSync(join(output, 'inspection'));
    writeFileSync(join(output, 'inspection', 'env.txt'), 'A=1');
    writeFileSync(join(output, 'verdict.json'), 'overwritten');
    const skipped: string[] = [];

    const copied = copyRegularFiles(output, evidence, (path) => skipped.push(path));

    expect(copied).toEqual([]);
    expect(existsSync(join(outside, 'env.txt'))).toBe(false);
    expect(readFileSync(join(outside, 'secret.txt'), 'utf-8')).toBe('host secret');
    expect(skipped.sort()).toEqual([
      join(output, 'inspection', 'env.txt'),
      join(output, 'verdict.json'),
    ]);
  });

  it('copies nothing when the output directory itself is a symlink', () => {
    rmSync(output, { recursive: true });
    symlinkSync(outside, output);

    expect(copyRegularFiles(output, evidence)).toEqual([]);
    expect(readdirSync(evidence)).toEqual([]);
  });
});
