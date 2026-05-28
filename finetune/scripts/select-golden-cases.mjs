#!/usr/bin/env node

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

const DEFAULT_OUTPUT = "finetune/corpus/golden-cases.json";
const DEFAULT_INPUT = process.env.FT_DATA
  ? join(process.env.FT_DATA, "scraped-cases.npm-enriched.jsonl")
  : "finetune/corpus/scraped-cases.npm-enriched.jsonl";

function usage() {
  return `Usage: node finetune/scripts/select-golden-cases.mjs [options]

Options:
  --input <path>        Enriched scraped JSONL input. Default: ${DEFAULT_INPUT}
  --output <path>       Golden case manifest output. Default: ${DEFAULT_OUTPUT}
  --target <n>          Number of scraped cases to select. Default: 80.
  --max-per-cwe <n>     Initial maximum per primary CWE. Default: 5.
  --dry-run             Print summary without writing the manifest.
  --help                Show this help.

Environment:
  FT_DATA               Optional data directory containing scraped-cases.npm-enriched.jsonl.
`;
}

function parseArgs(argv) {
  const args = {
    input: DEFAULT_INPUT,
    output: DEFAULT_OUTPUT,
    target: 80,
    maxPerCwe: 5,
    dryRun: false
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--") {
      continue;
    } else if (arg === "--help") {
      args.help = true;
    } else if (arg === "--input") {
      args.input = argv[++i];
    } else if (arg === "--output") {
      args.output = argv[++i];
    } else if (arg === "--target") {
      args.target = Number(argv[++i]);
    } else if (arg === "--max-per-cwe") {
      args.maxPerCwe = Number(argv[++i]);
    } else if (arg === "--dry-run") {
      args.dryRun = true;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (!Number.isInteger(args.target) || args.target <= 0) {
    throw new Error("--target must be a positive integer");
  }
  if (!Number.isInteger(args.maxPerCwe) || args.maxPerCwe <= 0) {
    throw new Error("--max-per-cwe must be a positive integer");
  }

  return args;
}

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

async function readJsonl(path) {
  const text = await readFile(path, "utf8");
  return text
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line, index) => {
      try {
        return JSON.parse(line);
      } catch (error) {
        throw new Error(`Invalid JSONL at ${path}:${index + 1}: ${error.message}`);
      }
    });
}

function roleVersion(record, role) {
  return record.candidate_versions?.find((candidate) => candidate.role === role)?.version ?? null;
}

function rolePublishedAt(record, role) {
  return record.candidate_versions?.find((candidate) => candidate.role === role)?.published_at ?? null;
}

function primaryCwe(record) {
  return record.cwes?.[0] ?? "unknown_cwe";
}

function hasCommitReference(record) {
  return (record.references ?? []).some((reference) => /\/commit\//i.test(reference));
}

function hasSecurityAdvisoryReference(record) {
  return (record.references ?? []).some((reference) => /security\/advisories|github\.com\/advisories/i.test(reference));
}

function hasReleaseReference(record) {
  return (record.references ?? []).some((reference) => /\/releases\/tag\//i.test(reference));
}

function repositoryUrl(record) {
  return (
    record.source_code_location ??
    record.npm?.repository?.url ??
    record.references?.find((reference) => /github\.com\/[^/]+\/[^/]+/i.test(reference)) ??
    null
  );
}

function stableVersion(version) {
  return typeof version === "string" && !version.includes("-");
}

function scoreRecord(record) {
  let score = 0;
  const neighborCount = record.benign_neighbor_versions?.length ?? 0;
  const referenceCount = record.references?.length ?? 0;
  const versionCount = record.npm?.version_count ?? 0;

  if (roleVersion(record, "likely_affected")) score += 25;
  if (roleVersion(record, "first_patched")) score += 25;
  if (neighborCount >= 2) score += 16;
  else if (neighborCount === 1) score += 8;
  if (repositoryUrl(record)) score += 12;
  if (hasCommitReference(record)) score += 10;
  if (hasSecurityAdvisoryReference(record)) score += 8;
  if (hasReleaseReference(record)) score += 4;
  if (referenceCount >= 3) score += 6;
  else if (referenceCount >= 2) score += 3;
  if ((record.cwes?.length ?? 0) > 0) score += 6;
  if (record.summary) score += 4;
  if (record.affected_range) score += 4;
  if (record.first_patched_version) score += 4;
  if (record.severity === "critical") score += 5;
  if (record.severity === "high") score += 3;
  if (versionCount >= 10) score += 6;
  else if (versionCount >= 3) score += 3;
  if ((record.npm?.maintainers?.length ?? 0) > 0) score += 2;
  if (stableVersion(roleVersion(record, "likely_affected"))) score += 3;
  if (stableVersion(roleVersion(record, "first_patched"))) score += 3;

  return score;
}

function isEligibleCveRecord(record) {
  return (
    record.triage_status === "candidate" &&
    record.case_type === "cve_diff" &&
    Boolean(record.package) &&
    Boolean(roleVersion(record, "likely_affected")) &&
    Boolean(roleVersion(record, "first_patched")) &&
    Boolean(record.affected_range) &&
    Boolean(record.first_patched_version) &&
    (record.references?.length ?? 0) >= 2 &&
    Boolean(repositoryUrl(record))
  );
}

function dedupeByBest(records, keyFn) {
  const best = new Map();
  for (const record of records) {
    const key = keyFn(record);
    const existing = best.get(key);
    if (!existing || compareByScore(record, existing) < 0) {
      best.set(key, record);
    }
  }
  return [...best.values()];
}

function compareByScore(a, b) {
  const scoreDiff = scoreRecord(b) - scoreRecord(a);
  if (scoreDiff !== 0) return scoreDiff;
  const cweDiff = primaryCwe(a).localeCompare(primaryCwe(b));
  if (cweDiff !== 0) return cweDiff;
  const packageDiff = a.package.localeCompare(b.package);
  if (packageDiff !== 0) return packageDiff;
  return a.case_id.localeCompare(b.case_id);
}

function selectWithDiversity(records, target, maxPerCwe) {
  const sorted = [...records].sort(compareByScore);
  const selected = [];
  const usedPackages = new Set();
  const cweCounts = new Map();
  const severityCounts = new Map();
  const severityQuota = {
    critical: Math.floor(target * 0.45),
    high: target - Math.floor(target * 0.45)
  };

  function canUse(record, cweLimit, enforceSeverityQuota) {
    if (usedPackages.has(record.package)) return false;
    const cwe = primaryCwe(record);
    if ((cweCounts.get(cwe) ?? 0) >= cweLimit) return false;
    if (enforceSeverityQuota) {
      const severity = record.severity ?? "unknown";
      const quota = severityQuota[severity];
      if (quota != null && (severityCounts.get(severity) ?? 0) >= quota) return false;
    }
    return true;
  }

  function add(record) {
    selected.push(record);
    usedPackages.add(record.package);
    const cwe = primaryCwe(record);
    cweCounts.set(cwe, (cweCounts.get(cwe) ?? 0) + 1);
    const severity = record.severity ?? "unknown";
    severityCounts.set(severity, (severityCounts.get(severity) ?? 0) + 1);
  }

  for (const cweLimit of [maxPerCwe, maxPerCwe + 2, maxPerCwe + 5, Number.POSITIVE_INFINITY]) {
    for (const enforceSeverityQuota of [true, false]) {
      for (const record of sorted) {
        if (selected.length >= target) return selected;
        if (canUse(record, cweLimit, enforceSeverityQuota)) add(record);
      }
    }
  }

  return selected;
}

function hashString(value) {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function splitAssignments(records) {
  const sorted = [...records].sort((a, b) => {
    const hashDiff = hashString(a.package) - hashString(b.package);
    if (hashDiff !== 0) return hashDiff;
    return a.package.localeCompare(b.package);
  });
  const trainCount = Math.round(records.length * 0.7);
  const validationCount = Math.round(records.length * 0.15);
  const splitByCaseId = new Map();

  sorted.forEach((record, index) => {
    let split = "test";
    if (index < trainCount) split = "train";
    else if (index < trainCount + validationCount) split = "validation";
    splitByCaseId.set(record.case_id, split);
  });

  return splitByCaseId;
}

function semverDelta(fromVersion, toVersion) {
  const from = parseSemver(fromVersion);
  const to = parseSemver(toVersion);
  if (!from || !to) return "unknown";
  if (to.prerelease || from.prerelease) return "prerelease";
  if (to.major !== from.major) return "major";
  if (to.minor !== from.minor) return "minor";
  if (to.patch !== from.patch) return "patch";
  return "unknown";
}

function parseSemver(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)(-.+)?$/.exec(version ?? "");
  if (!match) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: Boolean(match[4])
  };
}

function caseIdFor(record) {
  return `golden_${record.case_id}`;
}

function riskLevelFor(record) {
  if (record.severity === "critical") return "medium";
  return "low";
}

function formatCwes(record) {
  return record.cwes?.length ? record.cwes.join(", ") : "no CWE tag";
}

function toGoldenCase(record, split) {
  const baselineVersion = roleVersion(record, "likely_affected");
  const candidateVersion = roleVersion(record, "first_patched");
  const neighborCount = record.benign_neighbor_versions?.length ?? 0;
  const advisoryIds = record.advisory_ids ?? [];
  const primaryReference = record.references?.[0] ?? "upstream advisory";

  return {
    case_id: caseIdFor(record),
    source: "scraped_candidate",
    source_case_id: record.case_id,
    case_type: "cve_diff",
    audit_mode: "version_diff",
    package: record.package,
    baseline_version: baselineVersion,
    candidate_version: candidateVersion,
    expected_verdict: "allow",
    expected_risk_level: riskLevelFor(record),
    confidence_target: "medium",
    split,
    labeling_status: "provisional_until_dossier_review",
    semver_delta: semverDelta(baselineVersion, candidateVersion),
    severity: record.severity ?? null,
    cwes: record.cwes ?? [],
    affected_range: record.affected_range ?? null,
    first_patched_version: record.first_patched_version ?? candidateVersion,
    candidate_published_at: rolePublishedAt(record, "first_patched"),
    baseline_published_at: rolePublishedAt(record, "likely_affected"),
    advisory_ids: advisoryIds,
    source_code_location: repositoryUrl(record),
    references: record.references ?? [],
    why_it_matters:
      `Reviewed npm advisory ${advisoryIds[0] ?? record.case_id} maps to an affected-to-patched version diff ` +
      `for ${record.package}; it covers ${formatCwes(record)} with ${neighborCount} adjacent neighbor version(s).`,
    selection_notes: [
      "Selected from enriched scraped cases because package, affected version, first patched version, references, and repository metadata are present.",
      `Primary source reference: ${primaryReference}`,
      "Expected label is provisional: keep allow only if generated dossier evidence confirms this is a fix release without new suspicious capabilities."
    ]
  };
}

function countBy(records, keyFn) {
  const counts = {};
  for (const record of records) {
    const key = keyFn(record) ?? "unknown";
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return Object.fromEntries(Object.entries(counts).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])));
}

function isManualGoldenCase(record) {
  return record.source === "manual_golden" || record.case_type === "manual_golden";
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(usage());
    return;
  }

  const inputPath = resolve(args.input);
  const outputPath = resolve(args.output);
  const scraped = await readJsonl(inputPath);
  const existing = await readJson(outputPath).catch(() => ({
    schema_version: "modulewarden.golden_cases.v1",
    description: "Promoted cases for ModuleWarden audit-dossier generation.",
    cases: []
  }));
  const manualCases = (existing.cases ?? []).filter(isManualGoldenCase);

  const eligible = dedupeByBest(scraped.filter(isEligibleCveRecord), (record) => record.package);
  const selected = selectWithDiversity(eligible, args.target, args.maxPerCwe);
  const splitByCaseId = splitAssignments(selected);
  const selectedCases = selected
    .map((record) => toGoldenCase(record, splitByCaseId.get(record.case_id) ?? "train"))
    .sort((a, b) => {
      const splitOrder = { train: 0, validation: 1, test: 2 };
      const splitDiff = splitOrder[a.split] - splitOrder[b.split];
      if (splitDiff !== 0) return splitDiff;
      return a.package.localeCompare(b.package);
    });

  const skippedIncidentReplay = scraped.filter(
    (record) =>
      record.case_type === "incident_replay" &&
      !roleVersion(record, "likely_affected")
  ).length;

  const manifest = {
    schema_version: existing.schema_version ?? "modulewarden.golden_cases.v1",
    description:
      "Curated starter golden case manifest for ModuleWarden audit-dossier generation. Keep test packages disjoint from train packages.",
    selection: {
      selected_at: new Date().toISOString(),
      input_path: inputPath,
      selected_scraped_cases: selectedCases.length,
      preserved_manual_cases: manualCases.length,
      strategy:
        "Preserve manual seeds; select high-evidence reviewed npm CVE cases with affected and first-patched versions, references, repository metadata, package-level deduping, and CWE/severity diversity.",
      quality_gates: [
        "triage_status is candidate",
        "case_type is cve_diff",
        "likely_affected and first_patched versions are present",
        "affected range and first patched version are present",
        "at least two public references are present",
        "repository or source-code location is present",
        "one selected case per package"
      ],
      provisional_labeling:
        "Scraped CVE-fix cases are selected for goldening, but expected allow labels must be confirmed after dossier generation and diff review.",
      skipped_incident_replay_missing_bad_version: skippedIncidentReplay,
      counts: {
        by_split: countBy(selectedCases, (record) => record.split),
        by_severity: countBy(selectedCases, (record) => record.severity),
        by_primary_cwe: countBy(selectedCases, (record) => record.cwes?.[0] ?? "unknown_cwe")
      }
    },
    cases: [...manualCases, ...selectedCases]
  };

  const summary = {
    input_path: inputPath,
    output_path: outputPath,
    eligible_cve_cases_after_package_dedupe: eligible.length,
    selected_scraped_cases: selectedCases.length,
    preserved_manual_cases: manualCases.length,
    total_manifest_cases: manifest.cases.length,
    skipped_incident_replay_missing_bad_version: skippedIncidentReplay,
    by_split: manifest.selection.counts.by_split,
    by_severity: manifest.selection.counts.by_severity,
    top_primary_cwes: Object.fromEntries(Object.entries(manifest.selection.counts.by_primary_cwe).slice(0, 12)),
    dry_run: args.dryRun
  };

  if (!args.dryRun) {
    await mkdir(dirname(outputPath), { recursive: true });
    await writeFile(outputPath, `${JSON.stringify(manifest, null, 2)}\n`);
  }

  console.log(JSON.stringify(summary, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
