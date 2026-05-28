/**
 * Capability-delta extraction for version diffs.
 *
 * Compares two capability reports (old vs new version) and surfaces
 * what capabilities are NEW or materially changed in the new version.
 * Handles cold-start (no predecessor) as a full-package capability report.
 */

import type { CapabilityReport, CapabilityCategory } from './capability-extract.js';
import type { DependencyDiff, LifecycleScriptDiff } from './package-diff.js';
import type { EvidenceBundle } from './evidence-bundle.js';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

/**
 * A single capability delta — something that changed between versions.
 */
export interface CapabilityDelta {
  category: CapabilityCategory;
  severity: 'none' | 'low' | 'medium' | 'high';
  description: string;
  files: string[];
  /** Whether this capability is entirely new (not present in predecessor) */
  isNew: boolean;
  /** What changed about this capability */
  changeType: 'added' | 'intensified' | 'reduced' | 'removed';
  /** Evidence snippets */
  evidence: string[];
}

/**
 * Full capability-delta result for a version diff.
 */
export interface CapabilityDeltaReport {
  /** Individual deltas */
  deltas: CapabilityDelta[];
  /** Quick summary: which categories have changes */
  summary: Record<CapabilityCategory, 'none' | 'added' | 'changed' | 'removed'>;
  /** Overall risk level based on deltas */
  overallRisk: 'none' | 'low' | 'medium' | 'high' | 'critical';
  /** Cold-start flag */
  isColdStart: boolean;
}

// ── Dependency indirection detection ─────────────────────────

const DANGEROUS_DEPENDENCY_PATTERNS = [
  /(?:npm|package|install).*script/i,
  /(?:postinstall|preinstall|prepare)/i,
  /(?:native|binary|wasm)/i,
  /(?:download|fetch|curl|wget)/i,
  /(?:obfuscat|minif|encod)/i,
  /(?:shell|exec|spawn|child_process)/i,
  /(?:network|http|tcp|socket)/i,
];

/**
 * Analyze dependencies for indirection risk (dependencies that
 * execute install scripts, download things, or use shell/network).
 */
export function analyzeDependencyIndirection(
  dependencies: Record<string, string>,
  devDependencies?: Record<string, string>
): Array<{ name: string; version: string; risk: 'low' | 'medium' | 'high'; reason: string }> {
  const findings: Array<{ name: string; version: string; risk: 'low' | 'medium' | 'high'; reason: string }> = [];
  const allDeps = { ...dependencies, ...(devDependencies ?? {}) };

  for (const [name, version] of Object.entries(allDeps)) {
    for (const pattern of DANGEROUS_DEPENDENCY_PATTERNS) {
      if (pattern.test(name)) {
        findings.push({
          name,
          version,
          risk: name.includes('postinstall') || name.includes('install') ? 'high' : 'medium',
          reason: `Dependency name matches suspicious pattern: ${pattern.source}`,
        });
        break;
      }
    }
  }

  return findings;
}

// ── Capability delta comparison ──────────────────────────────

/**
 * Compare two capability reports and produce a delta.
 *
 * @param oldReport - Capability report from the predecessor version (null for cold-start)
 * @param newReport - Capability report from the new version
 * @param depDiff - Dependency diff between versions
 * @param lcDiff - Lifecycle script diff between versions
 */
export function computeCapabilityDelta(
  oldReport: CapabilityReport | null,
  newReport: CapabilityReport,
  depDiff?: DependencyDiff,
  lcDiff?: LifecycleScriptDiff
): CapabilityDeltaReport {
  const deltas: CapabilityDelta[] = [];
  const isColdStart = oldReport === null;

  const allCategories: CapabilityCategory[] = [
    'network', 'filesystem', 'process', 'dynamic-code',
    'env-credential', 'native-wasm', 'obfuscation',
    'dependency-indirection', 'install-time',
  ];

  // ── Compare capability summaries ─────────────────────────

  for (const category of allCategories) {
    const oldLevel = oldReport?.summary?.[category] ?? 'none';
    const newLevel = newReport.summary[category] ?? 'none';

    // Find old and new findings for this category
    const oldFindings = oldReport?.findings?.filter((f) => f.category === category) ?? [];
    const newFindings = newReport.findings.filter((f) => f.category === category);

    if (newLevel === 'none' && oldLevel === 'none') {
      // No change — skip
      continue;
    }

    if (newLevel !== 'none' && oldLevel === 'none') {
      // Entirely new capability
      deltas.push({
        category,
        severity: newLevel,
        description: `New ${category} capability introduced`,
        files: [...new Set(newFindings.flatMap((f) => f.files))],
        isNew: true,
        changeType: 'added',
        evidence: newFindings.flatMap((f) => f.evidence).slice(0, 5),
      });
    } else if (newLevel === 'none' && oldLevel !== 'none') {
      // Capability removed
      deltas.push({
        category,
        severity: oldLevel,
        description: `${category} capability removed`,
        files: [...new Set(oldFindings.flatMap((f) => f.files))],
        isNew: false,
        changeType: 'removed',
        evidence: [],
      });
    } else {
      // Capability exists in both — check for intensification
      const severityOrder = ['none', 'low', 'medium', 'high'];
      const oldIdx = severityOrder.indexOf(oldLevel);
      const newIdx = severityOrder.indexOf(newLevel);

      if (newIdx > oldIdx) {
        deltas.push({
          category,
          severity: newLevel,
          description: `${category} capability intensified (${oldLevel} -> ${newLevel})`,
          files: [...new Set(newFindings.flatMap((f) => f.files))],
          isNew: false,
          changeType: 'intensified',
          evidence: newFindings.flatMap((f) => f.evidence).slice(0, 5),
        });
      }
    }
  }

  // ── Add dependency-change evidence ───────────────────────

  if (depDiff) {
    // New dependencies that look suspicious
    for (const [name, version] of Object.entries(depDiff.added)) {
      const risk = analyzeDependencyIndirection({ [name]: version });
      const firstRisk = risk[0];
      if (firstRisk) {
        deltas.push({
          category: 'dependency-indirection',
          severity: firstRisk.risk,
          description: `Suspicious new dependency: ${name}@${version}`,
          files: ['package.json'],
          isNew: true,
          changeType: 'added',
          evidence: [`New dependency ${name} matches risk pattern: ${firstRisk.reason}`],
        });
      }
    }
  }

  // ── Add lifecycle script changes ─────────────────────────

  if (lcDiff) {
    for (const script of lcDiff.scripts) {
      if (script.new) {
        deltas.push({
          category: 'install-time',
          severity: 'high',
          description: `New lifecycle script: ${script.name}`,
          files: ['package.json'],
          isNew: true,
          changeType: 'added',
          evidence: [`Command: ${script.command}`],
        });
      }
    }
  }

  // ── Summary ──────────────────────────────────────────────

  const summary = {} as Record<CapabilityCategory, 'none' | 'added' | 'changed' | 'removed'>;
  for (const category of allCategories) {
    const catDeltas = deltas.filter((d) => d.category === category);
    if (catDeltas.length === 0) {
      summary[category] = 'none';
    } else if (catDeltas.some((d) => d.changeType === 'added')) {
      summary[category] = 'added';
    } else if (catDeltas.some((d) => d.changeType === 'intensified')) {
      summary[category] = 'changed';
    } else {
      summary[category] = 'removed';
    }
  }

  // ── Overall risk ─────────────────────────────────────────

  type RiskLevel = 'none' | 'low' | 'medium' | 'high' | 'critical';
  let overallRisk: RiskLevel = 'none';

  if (isColdStart) {
    // Cold-start: conservative — base on severity
    const allSeverities = newReport.findings.map((f) => f.severity);
    if (allSeverities.includes('high')) overallRisk = 'high';
    else if (allSeverities.includes('medium')) overallRisk = 'medium';
    else if (allSeverities.length > 0) overallRisk = 'low';
  } else {
    // Version diff: focus on new/intensified capabilities
    const newDeltas = deltas.filter((d) => d.changeType === 'added' || d.changeType === 'intensified');
    if (newDeltas.some((d) => d.severity === 'high')) overallRisk = 'high';
    else if (newDeltas.some((d) => d.severity === 'medium')) overallRisk = 'medium';
    else if (newDeltas.length > 0) overallRisk = 'low';
  }

  return {
    deltas,
    summary,
    overallRisk,
    isColdStart,
  };
}

// ── Cold-start evidence enrichment ──────────────────────────

/**
 * Build a full-package evidence bundle for cold-start audits.
 * Includes provenance signals, capability analysis, dependency graph,
 * and metadata not available in version-diff bundles.
 */
export function buildColdStartEvidence(
  packageDir: string,
  packageName: string,
  packageVersion: string,
  tarballHash: string
): Partial<EvidenceBundle> & { 
  maintainerSignals: string[]; 
  provenance: Record<string, string | null>;
  installTraceAvailable: boolean;
  networkObservations: string[];
} {
  const maintainerSignals: string[] = [];
  const provenance: Record<string, string | null> = {};
  let installTraceAvailable = false;
  const networkObservations: string[] = [];

  // Read package.json for provenance and maintainer info
  const pkgPath = join(packageDir, 'package.json');
  if (existsSync(pkgPath)) {
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
    provenance.author = typeof pkg.author === 'object' ? pkg.author.name ?? null : pkg.author ?? null;
    provenance.publisher = pkg.publisher ?? null;
    provenance.maintainers = Array.isArray(pkg.maintainers) ? pkg.maintainers.map((m: unknown) => typeof m === 'object' ? (m as Record<string, string>).name ?? String(m) : String(m)).join(', ') : null;
    provenance.repository = typeof pkg.repository === 'object' ? pkg.repository.url ?? null : pkg.repository ?? null;
    provenance.homepage = pkg.homepage ?? null;
    provenance.license = pkg.license ?? null;
    provenance.issues = pkg.bugs?.url ?? null;
  }

  // Check for install scripts
  if (existsSync(pkgPath)) {
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
    const scripts = pkg.scripts ?? {};
    if (scripts.preinstall || scripts.install || scripts.postinstall) {
      installTraceAvailable = true;
    }
  }

  return {
    maintainerSignals,
    provenance,
    installTraceAvailable,
    networkObservations,
    packageInfo: {
      name: packageName,
      version: packageVersion,
      predecessorVersion: null,
      registrySource: 'npm',
      tarballHash,
    },
  };
}
