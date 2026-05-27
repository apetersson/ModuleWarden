#!/usr/bin/env node

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

const DEFAULT_CONFIG = "finetune/corpus/scrape-config.json";

function usage() {
  return `Usage: node finetune/scripts/scrape-cases.mjs [options]

Options:
  --config <path>       Config JSON path. Default: ${DEFAULT_CONFIG}
  --output <path>       Override JSONL output path.
  --limit <n>           Maximum normalized cases to write.
  --max-pages <n>       Override GitHub pages per type/severity query.
  --dry-run             Fetch and summarize without writing output.
  --help                Show this help.

Environment:
  GITHUB_TOKEN          Optional token for GitHub advisory API rate limits.
`;
}

function parseArgs(argv) {
  const args = {
    config: DEFAULT_CONFIG,
    output: null,
    limit: null,
    maxPages: null,
    dryRun: false
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--help") {
      args.help = true;
    } else if (arg === "--dry-run") {
      args.dryRun = true;
    } else if (arg === "--config") {
      args.config = argv[++i];
    } else if (arg === "--output") {
      args.output = argv[++i];
    } else if (arg === "--limit") {
      args.limit = Number(argv[++i]);
    } else if (arg === "--max-pages") {
      args.maxPages = Number(argv[++i]);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return args;
}

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

async function fetchJson(url, options = {}) {
  const response = await fetch(url, options);
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`HTTP ${response.status} for ${url}: ${text.slice(0, 500)}`);
  }
  return {
    body: await response.json(),
    headers: response.headers
  };
}

function parseNextLink(linkHeader) {
  if (!linkHeader) return null;
  for (const part of linkHeader.split(",")) {
    const [rawUrl, rawRel] = part.split(";").map((value) => value.trim());
    if (rawRel === 'rel="next"') {
      return rawUrl.slice(1, -1);
    }
  }
  return null;
}

function githubHeaders() {
  const headers = {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2026-03-10",
    "User-Agent": "ModuleWarden-finetune-scraper"
  };
  if (process.env.GITHUB_TOKEN) {
    headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  }
  return headers;
}

async function fetchGithubAdvisories(config, args) {
  if (!config.github_advisories?.enabled) return [];

  const advisoryConfig = config.github_advisories;
  const maxPages = args.maxPages ?? advisoryConfig.max_pages_per_query ?? 1;
  const results = [];

  for (const type of advisoryConfig.types ?? ["reviewed"]) {
    for (const severity of advisoryConfig.severities ?? [null]) {
      let url = new URL(advisoryConfig.api_url);
      url.searchParams.set("ecosystem", advisoryConfig.ecosystem ?? "npm");
      url.searchParams.set("type", type);
      url.searchParams.set("per_page", String(advisoryConfig.per_page ?? 100));
      url.searchParams.set("sort", "updated");
      url.searchParams.set("direction", "desc");
      if (severity) url.searchParams.set("severity", severity);
      if (advisoryConfig.published) url.searchParams.set("published", advisoryConfig.published);
      if (advisoryConfig.updated) url.searchParams.set("updated", advisoryConfig.updated);

      for (let page = 0; page < maxPages && url; page += 1) {
        const { body, headers } = await fetchJson(url, { headers: githubHeaders() });
        results.push(...body);
        const next = parseNextLink(headers.get("link"));
        url = next ? new URL(next) : null;
      }
    }
  }

  return dedupeBy(results, (advisory) => advisory.ghsa_id ?? advisory.url);
}

function advisoryIds(advisory) {
  const ids = new Set();
  if (advisory.ghsa_id) ids.add(advisory.ghsa_id);
  if (advisory.cve_id) ids.add(advisory.cve_id);
  for (const identifier of advisory.identifiers ?? []) {
    if (identifier.value) ids.add(identifier.value);
  }
  return [...ids];
}

function advisoryCwes(advisory) {
  return (advisory.cwes ?? [])
    .map((cwe) => cwe.cwe_id)
    .filter(Boolean);
}

function packageToCaseId(advisory, packageName, vulnerabilityIndex) {
  const base = advisory.ghsa_id ?? advisory.cve_id ?? `advisory_${advisory.id}`;
  return [
    "ghsa",
    base,
    packageName.replace(/[^a-zA-Z0-9]+/g, "_"),
    String(vulnerabilityIndex)
  ]
    .join("_")
    .replace(/_+/g, "_")
    .replace(/^_|_$/g, "");
}

function encodeNpmPackageName(packageName) {
  return encodeURIComponent(packageName);
}

async function fetchPackument(registryUrl, packageName) {
  const url = `${registryUrl.replace(/\/$/, "")}/${encodeNpmPackageName(packageName)}`;
  try {
    const { body } = await fetchJson(url, {
      headers: {
        Accept: "application/json",
        "User-Agent": "ModuleWarden-finetune-scraper"
      }
    });
    return body;
  } catch (error) {
    return {
      error: String(error)
    };
  }
}

function semverKey(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:[-+](.*))?$/.exec(version);
  if (!match) return null;
  return [
    Number(match[1]),
    Number(match[2]),
    Number(match[3]),
    match[4] ?? ""
  ];
}

function compareVersions(a, b) {
  const ak = semverKey(a);
  const bk = semverKey(b);
  if (!ak && !bk) return a.localeCompare(b);
  if (!ak) return -1;
  if (!bk) return 1;
  for (let i = 0; i < 3; i += 1) {
    if (ak[i] !== bk[i]) return ak[i] - bk[i];
  }
  return String(ak[3]).localeCompare(String(bk[3]));
}

function versionPublishedAt(packument, version) {
  return packument?.time?.[version] ?? null;
}

function inferVersions(packument, firstPatchedVersion) {
  if (!packument?.versions || !firstPatchedVersion) {
    return {
      candidate_versions: [],
      benign_neighbor_versions: []
    };
  }

  const versions = Object.keys(packument.versions).sort(compareVersions);
  const patchedIndex = versions.indexOf(firstPatchedVersion);
  if (patchedIndex === -1) {
    return {
      candidate_versions: [
        {
          role: "first_patched",
          version: firstPatchedVersion,
          published_at: null
        }
      ],
      benign_neighbor_versions: []
    };
  }

  const likelyAffected = versions[patchedIndex - 1] ?? null;
  const benignBefore = versions[patchedIndex - 2] ?? null;
  const benignAfter = versions[patchedIndex + 1] ?? null;

  return {
    candidate_versions: [
      likelyAffected
        ? {
            role: "likely_affected",
            version: likelyAffected,
            published_at: versionPublishedAt(packument, likelyAffected)
          }
        : null,
      {
        role: "first_patched",
        version: firstPatchedVersion,
        published_at: versionPublishedAt(packument, firstPatchedVersion)
      }
    ].filter(Boolean),
    benign_neighbor_versions: [
      benignBefore
        ? {
            role: "benign_before",
            version: benignBefore,
            published_at: versionPublishedAt(packument, benignBefore)
          }
        : null,
      benignAfter
        ? {
            role: "benign_after",
            version: benignAfter,
            published_at: versionPublishedAt(packument, benignAfter)
          }
        : null
    ].filter(Boolean)
  };
}

async function fetchOsvIds(config, packageName, version) {
  if (!config.osv?.enabled) return [];
  const payload = {
    package: {
      ecosystem: config.osv.ecosystem ?? "npm",
      name: packageName
    }
  };
  if (version) payload.version = version;

  try {
    const { body } = await fetchJson(`${config.osv.api_url.replace(/\/$/, "")}/v1/query`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "User-Agent": "ModuleWarden-finetune-scraper"
      },
      body: JSON.stringify(payload)
    });
    return (body.vulns ?? []).map((vuln) => vuln.id).filter(Boolean);
  } catch {
    return [];
  }
}

function packumentSummary(packument) {
  if (!packument || packument.error) {
    return {
      error: packument?.error ?? "not_fetched"
    };
  }

  return {
    latest: packument["dist-tags"]?.latest ?? null,
    version_count: packument.versions ? Object.keys(packument.versions).length : 0,
    repository: packument.repository ?? null,
    maintainers: packument.maintainers ?? [],
    time_created: packument.time?.created ?? null,
    time_modified: packument.time?.modified ?? null
  };
}

async function normalizeGithubAdvisory(config, advisory, vulnerability, vulnerabilityIndex) {
  const packageName = vulnerability.package?.name;
  const firstPatchedVersion = vulnerability.first_patched_version ?? null;
  const packument = config.npm_registry?.enabled
    ? await fetchPackument(config.npm_registry.registry_url, packageName)
    : null;
  const inferred = inferVersions(packument, firstPatchedVersion);
  const osvVersion = inferred.candidate_versions.find((candidate) => candidate.role === "likely_affected")
    ?.version;
  const osvIds = await fetchOsvIds(config, packageName, osvVersion);
  const needsEnrichment =
    inferred.candidate_versions.length === 0 || !firstPatchedVersion || Boolean(packument?.error);

  return {
    schema_version: "modulewarden.scraped_case.v1",
    case_id: packageToCaseId(advisory, packageName, vulnerabilityIndex),
    source: "github_advisory",
    case_type: advisory.type === "malware" ? "incident_replay" : "cve_diff",
    package: packageName,
    advisory_ids: advisoryIds(advisory),
    severity: advisory.severity ?? null,
    summary: advisory.summary ?? null,
    cwes: advisoryCwes(advisory),
    affected_range: vulnerability.vulnerable_version_range ?? null,
    first_patched_version: firstPatchedVersion,
    candidate_versions: inferred.candidate_versions,
    benign_neighbor_versions: inferred.benign_neighbor_versions,
    references: advisory.references ?? [],
    source_code_location: advisory.source_code_location ?? null,
    npm: packumentSummary(packument),
    osv_ids: osvIds,
    triage_status: needsEnrichment ? "needs_enrichment" : "candidate",
    scraped_at: new Date().toISOString()
  };
}

async function normalizeGithubAdvisories(config, advisories, limit) {
  const cases = [];
  for (const advisory of advisories) {
    const vulnerabilities = advisory.vulnerabilities ?? [];
    for (let index = 0; index < vulnerabilities.length; index += 1) {
      const vulnerability = vulnerabilities[index];
      if (vulnerability.package?.ecosystem !== "npm") continue;
      if (!vulnerability.package?.name) continue;
      cases.push(await normalizeGithubAdvisory(config, advisory, vulnerability, index));
      if (limit && cases.length >= limit) return cases;
    }
  }
  return cases;
}

function dedupeBy(items, keyFn) {
  const seen = new Set();
  const deduped = [];
  for (const item of items) {
    const key = keyFn(item);
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(item);
  }
  return deduped;
}

async function writeJsonl(path, records) {
  await mkdir(dirname(path), { recursive: true });
  const text = records.map((record) => JSON.stringify(record)).join("\n");
  await writeFile(path, text ? `${text}\n` : "");
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(usage());
    return;
  }

  const configPath = resolve(args.config);
  const config = await readJson(configPath);
  const outputPath = resolve(args.output ?? config.output_path);

  const advisories = await fetchGithubAdvisories(config, args);
  const cases = await normalizeGithubAdvisories(config, advisories, args.limit);

  const byType = cases.reduce((acc, item) => {
    acc[item.case_type] = (acc[item.case_type] ?? 0) + 1;
    return acc;
  }, {});

  if (!args.dryRun) {
    await writeJsonl(outputPath, cases);
  }

  console.log(
    JSON.stringify(
      {
        advisories: advisories.length,
        cases: cases.length,
        by_type: byType,
        output_path: args.dryRun ? null : outputPath,
        dry_run: args.dryRun
      },
      null,
      2
    )
  );
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
