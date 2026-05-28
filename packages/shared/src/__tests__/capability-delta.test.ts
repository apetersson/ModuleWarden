import { describe, it, expect } from 'vitest';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import type { CapabilityReport, CapabilityCategory } from '../services/capability-extract.js';
import { extractCapabilities } from '../services/capability-extract.js';
import type { DependencyDiff, LifecycleScriptDiff } from '../services/package-diff.js';
import {
  computeCapabilityDelta,
  analyzeDependencyIndirection,
} from '../services/capability-delta.js';

// ── Fixture path helper ─────────────────────────────────

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const FIXTURES_DIR = join(__dirname, 'fixtures');

function fixturePath(...segments: string[]): string {
  return join(FIXTURES_DIR, ...segments);
}

describe('capability-delta', () => {
  // ── Helpers ──────────────────────────────────────────────

  function makeReport(overrides?: Partial<CapabilityReport>): CapabilityReport {
    const allCategories: CapabilityCategory[] = [
      'network', 'filesystem', 'process', 'dynamic-code',
      'env-credential', 'native-wasm', 'obfuscation',
      'dependency-indirection', 'install-time',
    ];
    const summary = {} as Record<CapabilityCategory, 'none' | 'low' | 'medium' | 'high'>;
    for (const c of allCategories) summary[c] = 'none';
    return {
      findings: [],
      summary,
      ...overrides,
    };
  }

  // ── computeCapabilityDelta ──────────────────────────────

  describe('computeCapabilityDelta', () => {
    it('returns no deltas when both reports are clean', () => {
      const oldReport = makeReport();
      const newReport = makeReport();
      const result = computeCapabilityDelta(oldReport, newReport);
      expect(result.deltas).toHaveLength(0);
      expect(result.isColdStart).toBe(false);
      expect(result.overallRisk).toBe('none');
    });

    it('detects new capability with no predecessor (cold-start)', () => {
      const newReport = makeReport();
      newReport.summary.network = 'high';
      newReport.findings.push({
        category: 'network',
        severity: 'high',
        description: 'Network access detected',
        files: ['index.js'],
        evidence: ['require("http")'],
      });

      const result = computeCapabilityDelta(null, newReport);
      expect(result.isColdStart).toBe(true);
      expect(result.overallRisk).toBe('high');
      expect(result.deltas.length).toBeGreaterThanOrEqual(1);
      expect(result.deltas[0].changeType).toBe('added');
      expect(result.deltas[0].category).toBe('network');
    });

    it('detects newly introduced capability between versions', () => {
      const oldReport = makeReport();
      const newReport = makeReport();
      newReport.summary.network = 'medium';
      newReport.findings.push({
        category: 'network',
        severity: 'medium',
        description: 'HTTP module required',
        files: ['src/client.js'],
        evidence: ['require("http")'],
      });

      const result = computeCapabilityDelta(oldReport, newReport);
      expect(result.isColdStart).toBe(false);
      expect(result.deltas).toHaveLength(1);
      expect(result.deltas[0].changeType).toBe('added');
      expect(result.deltas[0].category).toBe('network');
      expect(result.deltas[0].isNew).toBe(true);
      expect(result.overallRisk).toBe('medium');
    });

    it('detects capability intensification', () => {
      const oldReport = makeReport();
      oldReport.summary.network = 'low';
      oldReport.findings.push({
        category: 'network',
        severity: 'low',
        description: 'axios usage',
        files: ['index.js'],
        evidence: ['axios.'],
      });

      const newReport = makeReport();
      newReport.summary.network = 'high';
      newReport.findings.push({
        category: 'network',
        severity: 'high',
        description: 'TCP/net module required',
        files: ['index.js'],
        evidence: ['require("net")'],
      });

      const result = computeCapabilityDelta(oldReport, newReport);
      expect(result.deltas).toHaveLength(1);
      expect(result.deltas[0].changeType).toBe('intensified');
      expect(result.deltas[0].category).toBe('network');
      expect(result.deltas[0].isNew).toBe(false);
      expect(result.overallRisk).toBe('high');
    });

    it('flags new lifecycle scripts', () => {
      const oldReport = makeReport();
      const newReport = makeReport();

      const lcDiff: LifecycleScriptDiff = {
        scripts: [
          { name: 'postinstall', command: 'node install.js', new: true },
        ],
      };

      const result = computeCapabilityDelta(oldReport, newReport, undefined, lcDiff);
      const installTimeDeltas = result.deltas.filter((d) => d.category === 'install-time');
      expect(installTimeDeltas).toHaveLength(1);
      expect(installTimeDeltas[0].changeType).toBe('added');
      expect(result.overallRisk).toBe('high'); // lifecycle scripts are high-severity
    });

    it('flags suspicious new dependencies', () => {
      const oldReport = makeReport();
      const newReport = makeReport();

      const depDiff: DependencyDiff = {
        added: { 'postinstall-helper': '1.0.0' },
        removed: {},
        changed: {},
      };

      const result = computeCapabilityDelta(oldReport, newReport, depDiff);
      const indirectionDeltas = result.deltas.filter((d) => d.category === 'dependency-indirection');
      expect(indirectionDeltas.length).toBeGreaterThanOrEqual(1);
      expect(indirectionDeltas[0].changeType).toBe('added');
    });

    it('removed capability is detected but not amplified', () => {
      const oldReport = makeReport();
      oldReport.summary.process = 'high';
      oldReport.findings.push({
        category: 'process',
        severity: 'high',
        description: 'child_process usage',
        files: ['old.js'],
        evidence: ['require("child_process")'],
      });

      const newReport = makeReport();

      const result = computeCapabilityDelta(oldReport, newReport);
      const removedDeltas = result.deltas.filter((d) => d.changeType === 'removed');
      expect(removedDeltas).toHaveLength(1);
      expect(removedDeltas[0].category).toBe('process');
      // Removed capabilities don't amplify risk
      expect(result.overallRisk).toBe('none');
    });

    it('cold-start with multiple capabilities produces high risk', () => {
      const newReport = makeReport();
      newReport.summary.network = 'high';
      newReport.summary.process = 'high';
      newReport.summary.filesystem = 'medium';
      newReport.findings.push(
        { category: 'network', severity: 'high', description: 'HTTP', files: ['a.js'], evidence: ['http'] },
        { category: 'process', severity: 'high', description: 'exec', files: ['b.js'], evidence: ['exec'] },
        { category: 'filesystem', severity: 'medium', description: 'fs', files: ['c.js'], evidence: ['fs'] },
      );

      const result = computeCapabilityDelta(null, newReport);
      expect(result.isColdStart).toBe(true);
      expect(result.overallRisk).toBe('high');
      expect(result.deltas.length).toBeGreaterThanOrEqual(3);
      // All should be marked as new (since no predecessor)
      expect(result.deltas.every((d) => d.isNew)).toBe(true);
    });
  });

  // ── analyzeDependencyIndirection ─────────────────────────

  describe('analyzeDependencyIndirection', () => {
    it('flags dependencies with suspicious names', () => {
      const findings = analyzeDependencyIndirection({
        'postinstall-hook': '1.0.0',
        'native-binary-loader': '2.0.0',
        lodash: '^4.17.21',
        axios: '^1.0.0',
      });

      const flagged = findings.map((f) => f.name);
      expect(flagged).toContain('postinstall-hook');
      expect(flagged).toContain('native-binary-loader');
      expect(flagged).not.toContain('lodash');
      expect(flagged).not.toContain('axios');
    });

    it('returns empty for clean dependencies', () => {
      const findings = analyzeDependencyIndirection({
        lodash: '^4.17.21',
        express: '^4.18.0',
      });
      expect(findings).toHaveLength(0);
    });
  });

  // ── Fixture-based integration tests ─────────────────────

  describe('fixture-based capability extraction and delta', () => {
    it('benign-v1: cold-start extracts no dangerous capabilities', () => {
      const report = extractCapabilities(fixturePath('benign-v1'));
      // benign-util only does string manipulation — no dangerous capabilities
      const dangerousCategories: CapabilityCategory[] = [
        'network', 'filesystem', 'process', 'dynamic-code',
        'obfuscation', 'native-wasm',
      ];
      for (const cat of dangerousCategories) {
        expect(report.summary[cat]).toBe('none');
      }
      // env-credential may be legitimately absent
      expect(report.summary['env-credential']).toBe('none');
      expect(report.findings).toHaveLength(0);
    });

    it('benign-v1: cold-start delta with no predecessor', () => {
      const report = extractCapabilities(fixturePath('benign-v1'));
      const result = computeCapabilityDelta(null, report);
      expect(result.isColdStart).toBe(true);
      expect(result.overallRisk).toBe('none');
      expect(result.deltas).toHaveLength(0);
      // All summary entries should be 'none'
      expect(Object.values(result.summary).every((v) => v === 'none')).toBe(true);
    });

    it('malicious-v2: detects network, filesystem, process, dynamic-code, env-credential', () => {
      const report = extractCapabilities(fixturePath('malicious-v2'));
      // network: require('http'), require('https'), process.env usage
      expect(report.summary.network).toBe('medium');
      // filesystem: require('fs'), writeFileSync, unlinkSync
      expect(report.summary.filesystem).toBe('high');
      // process: require('child_process'), execSync
      expect(report.summary.process).toBe('high');
      // dynamic-code: eval(
      expect(report.summary['dynamic-code']).toBe('high');
      // env-credential: process.env
      expect(report.summary['env-credential']).toBe('medium');

      // Verify specific findings exist
      const categories = report.findings.map((f) => f.category);
      expect(categories).toContain('network');
      expect(categories).toContain('filesystem');
      expect(categories).toContain('process');
      expect(categories).toContain('dynamic-code');
      expect(categories).toContain('env-credential');
    });

    it('malicious-v2 vs benign-v1: delta detects all new capabilities', () => {
      const oldReport = extractCapabilities(fixturePath('benign-v1'));
      const newReport = extractCapabilities(fixturePath('malicious-v2'));

      const result = computeCapabilityDelta(oldReport, newReport);
      expect(result.isColdStart).toBe(false);

      // Should detect newly added capabilities
      const addedCategories = result.deltas
        .filter((d) => d.changeType === 'added')
        .map((d) => d.category);

      expect(addedCategories).toContain('network');
      expect(addedCategories).toContain('filesystem');
      expect(addedCategories).toContain('process');
      expect(addedCategories).toContain('dynamic-code');
      expect(addedCategories).toContain('env-credential');

      // All added deltas should be isNew
      expect(result.deltas.every((d) => d.changeType !== 'added' || d.isNew)).toBe(true);

      // Overall risk should be high due to high-severity additions
      expect(result.overallRisk).toBe('high');

      // Summary should mark added categories
      expect(result.summary.network).toBe('added');
      expect(result.summary.filesystem).toBe('added');
      expect(result.summary.process).toBe('added');
    });

    it('benign-diff v1->v2: no new capabilities from code, only new dependency (no risk pattern)', () => {
      const oldReport = extractCapabilities(fixturePath('benign-diff', 'v1'));
      const newReport = extractCapabilities(fixturePath('benign-diff', 'v2'));

      // Both versions should have identical code — same capabilities
      expect(oldReport.findings).toEqual(newReport.findings);

      const result = computeCapabilityDelta(oldReport, newReport);
      // No code-level capability changes
      expect(result.deltas.filter((d) => d.category !== 'dependency-indirection')).toHaveLength(0);
      expect(result.overallRisk).toBe('none');
      // chalk is not flagged by dependency-indirection patterns
      const depDeltas = result.deltas.filter((d) => d.category === 'dependency-indirection');
      expect(depDeltas).toHaveLength(0);
    });

    it('benign-diff v2: cold-start with clean package', () => {
      const report = extractCapabilities(fixturePath('benign-diff', 'v2'));
      const result = computeCapabilityDelta(null, report);
      expect(result.isColdStart).toBe(true);
      expect(result.overallRisk).toBe('none');
      expect(result.deltas).toHaveLength(0);
    });

    it('obfuscated: detects obfuscation patterns', () => {
      const report = extractCapabilities(fixturePath('obfuscated'));

      // obfuscation category
      expect(report.summary.obfuscation).toBe('low');
      const obfuscationFindings = report.findings.filter((f) => f.category === 'obfuscation');
      expect(obfuscationFindings.length).toBeGreaterThanOrEqual(1);

      // Should also have base64 decoding evidence
      const obfuscationEvidence = obfuscationFindings.flatMap((f) => f.evidence);
      const allEvidence = obfuscationEvidence.join(' ');
      expect(allEvidence).toMatch(/base64|Buffer/);

      // dynamic-code: eval( in decodeAndRun
      expect(report.summary['dynamic-code']).toBe('high');

      // network: fetch(
      expect(report.summary.network).toBe('medium');

      // env-credential: process.env is inside a base64 string literal, not actual code
      // The regex process\.env does not match the base64-encoded payload
      expect(report.summary['env-credential']).toBe('none');
    });

    it('obfuscated: cold-start delta produces all findings as added', () => {
      const report = extractCapabilities(fixturePath('obfuscated'));
      const result = computeCapabilityDelta(null, report);

      expect(result.isColdStart).toBe(true);
      expect(result.deltas.length).toBeGreaterThanOrEqual(3); // obfuscation, dynamic-code, network
      expect(result.deltas.every((d) => d.isNew)).toBe(true);
      expect(result.overallRisk).toBe('high'); // high-severity dynamic-code

      const deltaCategories = result.deltas.map((d) => d.category);
      expect(deltaCategories).toContain('obfuscation');
      expect(deltaCategories).toContain('dynamic-code');
      expect(deltaCategories).toContain('network');
    });

    it('dependency-only v1: clean extraction', () => {
      const report = extractCapabilities(fixturePath('dependency-only', 'v1'));
      // simple-math does only arithmetic — no dangerous capabilities
      expect(report.findings).toHaveLength(0);
      expect(Object.values(report.summary).every((v) => v === 'none')).toBe(true);
    });

    it('dependency-only v1->v2: no code changes, but new dangerous dependency flagged', () => {
      const oldReport = extractCapabilities(fixturePath('dependency-only', 'v1'));
      const newReport = extractCapabilities(fixturePath('dependency-only', 'v2'));

      // Code is identical — no capability changes from extraction
      expect(oldReport.findings).toEqual(newReport.findings);

      // Manually supply a dependency diff with the suspicious new dep
      const depDiff: DependencyDiff = {
        added: { 'postinstall-exec': '^1.0.0' },
        removed: {},
        changed: {},
      };

      const result = computeCapabilityDelta(oldReport, newReport, depDiff);

      // Should have dependency-indirection delta for postinstall-exec
      const indirectionDeltas = result.deltas.filter((d) => d.category === 'dependency-indirection');
      expect(indirectionDeltas).toHaveLength(1);
      expect(indirectionDeltas[0].changeType).toBe('added');
      expect(indirectionDeltas[0].isNew).toBe(true);
      expect(indirectionDeltas[0].description).toMatch(/postinstall-exec/);

      // No code-level capability deltas
      const codeDeltas = result.deltas.filter(
        (d) => d.category !== 'dependency-indirection' && d.category !== 'install-time'
      );
      expect(codeDeltas).toHaveLength(0);

      // postinstall-exec matches the install script pattern which is classified as 'high' risk
      expect(result.overallRisk).toBe('high');
    });

    it('dependency-only v2 cold-start with dep diff still flags dependency', () => {
      const report = extractCapabilities(fixturePath('dependency-only', 'v2'));

      const depDiff: DependencyDiff = {
        added: { 'postinstall-exec': '^1.0.0' },
        removed: {},
        changed: {},
      };

      const result = computeCapabilityDelta(null, report, depDiff);

      expect(result.isColdStart).toBe(true);
      expect(result.overallRisk).toBe('none'); // cold-start with no high/medium findings

      // Even though code is clean, the dependency diff still adds indirection delta
      const indirectionDeltas = result.deltas.filter((d) => d.category === 'dependency-indirection');
      expect(indirectionDeltas).toHaveLength(1);
      expect(indirectionDeltas[0].isNew).toBe(true);
    });

    it('dependency-only v2 with lifecycle script diff flags install-time', () => {
      const oldReport = extractCapabilities(fixturePath('dependency-only', 'v1'));
      const newReport = extractCapabilities(fixturePath('dependency-only', 'v2'));

      const lcDiff: LifecycleScriptDiff = {
        scripts: [
          { name: 'postinstall', command: 'node setup.js', new: true },
        ],
      };

      const result = computeCapabilityDelta(oldReport, newReport, undefined, lcDiff);

      const installTimeDeltas = result.deltas.filter((d) => d.category === 'install-time');
      expect(installTimeDeltas).toHaveLength(1);
      expect(installTimeDeltas[0].changeType).toBe('added');
      expect(installTimeDeltas[0].description).toMatch(/postinstall/);
      expect(result.overallRisk).toBe('high');
    });

    it('malicious-v2 vs benign-v1 with dependency and lifecycle diffs adds extra deltas', () => {
      const oldReport = extractCapabilities(fixturePath('benign-v1'));
      const newReport = extractCapabilities(fixturePath('malicious-v2'));

      const depDiff: DependencyDiff = {
        added: {},
        removed: {},
        changed: {},
      };

      const lcDiff: LifecycleScriptDiff = {
        scripts: [
          { name: 'postinstall', command: 'node install.js', new: true },
        ],
      };

      const result = computeCapabilityDelta(oldReport, newReport, depDiff, lcDiff);

      // Should have install-time delta from lifecycle script
      const installTimeDeltas = result.deltas.filter((d) => d.category === 'install-time');
      expect(installTimeDeltas).toHaveLength(1);

      // Should have all the code-level capability deltas
      const codeCategories = result.deltas
        .filter((d) => d.category !== 'install-time')
        .map((d) => d.category);
      expect(codeCategories).toContain('network');
      expect(codeCategories).toContain('filesystem');
      expect(codeCategories).toContain('process');
      expect(codeCategories).toContain('dynamic-code');
      expect(codeCategories).toContain('env-credential');

      // Overall risk should be high (postinstall + high-severity capabilities)
      expect(result.overallRisk).toBe('high');
    });
  });
});
