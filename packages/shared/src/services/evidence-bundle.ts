import type { FileDiff, DependencyDiff, LifecycleScriptDiff } from './package-diff.js';
import type { CapabilityReport } from './capability-extract.js';

export interface EvidenceBundle {
  /** Whether this is a cold-start (no predecessor) audit */
  isColdStart: boolean;
  /** Package metadata */
  packageInfo: {
    name: string;
    version: string;
    predecessorVersion: string | null;
    registrySource: string;
    tarballHash: string;
  };
  /** File-level diff between versions (empty for cold-start) */
  fileDiff?: FileDiff;
  /** Dependency changes */
  dependencyDiff: DependencyDiff;
  /** Lifecycle script changes */
  lifecycleScriptDiff: LifecycleScriptDiff;
  /** Static capability analysis for the new version */
  capabilityReport: CapabilityReport;
  /** Intent and context metadata */
  intentEvidence: IntentEvidence;
  /** Rankings for PI consumption */
  rankings: EvidenceRanking[];
  /** Timestamp */
  preparedAt: string;
}

export interface IntentEvidence {
  description?: string;
  changelog?: string;
  readmeSummary?: string;
  homepageUrl?: string;
  repositoryUrl?: string;
  license?: string;
  mismatchIndicators: string[];
}

export interface EvidenceRanking {
  priority: 'critical' | 'high' | 'medium' | 'low';
  category: string;
  summary: string;
  detail: string;
}

/**
 * Build a structured evidence bundle for a package audit.
 * Used by the PI agent for review and by the policy layer for decision support.
 */
export function buildEvidenceBundle(params: {
  packageName: string;
  version: string;
  predecessorVersion: string | null;
  tarballHash: string;
  registrySource?: string;
  fileDiff?: FileDiff;
  dependencyDiff: DependencyDiff;
  lifecycleScriptDiff: LifecycleScriptDiff;
  capabilityReport: CapabilityReport;
  intentEvidence: IntentEvidence;
}): EvidenceBundle {
  const isColdStart = params.predecessorVersion === null;
  const rankings: EvidenceRanking[] = [];

  // Rank capability findings
  for (const finding of params.capabilityReport.findings) {
    const priority = finding.severity === 'high' ? 'critical' as const
      : finding.severity === 'medium' ? 'high' as const
      : 'medium' as const;

    rankings.push({
      priority,
      category: `capability:${finding.category}`,
      summary: finding.description,
      detail: `Found in ${finding.files.length} file(s): ${finding.files.slice(0, 3).join(', ')}`,
    });
  }

  // Rank file changes
  if (params.fileDiff) {
    for (const added of params.fileDiff.added) {
      rankings.push({
        priority: 'medium',
        category: 'file:added',
        summary: `New file: ${added.path}`,
        detail: `Size: ${added.size} bytes`,
      });
    }
    for (const changed of params.fileDiff.changed) {
      rankings.push({
        priority: 'low',
        category: 'file:changed',
        summary: `Changed file: ${changed.path}`,
        detail: `Size: ${changed.oldSize} -> ${changed.newSize} bytes`,
      });
    }
  }

  // Rank dependency changes
  for (const [name, version] of Object.entries(params.dependencyDiff.added)) {
    rankings.push({
      priority: 'medium',
      category: 'dependency:added',
      summary: `New dependency: ${name}@${version}`,
      detail: `Package "${name}" added at version ${version}`,
    });
  }
  for (const [name, change] of Object.entries(params.dependencyDiff.changed)) {
    rankings.push({
      priority: 'low',
      category: 'dependency:changed',
      summary: `Dependency updated: ${name} ${change.old} -> ${change.new}`,
      detail: `Version bump from ${change.old} to ${change.new}`,
    });
  }

  // Rank lifecycle scripts
  for (const script of params.lifecycleScriptDiff.scripts) {
    rankings.push({
      priority: script.new ? 'high' : 'low',
      category: 'lifecycle-script',
      summary: `${script.new ? 'New' : 'Existing'} lifecycle script: ${script.name}`,
      detail: `Command: ${script.command}`,
    });
  }

  // Cold-start specific markers
  if (isColdStart) {
    rankings.push({
      priority: 'high',
      category: 'cold-start',
      summary: 'Cold-start audit — no predecessor version available',
      detail: 'Full package review required. Conservative allow standards apply.',
    });
  }

  // Sort by priority
  const priorityOrder = { critical: 0, high: 1, medium: 2, low: 3 };
  rankings.sort((a, b) => priorityOrder[a.priority] - priorityOrder[b.priority]);

  return {
    isColdStart,
    packageInfo: {
      name: params.packageName,
      version: params.version,
      predecessorVersion: params.predecessorVersion,
      registrySource: params.registrySource ?? 'npm',
      tarballHash: params.tarballHash,
    },
    fileDiff: params.fileDiff,
    dependencyDiff: params.dependencyDiff,
    lifecycleScriptDiff: params.lifecycleScriptDiff,
    capabilityReport: params.capabilityReport,
    intentEvidence: params.intentEvidence,
    rankings,
    preparedAt: new Date().toISOString(),
  };
}
