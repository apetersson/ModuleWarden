/**
 * Prompt Pack Service
 *
 * Builds run-specific instruction bundles for PI audit containers.
 * Prompt contents are injected only into the private audit container workspace.
 * User-facing endpoints expose names, versions, and hashes, not raw prompt text.
 */

import { getCurrentPromptPacks } from '@modulewarden/prisma-client';
import { getActiveModelProfile, getEscalationModelProfile } from '@modulewarden/prisma-client';
import type { EvidenceBundle } from '@modulewarden/shared/services/evidence-bundle';
import type { CapabilityDeltaReport } from '@modulewarden/shared/services/capability-delta';

/**
 * An assembled set of run instructions for a single audit container.
 * Includes the configured prompt-pack content for private container injection.
 */
export interface AuditInstructions {
  /** Package being audited */
  packageName: string;
  packageVersion: string;
  /** Whether this is a cold-start audit (no predecessor) */
  isColdStart: boolean;
  /** Core prompt pack versions used (not the content) */
  corePromptVersions: string[];
  /** Pattern prompt pack versions used (not the content) */
  patternPromptVersions: string[];
  /** Custom prompt names (not the content) used alongside core */
  customPromptNames: string[];
  /** Escalation prompt pack versions selected for this run */
  escalationPromptVersions: string[];
  /** Private prompt-pack content to inject into the audit runner */
  promptSections: Array<{
    name: string;
    version: string;
    category: string;
    content: string;
    hash: string;
  }>;
  /** Aggregated instruction text for the PI prompt */
  instructionsText: string;
  /** Model endpoint to use */
  modelProfile: {
    name: string;
    baseUrl: string;
    modelName: string;
  };
  /** Whether escalation should be triggered after first pass */
  needsEscalation: boolean;
  /** Escalation model profile (if different from first-pass) */
  escalationModelProfile: {
    name: string;
    baseUrl: string;
    modelName: string;
  } | null;
}

/**
 * Determine if a capability-delta report warrants escalation.
 */
function shouldEscalate(deltaReport: CapabilityDeltaReport | null): boolean {
  if (!deltaReport) return false;
  if (deltaReport.overallRisk === 'high' || deltaReport.overallRisk === 'critical') return true;
  if (deltaReport.deltas.some((d) => d.changeType === 'added' && d.category === 'process')) return true;
  if (deltaReport.deltas.some((d) => d.changeType === 'added' && d.category === 'dynamic-code')) return true;
  return false;
}

/**
 * Build a concise instruction summary from evidence bundle.
 */
function buildInstructionSummary(
  bundle: EvidenceBundle,
  deltaReport: CapabilityDeltaReport | null
): string {
  const lines: string[] = [];

  if (bundle.isColdStart) {
    lines.push(`Cold-start audit: no predecessor version available.`);
    lines.push(`Conservative allow standards apply — unclear evidence → quarantine.`);
  } else {
    lines.push(`Version-diff audit: comparing against predecessor.`);
    lines.push(`Focus on NEW or intensified capabilities not present in the predecessor.`);
  }

  // Add capability context
  if (deltaReport && deltaReport.deltas.length > 0) {
    const newCaps = deltaReport.deltas.filter((d) => d.changeType === 'added');
    const intensified = deltaReport.deltas.filter((d) => d.changeType === 'intensified');

    if (newCaps.length > 0) {
      lines.push(`\nNew capabilities detected: ${newCaps.map((d) => d.category).join(', ')}`);
    }
    if (intensified.length > 0) {
      lines.push(`Intensified capabilities: ${intensified.map((d) => d.category).join(', ')}`);
    }
  }

  // Add dependency changes
  const addedDeps = Object.keys(bundle.dependencyDiff.added);
  if (addedDeps.length > 0) {
    lines.push(`\nNew dependencies: ${addedDeps.slice(0, 5).join(', ')}`);
  }

  // Add lifecycle script changes
  if (bundle.lifecycleScriptDiff.scripts.length > 0) {
    lines.push(`\nLifecycle scripts: ${bundle.lifecycleScriptDiff.scripts.map((s) => s.name).join(', ')}`);
  }

  // Add intent context
  if (bundle.intentEvidence.description) {
    lines.push(`\nPackage purpose: ${bundle.intentEvidence.description.slice(0, 200)}`);
  }
  if (bundle.intentEvidence.mismatchIndicators.length > 0) {
    lines.push(`\nIntent mismatches: ${bundle.intentEvidence.mismatchIndicators.join('; ')}`);
  }

  // Rankings summary
  if (bundle.rankings.length > 0) {
    const highPri = bundle.rankings.filter((r) => r.priority === 'critical' || r.priority === 'high');
    if (highPri.length > 0) {
      lines.push(`\nHigh-priority findings: ${highPri.map((r) => r.summary).join('; ')}`);
    }
  }

  return lines.join('\n');
}

/**
 * Assemble audit instructions for a specific package audit.
 *
 * @param bundle - Evidence bundle prepared for this audit
 * @param deltaReport - Capability-delta report (null for cold-start)
 * @returns Audit instructions safe for container injection
 */
export async function assembleAuditInstructions(
  bundle: EvidenceBundle,
  deltaReport: CapabilityDeltaReport | null
): Promise<AuditInstructions> {
  const packs = await getCurrentPromptPacks();
  const activeProfile = await getActiveModelProfile();
  const escalationProfile = await getEscalationModelProfile();

  const needsEscalation = shouldEscalate(deltaReport);
  const selectedPacks = [
    ...packs.core,
    ...packs.pattern,
    ...packs.custom,
    ...(needsEscalation ? packs.escalation : []),
  ];

  if (selectedPacks.length === 0) {
    throw new Error(
      'No configured prompt packs are available. Seed or configure prompt packs before running audits.'
    );
  }

  return {
    packageName: bundle.packageInfo.name,
    packageVersion: bundle.packageInfo.version,
    isColdStart: bundle.isColdStart,
    corePromptVersions: packs.core.map((p) => `${p.name}@${p.version}`),
    patternPromptVersions: packs.pattern.map((p) => `${p.name}@${p.version}`),
    customPromptNames: packs.custom.map((p) => p.name),
    escalationPromptVersions: needsEscalation ? packs.escalation.map((p) => `${p.name}@${p.version}`) : [],
    promptSections: selectedPacks.map((p) => ({
      name: p.name,
      version: p.version,
      category: p.category,
      content: p.content,
      hash: p.hash,
    })),
    instructionsText: buildInstructionSummary(bundle, deltaReport),
    modelProfile: {
      name: activeProfile.name,
      baseUrl: activeProfile.baseUrl,
      modelName: activeProfile.modelName,
    },
    needsEscalation,
    escalationModelProfile: needsEscalation && escalationProfile ? {
      name: escalationProfile.name,
      baseUrl: escalationProfile.baseUrl,
      modelName: escalationProfile.modelName,
    } : null,
  };
}

/**
 * Build a run-specific instruction file content for the container.
 * This is what gets written to /workspace/instructions.md inside the container.
 * Includes prompt-pack content for the private audit runner workspace.
 */
export function buildContainerInstructionFile(instructions: AuditInstructions): string {
  const promptPackVersions = [
    ...instructions.corePromptVersions,
    ...instructions.patternPromptVersions,
    ...instructions.escalationPromptVersions,
  ];

  return [
    `# ModuleWarden Audit Instructions`,
    ``,
    `Package: ${instructions.packageName}@${instructions.packageVersion}`,
    `Type: ${instructions.isColdStart ? 'cold-start' : 'version-diff'}`,
    `Core prompt packs: ${instructions.corePromptVersions.join(', ') || 'none'}`,
    `Pattern prompt packs: ${instructions.patternPromptVersions.join(', ') || 'none'}`,
    `Escalation prompt packs: ${instructions.escalationPromptVersions.join(', ') || 'none'}`,
    `Custom prompts: ${instructions.customPromptNames.join(', ') || 'none'}`,
    `Applied prompt packs: ${promptPackVersions.join(', ') || 'none'}`,
    `Model: ${instructions.modelProfile.modelName}`,
    `Escalation: ${instructions.needsEscalation ? `yes (${instructions.escalationModelProfile?.modelName ?? 'same model'})` : 'no'}`,
    ``,
    `## Configured Prompt Pack Content`,
    ``,
    ...instructions.promptSections.flatMap((section, index) => [
      `### Prompt ${index + 1}: ${section.name}@${section.version}`,
      `Category: ${section.category}`,
      `Hash: ${section.hash}`,
      ``,
      section.content.trim(),
      ``,
    ]),
    ``,
    `## Analysis Context`,
    ``,
    instructions.instructionsText,
    ``,
    `## Requirements`,
    ``,
    `1. Explore the package using provided tools`,
    `2. Analyze capability changes against the predecessor`,
    `3. Check for intent mismatches with package purpose`,
    `4. Write key findings as evidence artifacts`,
    `5. Submit structured verdict via RPC bridge`,
    ``,
    `## Verdict Options`,
    ``,
    `- allow — safe to use, no new concerning capabilities`,
    `- block — malicious or clearly unsafe`,
    `- quarantine — suspicious or unclear, needs human review`,
    ``,
    instructions.needsEscalation
      ? `Note: First-pass review recommended. High-risk findings will trigger escalation pass.`
      : `Note: Standard review pass. No escalation threshold triggered.`,
  ].join('\n');
}
