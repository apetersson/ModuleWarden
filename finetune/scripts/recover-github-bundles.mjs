#!/usr/bin/env node

import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, open, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

const DEFAULT_SCRAPED_CASES = process.env.FT_DATA
  ? join(process.env.FT_DATA, "scraped-cases-overnight.jsonl")
  : "/Users/andreas/nextcloud-classic/ZeroToOne_Data/finetune-data/scraped-cases-overnight.jsonl";
const DEFAULT_OUTPUT_ROOT = process.env.FT_DATA
  ? join(process.env.FT_DATA, "raw-bundles")
  : "/Users/andreas/nextcloud-classic/ZeroToOne_Data/finetune-data/raw-bundles";
const DEFAULT_CONCURRENCY = 4;
const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_PROGRESS_EVERY = 10;
const MAX_RETRIES = 5;

function usage() {
  return `Usage: node finetune/scripts/recover-github-bundles.mjs [options]

Recovery pass for npm-redacted/unavailable package cases. It reads
raw-bundles/cases-index.jsonl, selects rows with npm packument 404/405, and
tries to recover source archives from GitHub repos referenced by the scraped
advisory record.

Recovered files stay in the same two buckets, but use a .github.tgz suffix:
  raw-bundles/vulnerable/<package>/<version>.github.tgz
  raw-bundles/benign/<package>/<version>.github.tgz

These are NOT exact npm tarballs. Manifests mark provenance/confidence so they
can be trained differently from exact npm-published artifacts.

Options:
  --scraped-cases <path>       Scraped-case JSONL. Default: ${DEFAULT_SCRAPED_CASES}
  --cases-index <path>         cases-index.jsonl. Default: <output-root>/cases-index.jsonl
  --output-root <path>         Raw bundle root. Default: ${DEFAULT_OUTPUT_ROOT}
  --concurrency <n>            Concurrent GitHub archive downloads. Default: ${DEFAULT_CONCURRENCY}
  --timeout-ms <n>             HTTP timeout. Default: ${DEFAULT_TIMEOUT_MS}
  --progress-every <n>         Log progress every n items. Default: ${DEFAULT_PROGRESS_EVERY}
  --limit <n>                  Only plan/download first n recovery artifacts.
  --dry-run                    Plan only; do not write/download.
  --force                      Re-download existing recovered archives.
  --recover-default-branch     If no version tag matches, archive default branch as low-confidence fallback.
  --include-version-missing    Also create low-confidence default-branch candidates for rows lacking a version.
  --help                       Show this help.

Rate limiting: honors Retry-After, GitHub x-ratelimit-reset, 429, transient
5xx, and GitHub 403 primary/secondary rate-limit responses. Uses GITHUB_TOKEN
for GitHub URLs when present without printing it.
`;
}

function parseArgs(argv) {
  const args = {
    scrapedCases: DEFAULT_SCRAPED_CASES,
    outputRoot: DEFAULT_OUTPUT_ROOT,
    casesIndex: null,
    concurrency: DEFAULT_CONCURRENCY,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    progressEvery: DEFAULT_PROGRESS_EVERY,
    limit: null,
    dryRun: false,
    force: false,
    recoverDefaultBranch: false,
    includeVersionMissing: false,
    help: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--help") args.help = true;
    else if (arg === "--scraped-cases") args.scrapedCases = argv[++i];
    else if (arg === "--cases-index") args.casesIndex = argv[++i];
    else if (arg === "--output-root") args.outputRoot = argv[++i];
    else if (arg === "--concurrency") args.concurrency = Number(argv[++i]);
    else if (arg === "--timeout-ms") args.timeoutMs = Number(argv[++i]);
    else if (arg === "--progress-every") args.progressEvery = Number(argv[++i]);
    else if (arg === "--limit") args.limit = Number(argv[++i]);
    else if (arg === "--dry-run") args.dryRun = true;
    else if (arg === "--force") args.force = true;
    else if (arg === "--recover-default-branch") args.recoverDefaultBranch = true;
    else if (arg === "--include-version-missing") args.includeVersionMissing = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  for (const [name, value] of [
    ["--concurrency", args.concurrency],
    ["--timeout-ms", args.timeoutMs],
    ["--progress-every", args.progressEvery],
  ]) {
    if (!Number.isInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer`);
  }
  if (args.limit != null && (!Number.isInteger(args.limit) || args.limit <= 0)) {
    throw new Error("--limit must be a positive integer");
  }
  args.scrapedCases = resolve(args.scrapedCases);
  args.outputRoot = resolve(args.outputRoot);
  args.casesIndex = resolve(args.casesIndex ?? join(args.outputRoot, "cases-index.jsonl"));
  return args;
}

function nowIso() {
  return new Date().toISOString();
}

function log(message) {
  console.error(`${nowIso()} ${message}`);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function formatError(error) {
  if (error && typeof error === "object" && "stack" in error && error.stack) return error.stack;
  if (error && typeof error === "object" && "message" in error && error.message) return error.message;
  return String(error);
}

process.on("unhandledRejection", (error) => log(`[github-recovery] unhandledRejection: ${formatError(error)}`));
process.on("uncaughtException", (error) => {
  log(`[github-recovery] uncaughtException: ${formatError(error)}`);
  process.exitCode = 1;
});

async function readJsonl(path) {
  const text = await readFile(path, "utf8");
  const rows = [];
  text.split(/\r?\n/).forEach((line, index) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    try {
      rows.push(JSON.parse(trimmed));
    } catch (error) {
      throw new Error(`Invalid JSONL at ${path}:${index + 1}: ${error.message}`);
    }
  });
  return rows;
}

function roleVersion(record, role) {
  const candidates = Array.isArray(record?.candidate_versions) ? record.candidate_versions : [];
  return candidates.find((candidate) => candidate?.role === role && typeof candidate.version === "string")?.version ?? null;
}

function exactVersionFromRange(range) {
  if (typeof range !== "string") return null;
  const trimmed = range.trim();
  const exact = /^=?\s*v?(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)$/.exec(trimmed);
  return exact?.[1] ?? null;
}

function packagePathSegments(packageName) {
  return String(packageName || "unknown")
    .split("/")
    .filter(Boolean)
    .map((part) => part.replace(/[^A-Za-z0-9@._-]/g, "_"));
}

function safeFilePart(value) {
  return String(value || "unknown").replace(/[^A-Za-z0-9._+-]/g, "_");
}

function recoveredPath(outputRoot, bucket, packageName, version, sourceKind) {
  const suffix = sourceKind === "github_default_branch" ? "github-default" : "github";
  return join(outputRoot, bucket, ...packagePathSegments(packageName), `${safeFilePart(version)}.${suffix}.tgz`);
}

function parseGithubRepo(value) {
  if (typeof value !== "string" || !value.trim()) return null;
  let s = value.trim().replace(/^git\+/, "");
  const ssh = /^git@github\.com:([^/]+)\/([^#]+?)(?:\.git)?(?:[#?].*)?$/.exec(s);
  if (ssh) return { owner: ssh[1], repo: ssh[2].replace(/\.git$/, "") };
  try {
    const url = new URL(s);
    if (!/(^|\.)github\.com$/i.test(url.hostname)) return null;
    const parts = url.pathname.split("/").filter(Boolean);
    if (parts.length < 2) return null;
    if (parts[0].toLowerCase() === "advisories") return null;
    if (parts[2]?.toLowerCase() === "security" && parts[3]?.toLowerCase() === "advisories") return null;
    const owner = parts[0];
    const repo = parts[1].replace(/\.git$/, "");
    if (!owner || !repo) return null;
    return { owner, repo };
  } catch {
    const match = /github\.com[:/]([^/\s]+)\/([^/\s#?]+)(?:\.git)?/i.exec(s);
    if (!match) return null;
    return { owner: match[1], repo: match[2].replace(/\.git$/, "") };
  }
}

function repoKey(repo) {
  return `${repo.owner.toLowerCase()}/${repo.repo.toLowerCase()}`;
}

function githubReposFor(scraped, caseRow) {
  const out = [];
  const seen = new Set();
  const sources = [caseRow.source_code_location, scraped?.source_code_location, scraped?.npm?.repository?.url, ...(scraped?.references ?? [])];
  for (const source of sources) {
    const repo = parseGithubRepo(source);
    if (!repo) continue;
    const key = repoKey(repo);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ ...repo, source_url: source });
  }
  return out;
}

function candidateRefs(packageName, version) {
  if (!version) return [];
  const base = String(packageName || "").split("/").pop() || String(packageName || "package");
  const candidates = [
    version,
    `v${version}`,
    `${packageName}@${version}`,
    `${base}@${version}`,
    `release-${version}`,
    `v.${version}`,
  ];
  return [...new Set(candidates.filter(Boolean))];
}

function normalizeTag(tag) {
  return String(tag || "").toLowerCase().replace(/^refs\/tags\//, "");
}

function findMatchingTag(tags, packageName, version) {
  const candidates = candidateRefs(packageName, version);
  for (const candidate of candidates) {
    const exact = tags.find((tag) => tag.name === candidate);
    if (exact) return { ref: exact.name, match: "exact_candidate" };
  }
  const normalizedTags = tags.map((tag) => ({ tag, normalized: normalizeTag(tag.name) }));
  for (const candidate of candidates) {
    const normalized = normalizeTag(candidate);
    const found = normalizedTags.find((item) => item.normalized === normalized);
    if (found) return { ref: found.tag.name, match: "case_insensitive_candidate" };
  }
  // Last resort: a tag ending in /v1.2.3 or /1.2.3 in monorepos.
  for (const item of normalizedTags) {
    if (item.normalized.endsWith(`/${version}`) || item.normalized.endsWith(`/v${version}`)) {
      return { ref: item.tag.name, match: "monorepo_suffix" };
    }
  }
  return null;
}

function isGithubUrl(url) {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return host === "api.github.com" || host === "github.com" || host.endsWith(".github.com");
  } catch {
    return false;
  }
}

function retryAfterMs(headerValue) {
  if (!headerValue) return null;
  const seconds = Number(headerValue);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const dateMs = Date.parse(headerValue);
  if (Number.isFinite(dateMs)) return Math.max(0, dateMs - Date.now());
  return null;
}

function githubResetWaitMs(response) {
  const remaining = response.headers.get("x-ratelimit-remaining");
  const reset = Number(response.headers.get("x-ratelimit-reset"));
  if (remaining === "0" && Number.isFinite(reset) && reset > 0) return Math.max(0, reset * 1000 - Date.now() + 2_000);
  return null;
}

let githubNextRequestAtMs = 0;

async function waitForGithubWindow(url) {
  if (!isGithubUrl(url)) return;
  const waitMs = githubNextRequestAtMs - Date.now();
  if (waitMs > 0) {
    log(`[github-recovery] GitHub rate-limit window active; waiting ${Math.ceil(waitMs / 1000)}s`);
    await sleep(waitMs);
  }
}

function rememberGithubWindow(url, response) {
  if (!isGithubUrl(url)) return;
  const waitMs = githubResetWaitMs(response);
  if (waitMs != null) githubNextRequestAtMs = Math.max(githubNextRequestAtMs, Date.now() + waitMs);
}

function requestHeadersForUrl(url, headers = {}) {
  const out = { ...headers };
  const hasAuth = Object.keys(out).some((key) => key.toLowerCase() === "authorization");
  if (isGithubUrl(url) && process.env.GITHUB_TOKEN && !hasAuth) {
    out.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
    out["X-GitHub-Api-Version"] = out["X-GitHub-Api-Version"] ?? "2022-11-28";
  }
  return out;
}

function shouldRetryStatus(url, response) {
  if (response.status === 429 || response.status >= 500) return true;
  if (response.status === 403 && isGithubUrl(url)) return response.headers.get("x-ratelimit-remaining") === "0" || response.headers.has("retry-after");
  return false;
}

function retryDelayMs(url, response, fallbackMs) {
  const retryAfter = retryAfterMs(response.headers.get("retry-after"));
  if (retryAfter != null) return retryAfter;
  if (isGithubUrl(url)) {
    const resetWait = githubResetWaitMs(response);
    if (resetWait != null) return resetWait;
  }
  return fallbackMs;
}

async function fetchWithRetry(url, { headers = {}, timeoutMs, okStatuses = null } = {}) {
  let backoffMs = 1_000;
  let lastError = null;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt += 1) {
    await waitForGithubWindow(url);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(url, { headers: requestHeadersForUrl(url, headers), signal: controller.signal });
      clearTimeout(timeout);
      rememberGithubWindow(url, response);
      const acceptable = okStatuses ? okStatuses.includes(response.status) : response.status >= 200 && response.status < 300;
      if (acceptable) return response;
      if (shouldRetryStatus(url, response)) {
        const waitMs = retryDelayMs(url, response, backoffMs);
        await response.arrayBuffer().catch(() => null);
        if (attempt < MAX_RETRIES) {
          log(`[github-recovery] ${new URL(url).hostname} returned HTTP ${response.status}; backing off ${Math.ceil(waitMs / 1000)}s before retry ${attempt + 1}/${MAX_RETRIES}`);
          await sleep(waitMs);
          backoffMs *= 2;
          continue;
        }
      }
      const body = await response.text().catch(() => "");
      throw new Error(`HTTP ${response.status} ${response.statusText}${body ? `: ${body.slice(0, 300)}` : ""}`);
    } catch (error) {
      clearTimeout(timeout);
      lastError = error;
      if (attempt < MAX_RETRIES) {
        await sleep(backoffMs);
        backoffMs *= 2;
        continue;
      }
    }
  }
  throw lastError ?? new Error(`fetch failed for ${url}`);
}

async function fetchJson(url, timeoutMs) {
  const response = await fetchWithRetry(url, { headers: { Accept: "application/vnd.github+json" }, timeoutMs });
  return response.json();
}

async function fetchRepoTags(repo, args, cache) {
  const key = repoKey(repo);
  if (cache.has(key)) return cache.get(key);
  const promise = (async () => {
    const tags = [];
    for (let page = 1; page <= 5; page += 1) {
      const url = `https://api.github.com/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.repo)}/tags?per_page=100&page=${page}`;
      const batch = await fetchJson(url, args.timeoutMs);
      if (!Array.isArray(batch)) throw new Error(`GitHub tags response was not an array for ${key}`);
      tags.push(...batch);
      if (batch.length < 100) break;
    }
    return tags;
  })().catch((error) => ({ __error: error }));
  cache.set(key, promise);
  return promise;
}

async function fetchRepoInfo(repo, args, cache) {
  const key = repoKey(repo);
  if (cache.has(key)) return cache.get(key);
  const promise = fetchJson(`https://api.github.com/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.repo)}`, args.timeoutMs)
    .catch((error) => ({ __error: error }));
  cache.set(key, promise);
  return promise;
}

async function fileSha256(path) {
  return new Promise((resolve, reject) => {
    const h = createHash("sha256");
    const s = createReadStream(path);
    s.on("data", (chunk) => h.update(chunk));
    s.on("error", reject);
    s.on("end", () => resolve(h.digest("hex")));
  });
}

async function appendJsonl(path, row) {
  await mkdir(dirname(path), { recursive: true });
  const fh = await open(path, "a");
  try {
    await fh.write(`${JSON.stringify(row)}\n`);
  } finally {
    await fh.close();
  }
}

async function writeJsonl(path, rows) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, rows.map((row) => JSON.stringify(row)).join("\n") + (rows.length ? "\n" : ""), "utf8");
}

async function validateExisting(path) {
  try {
    const s = await stat(path);
    if (!s.isFile() || s.size <= 0) return null;
    return { bytes: s.size, sha256: await fileSha256(path) };
  } catch {
    return null;
  }
}

async function downloadArchive(task, args, eventsPath) {
  await mkdir(dirname(task.path), { recursive: true });
  const partialPath = `${task.path}.partial`;
  if (!args.force) {
    const existing = await validateExisting(task.path);
    if (existing) {
      const row = { ...task, status: "existing", timestamp: nowIso(), bytes: existing.bytes, sha256: existing.sha256 };
      await appendJsonl(eventsPath, row);
      return row;
    }
  }
  await rm(partialPath, { force: true });
  const response = await fetchWithRetry(task.url, { timeoutMs: args.timeoutMs });
  if (!response.body) throw new Error("empty response body");
  await pipeline(Readable.fromWeb(response.body), createWriteStream(partialPath, { flags: "w" }));
  const valid = await validateExisting(partialPath);
  if (!valid) {
    await rm(partialPath, { force: true });
    throw new Error("downloaded GitHub archive was empty or missing");
  }
  await rename(partialPath, task.path);
  const row = { ...task, status: "downloaded", timestamp: nowIso(), bytes: valid.bytes, sha256: valid.sha256 };
  await appendJsonl(eventsPath, row);
  return row;
}

async function workerPool(items, concurrency, fn) {
  const results = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await fn(items[index], index);
    }
  });
  await Promise.all(workers);
  return results;
}

function isPackumentUnavailable(row) {
  return (row.skips ?? []).some((skip) => /^packument_error:HTTP (404|405)\b/.test(skip));
}

function unavailableReason(row) {
  return (row.skips ?? []).find((skip) => skip.startsWith("packument_error:")) ?? "packument_unavailable";
}

function versionSpecs(scraped, caseRow, args) {
  const vulnerable = roleVersion(scraped, "likely_affected") ?? exactVersionFromRange(scraped?.affected_range ?? caseRow.affected_range);
  const benign = roleVersion(scraped, "first_patched") ?? scraped?.first_patched_version ?? caseRow.first_patched_version ?? null;
  const specs = [];
  if (vulnerable) specs.push({ bucket: "vulnerable", role: "likely_affected", version: vulnerable, confidence: "medium" });
  else if (args.includeVersionMissing) specs.push({ bucket: "vulnerable", role: "likely_affected", version: "unknown", confidence: "low", missing_version: true });
  if (benign) specs.push({ bucket: "benign", role: "first_patched", version: benign, confidence: "medium" });
  return specs;
}

async function planRecovery(args) {
  const scrapedRows = await readJsonl(args.scrapedCases);
  const byCaseId = new Map(scrapedRows.map((row) => [String(row.case_id), row]));
  const caseRows = await readJsonl(args.casesIndex);
  const candidates = caseRows.filter(isPackumentUnavailable);
  log(`[github-recovery] loaded ${scrapedRows.length} scraped cases and ${caseRows.length} case-index rows`);
  log(`[github-recovery] npm-unavailable case rows: ${candidates.length}`);

  const tagsCache = new Map();
  const repoInfoCache = new Map();
  const planned = [];
  const skipped = [];
  let processed = 0;

  await workerPool(candidates, args.concurrency, async (caseRow) => {
    const scraped = byCaseId.get(String(caseRow.case_id));
    const repos = githubReposFor(scraped, caseRow);
    const specs = versionSpecs(scraped, caseRow, args);
    const reason = unavailableReason(caseRow);
    if (!scraped) skipped.push({ case_id: caseRow.case_id, package: caseRow.package, reason: "scraped_case_missing", original_reason: reason });
    if (!repos.length) skipped.push({ case_id: caseRow.case_id, package: caseRow.package, reason: "no_github_repo", original_reason: reason });
    if (!specs.length) skipped.push({ case_id: caseRow.case_id, package: caseRow.package, reason: "no_recoverable_version", original_reason: reason });

    for (const spec of specs) {
      let recovered = false;
      for (const repo of repos) {
        let match = null;
        if (!spec.missing_version) {
          const tags = await fetchRepoTags(repo, args, tagsCache);
          if (tags?.__error) {
            skipped.push({ case_id: caseRow.case_id, package: caseRow.package, bucket: spec.bucket, version: spec.version, repo: repoKey(repo), reason: "github_tags_error", error: tags.__error.message, original_reason: reason });
            continue;
          }
          match = findMatchingTag(tags, caseRow.package, spec.version);
        }
        if (match) {
          const task = {
            schema_version: "modulewarden.github_recovery_artifact.v1",
            artifact_source: "github_tag_archive",
            artifact_confidence: spec.confidence,
            exact_npm_tarball: false,
            bucket: spec.bucket,
            role: spec.role,
            package: caseRow.package,
            version: spec.version,
            repo: repoKey(repo),
            repo_source_url: repo.source_url,
            ref: match.ref,
            ref_match: match.match,
            url: `https://api.github.com/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.repo)}/tarball/${encodeURIComponent(match.ref)}`,
            path: recoveredPath(args.outputRoot, spec.bucket, caseRow.package, spec.version, "github_tag_archive"),
            case_id: caseRow.case_id,
            advisory_ids: caseRow.advisory_ids ?? [],
            original_reason: reason,
          };
          planned.push(task);
          recovered = true;
          break;
        }
        if (args.recoverDefaultBranch) {
          const info = await fetchRepoInfo(repo, args, repoInfoCache);
          if (info?.__error) {
            skipped.push({ case_id: caseRow.case_id, package: caseRow.package, bucket: spec.bucket, version: spec.version, repo: repoKey(repo), reason: "github_repo_error", error: info.__error.message, original_reason: reason });
            continue;
          }
          const ref = info.default_branch;
          if (typeof ref === "string" && ref) {
            planned.push({
              schema_version: "modulewarden.github_recovery_artifact.v1",
              artifact_source: "github_default_branch",
              artifact_confidence: "low",
              exact_npm_tarball: false,
              bucket: spec.bucket,
              role: spec.role,
              package: caseRow.package,
              version: spec.version,
              repo: repoKey(repo),
              repo_source_url: repo.source_url,
              ref,
              ref_match: "default_branch_fallback",
              url: `https://api.github.com/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.repo)}/tarball/${encodeURIComponent(ref)}`,
              path: recoveredPath(args.outputRoot, spec.bucket, caseRow.package, spec.version, "github_default_branch"),
              case_id: caseRow.case_id,
              advisory_ids: caseRow.advisory_ids ?? [],
              original_reason: reason,
            });
            recovered = true;
            break;
          }
        }
      }
      if (!recovered && repos.length) {
        skipped.push({ case_id: caseRow.case_id, package: caseRow.package, bucket: spec.bucket, version: spec.version, repos: repos.map(repoKey), reason: "no_matching_github_tag", original_reason: reason });
      }
    }

    processed += 1;
    if (processed === 1 || processed % args.progressEvery === 0 || processed === candidates.length) {
      log(`[github-recovery] planned ${processed}/${candidates.length} unavailable cases; artifacts=${planned.length}; skipped=${skipped.length}`);
    }
  });

  const dedup = new Map();
  for (const task of planned) {
    const key = `${task.bucket}\0${task.package}\0${task.version}\0${task.repo}\0${task.ref}`;
    if (!dedup.has(key)) dedup.set(key, task);
  }
  let tasks = [...dedup.values()].sort((a, b) => a.bucket.localeCompare(b.bucket) || a.package.localeCompare(b.package) || a.version.localeCompare(b.version));
  if (args.limit != null) tasks = tasks.slice(0, args.limit);
  return { tasks, skipped, inputUnavailableCases: candidates.length };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(usage());
    return;
  }
  log(`[github-recovery] scraped cases: ${args.scrapedCases}`);
  log(`[github-recovery] cases index: ${args.casesIndex}`);
  log(`[github-recovery] output root: ${args.outputRoot}`);

  const { tasks, skipped, inputUnavailableCases } = await planRecovery(args);
  const indexPath = join(args.outputRoot, "github-recovery-index.jsonl");
  const skippedPath = join(args.outputRoot, "github-recovery-skipped.jsonl");
  const eventsPath = join(args.outputRoot, "github-recovery-events.jsonl");
  await writeJsonl(indexPath, tasks);
  await writeJsonl(skippedPath, skipped);

  const counts = {
    npm_unavailable_cases: inputUnavailableCases,
    planned_recovery_artifacts: tasks.length,
    skipped_recovery_rows: skipped.length,
    by_bucket: tasks.reduce((acc, task) => {
      acc[task.bucket] = (acc[task.bucket] ?? 0) + 1;
      return acc;
    }, {}),
    by_source: tasks.reduce((acc, task) => {
      acc[task.artifact_source] = (acc[task.artifact_source] ?? 0) + 1;
      return acc;
    }, {}),
  };

  if (args.dryRun) {
    console.log(JSON.stringify({ dry_run: true, output_root: args.outputRoot, counts }, null, 2));
    return;
  }

  const results = [];
  let done = 0;
  log(`[github-recovery] starting ${tasks.length} GitHub recovery downloads with concurrency=${args.concurrency}`);
  await workerPool(tasks, args.concurrency, async (task) => {
    try {
      const row = await downloadArchive(task, args, eventsPath);
      results.push(row);
      done += 1;
      if (done === 1 || done % args.progressEvery === 0 || done === tasks.length) {
        log(`[github-recovery] ${done}/${tasks.length} ${row.status}: ${task.package}@${task.version} ${task.repo}#${task.ref}`);
      }
    } catch (error) {
      const row = { ...task, status: "failed", timestamp: nowIso(), error: error.message };
      await appendJsonl(eventsPath, row);
      results.push(row);
      done += 1;
      log(`[github-recovery] failed ${done}/${tasks.length}: ${task.package}@${task.version} ${task.repo}#${task.ref}: ${error.message}`);
    }
  });

  const bytes = results.reduce((total, row) => total + (Number(row.bytes) || 0), 0);
  const summary = {
    generated_at: nowIso(),
    output_root: args.outputRoot,
    counts,
    download_status: results.reduce((acc, row) => {
      acc[row.status] = (acc[row.status] ?? 0) + 1;
      return acc;
    }, {}),
    downloaded_or_existing_bytes: bytes,
    downloaded_or_existing_gib: Number((bytes / 1024 / 1024 / 1024).toFixed(3)),
  };
  await writeFile(join(args.outputRoot, "github-recovery-summary.json"), `${JSON.stringify(summary, null, 2)}\n`, "utf8");
  console.log(JSON.stringify(summary, null, 2));
}

main().catch((error) => {
  log(`[github-recovery] fatal: ${formatError(error)}`);
  process.exitCode = 1;
});
