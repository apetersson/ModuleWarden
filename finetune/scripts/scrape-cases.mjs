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
  --concurrency <n>     Concurrent enrichment requests. Default: 8.
  --timeout-ms <n>      Per-request timeout. Default: 30000.
  --github-only         Fetch GitHub advisories without npm or OSV enrichment.
  --skip-npm            Skip npm packument enrichment.
  --skip-osv            Skip OSV enrichment.
  --stop-on-rate-limit  Fail instead of continuing with partial results on GitHub rate limits.
  --quiet               Disable progress output.
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
    concurrency: 8,
    timeoutMs: 30000,
    githubOnly: false,
    skipNpm: false,
    skipOsv: false,
    stopOnRateLimit: false,
    quiet: false,
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
    } else if (arg === "--concurrency") {
      args.concurrency = Number(argv[++i]);
    } else if (arg === "--timeout-ms") {
      args.timeoutMs = Number(argv[++i]);
    } else if (arg === "--github-only") {
      args.githubOnly = true;
    } else if (arg === "--skip-npm") {
      args.skipNpm = true;
    } else if (arg === "--skip-osv") {
      args.skipOsv = true;
    } else if (arg === "--stop-on-rate-limit") {
      args.stopOnRateLimit = true;
    } else if (arg === "--quiet") {
      args.quiet = true;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return args;
}

function progress(args, message) {
  if (!args.quiet) {
    console.error(`[scrape] ${message}`);
  }
}

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

class HttpError extends Error {
  constructor(status, url, body, headers) {
    super(`HTTP ${status} for ${url}: ${body.slice(0, 500)}`);
    this.name = "HttpError";
    this.status = status;
    this.url = String(url);
    this.body = body;
    this.headers = headers;
  }
}

async function fetchJson(url, options = {}) {
  const { timeoutMs = 30000, ...fetchOptions } = options;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let response;
  try {
    response = await fetch(url, {
      ...fetchOptions,
      signal: controller.signal
    });
  } finally {
    clearTimeout(timer);
  }

  if (!response.ok) {
    const text = await response.text();
    throw new HttpError(response.status, url, text, response.headers);
  }
  return {
    body: await response.json(),
    headers: response.headers
  };
}

function isGithubRateLimitError(error) {
  return (
    error instanceof HttpError &&
    error.status === 403 &&
    /rate limit/i.test(error.body ?? "")
  );
}

function githubRateLimitHint(error) {
  const reset = error.headers?.get("x-ratelimit-reset");
  const remaining = error.headers?.get("x-ratelimit-remaining");
  const resetAt = reset ? new Date(Number(reset) * 1000).toISOString() : null;
  const parts = [];
  if (remaining != null) parts.push(`remaining=${remaining}`);
  if (resetAt) parts.push(`reset=${resetAt}`);
  parts.push("set GITHUB_TOKEN for a higher rate limit");
  return parts.join("; ");
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

  function finishResults(reason) {
    const deduped = dedupeBy(results, (advisory) => advisory.ghsa_id ?? advisory.url);
    if (reason) progress(args, reason);
    progress(args, `deduped GitHub advisories: ${results.length} -> ${deduped.length}`);
    return deduped;
  }

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
        progress(args, `fetching GitHub advisories type=${type} severity=${severity ?? "any"} page=${page + 1}/${maxPages}`);
        let body;
        let headers;
        try {
          const response = await fetchJson(url, {
            headers: githubHeaders(),
            timeoutMs: args.timeoutMs
          });
          body = response.body;
          headers = response.headers;
        } catch (error) {
          if (isGithubRateLimitError(error) && !args.stopOnRateLimit) {
            return finishResults(
              `GitHub rate limit hit after ${results.length} advisories; continuing with partial results (${githubRateLimitHint(error)})`
            );
          }
          throw error;
        }
        results.push(...body);
        progress(args, `received ${body.length} advisories; total fetched=${results.length}`);
        const remaining = headers.get("x-ratelimit-remaining");
        if (remaining != null && Number(remaining) <= 5) {
          progress(args, `GitHub rate limit nearly exhausted; ${githubRateLimitHint({ headers, body: "rate limit" })}`);
        }
        const next = parseNextLink(headers.get("link"));
        url = next ? new URL(next) : null;
      }
    }
  }

  return finishResults();
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

async function fetchPackument(registryUrl, packageName, args) {
  const url = `${registryUrl.replace(/\/$/, "")}/${encodeNpmPackageName(packageName)}`;
  try {
    const { body } = await fetchJson(url, {
      headers: {
        Accept: "application/json",
        "User-Agent": "ModuleWarden-finetune-scraper"
      },
      timeoutMs: args.timeoutMs
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

async function fetchOsvIds(config, packageName, version, args) {
  if (!config.osv?.enabled || args.skipOsv || args.githubOnly) return [];
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
      timeoutMs: args.timeoutMs,
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

async function normalizeGithubAdvisory(config, advisory, vulnerability, vulnerabilityIndex, args) {
  const packageName = vulnerability.package?.name;
  const firstPatchedVersion = vulnerability.first_patched_version ?? null;
  const packument = config.npm_registry?.enabled && !args.skipNpm && !args.githubOnly
    ? await fetchPackument(config.npm_registry.registry_url, packageName, args)
    : null;
  const inferred = inferVersions(packument, firstPatchedVersion);
  const osvVersion = inferred.candidate_versions.find((candidate) => candidate.role === "likely_affected")
    ?.version;
  const osvIds = await fetchOsvIds(config, packageName, osvVersion, args);
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

async function normalizeGithubAdvisories(config, advisories, args) {
  const workItems = [];
  for (const advisory of advisories) {
    const vulnerabilities = advisory.vulnerabilities ?? [];
    for (let index = 0; index < vulnerabilities.length; index += 1) {
      const vulnerability = vulnerabilities[index];
      if (vulnerability.package?.ecosystem !== "npm") continue;
      if (!vulnerability.package?.name) continue;
      workItems.push({ advisory, vulnerability, index });
      if (args.limit && workItems.length >= args.limit) break;
    }
    if (args.limit && workItems.length >= args.limit) break;
  }

  progress(args, `normalizing ${workItems.length} npm vulnerability records with concurrency=${args.concurrency}`);

  let completed = 0;
  const cases = await mapLimit(workItems, args.concurrency, async (item) => {
    const normalized = await normalizeGithubAdvisory(
      config,
      item.advisory,
      item.vulnerability,
      item.index,
      args
    );
    completed += 1;
    if (completed === 1 || completed % 25 === 0 || completed === workItems.length) {
      progress(args, `normalized ${completed}/${workItems.length} cases`);
    }
    return normalized;
  });

  return cases;
}

async function mapLimit(items, concurrency, mapper) {
  const safeConcurrency = Math.max(1, Math.min(Number(concurrency) || 1, items.length || 1));
  const results = new Array(items.length);
  let nextIndex = 0;

  async function worker() {
    while (nextIndex < items.length) {
      const currentIndex = nextIndex;
      nextIndex += 1;
      results[currentIndex] = await mapper(items[currentIndex], currentIndex);
    }
  }

  await Promise.all(Array.from({ length: safeConcurrency }, () => worker()));
  return results;
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

  if (args.githubOnly) {
    args.skipNpm = true;
    args.skipOsv = true;
  }

  const advisories = await fetchGithubAdvisories(config, args);
  const cases = await normalizeGithubAdvisories(config, advisories, args);

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
