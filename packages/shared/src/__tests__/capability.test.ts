import { describe, it, expect } from 'vitest';
import { writeFileSync, mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execSync } from 'node:child_process';
import { extractCapabilities } from '../services/capability-extract.js';
import { extractLifecycleScripts, extractDependencies, diffDependencies, diffLifecycleScripts } from '../services/package-diff.js';
import { buildEvidenceBundle } from '../services/evidence-bundle.js';
import type { FileDiff, DependencyDiff, LifecycleScriptDiff } from '../services/package-diff.js';

function withTempDir(fn: (dir: string) => void) {
  const dir = mkdtempSync(join(tmpdir(), 'mw-cap-test-'));
  try {
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function writePkgJson(dir: string, name: string, version: string, scripts?: Record<string, string>, deps?: Record<string, string>) {
  writeFileSync(join(dir, 'package.json'), JSON.stringify({
    name,
    version,
    scripts: scripts ?? {},
    dependencies: deps ?? {},
  }, null, 2));
}

describe('capability extraction', () => {
  it('detects network access in source files', () => {
    withTempDir((dir) => {
      writeFileSync(join(dir, 'index.js'), `
        const http = require('http');
        const server = http.createServer();
        fetch('https://example.com');
      `);

      const report = extractCapabilities(dir);
      expect(report.summary.network).toBe('medium');
      expect(report.findings.some((f) => f.description.includes('HTTP'))).toBe(true);
    });
  });

  it('detects child_process usage', () => {
    withTempDir((dir) => {
      writeFileSync(join(dir, 'exec.js'), `
        const { exec } = require('child_process');
        exec('rm -rf /');
      `);

      const report = extractCapabilities(dir);
      expect(report.summary.process).toBe('high');
      expect(report.findings.some((f) => f.description.includes('exec()'))).toBe(true);
    });
  });

  it('detects eval and dynamic code', () => {
    withTempDir((dir) => {
      writeFileSync(join(dir, 'danger.js'), `
        const code = 'console.log("hello")';
        eval(code);
        const fn = new Function('return 1 + 1');
      `);

      const report = extractCapabilities(dir);
      expect(report.summary['dynamic-code']).toBe('high');
    });
  });

  it('detects filesystem access', () => {
    withTempDir((dir) => {
      writeFileSync(join(dir, 'fs.js'), `
        const fs = require('fs');
        fs.writeFileSync('/tmp/test', 'data');
      `);

      const report = extractCapabilities(dir);
      expect(report.summary.filesystem).toBe('high');
    });
  });

  it('returns no findings for clean code', () => {
    withTempDir((dir) => {
      writeFileSync(join(dir, 'math.js'), `
        function add(a, b) { return a + b; }
        function multiply(a, b) { return a * b; }
        module.exports = { add, multiply };
      `);

      const report = extractCapabilities(dir);
      const categoriesWithFindings = Object.entries(report.summary)
        .filter(([, v]) => v !== 'none');
      expect(categoriesWithFindings).toHaveLength(0);
    });
  });
});

describe('package diff utilities', () => {
  it('extracts dependencies from package.json', () => {
    withTempDir((dir) => {
      writePkgJson(dir, 'test-pkg', '1.0.0', {}, { lodash: '^4.17.21', express: '^4.18.0' });
      const deps = extractDependencies(join(dir, 'package.json'));
      expect(deps.lodash).toBe('^4.17.21');
      expect(deps.express).toBe('^4.18.0');
    });
  });

  it('diffs dependencies between two versions', () => {
    withTempDir((dir) => {
      const oldDir = join(dir, 'old');
      const newDir = join(dir, 'new');
      mkdirSync(oldDir, { recursive: true });
      mkdirSync(newDir, { recursive: true });

      writePkgJson(oldDir, 'test', '1.0.0', {}, { lodash: '^4.17.21' });
      writePkgJson(newDir, 'test', '2.0.0', {}, { lodash: '^4.18.0', axios: '^1.0.0' });

      const diff = diffDependencies(join(oldDir, 'package.json'), join(newDir, 'package.json'));

      expect(diff.removed).toEqual({});
      expect(diff.added.axios).toBe('^1.0.0');
      expect(diff.changed.lodash).toBeDefined();
      expect(diff.changed.lodash.old).toBe('^4.17.21');
      expect(diff.changed.lodash.new).toBe('^4.18.0');
    });
  });

  it('detects lifecycle scripts', () => {
    withTempDir((dir) => {
      writePkgJson(dir, 'test', '1.0.0', {
        postinstall: 'node setup.js',
        prepublish: 'npm run build',
      });

      const scripts = extractLifecycleScripts(join(dir, 'package.json'));
      expect(scripts).toHaveLength(2);
      expect(scripts.find((s) => s.name === 'postinstall')).toBeDefined();
      expect(scripts.find((s) => s.name === 'prepublish')).toBeDefined();
    });
  });

  it('diffs lifecycle scripts between versions', () => {
    withTempDir((dir) => {
      const oldDir = join(dir, 'old');
      const newDir = join(dir, 'new');
      mkdirSync(oldDir, { recursive: true });
      mkdirSync(newDir, { recursive: true });

      writePkgJson(oldDir, 'test', '1.0.0', { postinstall: 'node setup.js' });
      writePkgJson(newDir, 'test', '2.0.0', {
        postinstall: 'node setup.js', // same
        prepare: 'npm run build',     // new
      });

      const diff = diffLifecycleScripts(join(oldDir, 'package.json'), join(newDir, 'package.json'));

      expect(diff.scripts).toHaveLength(2);
      expect(diff.scripts.find((s) => s.name === 'postinstall')?.new).toBe(false);
      expect(diff.scripts.find((s) => s.name === 'prepare')?.new).toBe(true);
    });
  });
});

describe('evidence bundle assembly', () => {
  it('builds cold-start bundle when no predecessor', () => {
    const fileDiff: FileDiff = { added: [{ path: 'index.js', size: 100, mode: '644', isDir: false, isExecutable: false }], removed: [], changed: [] };
    const depDiff: DependencyDiff = { added: {}, removed: {}, changed: {} };
    const lcDiff: LifecycleScriptDiff = { scripts: [] };
    const capReport = { findings: [], summary: { network: 'none', filesystem: 'none', process: 'none', 'dynamic-code': 'none', 'env-credential': 'none', 'native-wasm': 'none', obfuscation: 'none', 'dependency-indirection': 'none', 'install-time': 'none' } };

    const bundle = buildEvidenceBundle({
      packageName: 'test-pkg',
      version: '1.0.0',
      predecessorVersion: null,
      tarballHash: 'sha512-test',
      fileDiff,
      dependencyDiff: depDiff,
      lifecycleScriptDiff: lcDiff,
      capabilityReport: capReport,
      intentEvidence: { mismatchIndicators: [] },
    });

    expect(bundle.isColdStart).toBe(true);
    expect(bundle.packageInfo.predecessorVersion).toBeNull();
    expect(bundle.rankings.some((r) => r.category === 'cold-start')).toBe(true);
  });

  it('builds version-diff bundle with predecessor', () => {
    const fileDiff: FileDiff = {
      added: [{ path: 'src/new-file.js', size: 500, mode: '644', isDir: false, isExecutable: false }],
      removed: [],
      changed: [{ path: 'src/old-file.js', oldSize: 200, newSize: 300 }],
    };
    const depDiff: DependencyDiff = { added: { axios: '^1.0.0' }, removed: { 'old-dep': '^0.1.0' }, changed: {} };
    const lcDiff: LifecycleScriptDiff = { scripts: [{ name: 'postinstall', command: 'node setup.js', new: true }] };
    const capReport = {
      findings: [{ category: 'network' as const, severity: 'medium' as const, description: 'HTTP require', files: ['index.js'], evidence: ['require("http")'] }],
      summary: { network: 'medium', filesystem: 'none', process: 'none', 'dynamic-code': 'none', 'env-credential': 'none', 'native-wasm': 'none', obfuscation: 'none', 'dependency-indirection': 'none', 'install-time': 'none' },
    };

    const bundle = buildEvidenceBundle({
      packageName: 'test-pkg',
      version: '2.0.0',
      predecessorVersion: '1.0.0',
      tarballHash: 'sha512-test-v2',
      fileDiff,
      dependencyDiff: depDiff,
      lifecycleScriptDiff: lcDiff,
      capabilityReport: capReport,
      intentEvidence: { mismatchIndicators: [] },
    });

    expect(bundle.isColdStart).toBe(false);
    expect(bundle.packageInfo.predecessorVersion).toBe('1.0.0');
    expect(bundle.rankings.length).toBeGreaterThan(0);
    // Should have file-added, dependency-added, lifecycle-script, and capability rankings
    const categories = bundle.rankings.map((r) => r.category);
    expect(categories).toContain('capability:network');
    expect(categories).toContain('file:added');
    expect(categories).toContain('dependency:added');
    expect(categories).toContain('lifecycle-script');
  });
});
