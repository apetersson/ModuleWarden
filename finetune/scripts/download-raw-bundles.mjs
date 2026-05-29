#!/usr/bin/env node

import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, open, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

const DEFAULT_INPUT = process.env.FT_DATA
  ? join(process.env.FT_DATA, "scraped-cases-overnight.jsonl")
  : "/Users/andreas/nextcloud-classic/ZeroToOne_Data/finetune-data/scraped-cases-overnight.jsonl";
const DEFAULT_OUTPUT_ROOT = process.env.FT_DATA
  ? join(process.env.FT_DATA, "raw-bundles")
  : "/Users/andreas/nextcloud-classic/ZeroToOne_Data/finetune-data/raw-bundles";

const DEFAULT_REGISTRY = "https://registry.npmjs.org";
const ALLOWED_TARBALL_HOSTS = new Set(["registry.npmjs.org", "registry.yarnpkg.com"]);
const DEFAULT_VULNERABLE_BUCKET = "vulnerable";
const DEFAULT_BENIGN_BUCKET = "benign";
const DEFAULT_CONCURRENCY = 8;
const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_PROGRESS_EVERY = 100;
const HEARTBEAT_MS = 15_000;
const MAX_RETRIES = 5;

function usage() {
  return `Usage: node finetune/scripts/download-raw-bundles.mjs [options]

Downloads exact npm package tarballs for two training-data buckets:
  vulnerable: likely affected / reported-bad versions
  benign:     first patched / fixed versions

The scraped cases themselves come from GitHub advisories, but the versioned
package source bundles are fetched from the npm registry dist.tarball URLs.
This preserves the exact published package source instead of guessing GitHub
tag names.

Options:
  --input <path>              Scraped-case JSONL. Default: ${DEFAULT_INPUT}
  --output-root <path>        Raw bundle root. Default: ${DEFAULT_OUTPUT_ROOT}
  --vulnerable-bucket <name>  Vulnerable bucket dir. Default: ${DEFAULT_VULNERABLE_BUCKET}
  --benign-bucket <name>      Benign bucket dir. Default: ${DEFAULT_BENIGN_BUCKET}
  --registry <url>            npm registry base URL. Default: ${DEFAULT_REGISTRY}
  --concurrency <n>           Concurrent artifact downloads. Default: ${DEFAULT_CONCURRENCY}
  --max-cases <n>             Only read the first n scraped cases.
  --limit-artifacts <n>       Only download/plan the first n unique artifacts.
  --timeout-ms <n>            HTTP request timeout. Default: ${DEFAULT_TIMEOUT_MS}
  --progress-every <n>        Log planning/download progress every n items. Default: ${DEFAULT_PROGRESS_EVERY}
  --dry-run                   Resolve and print counts; do not write or download.
  --plan-only                 Write indexes, but do not download artifacts.
  --force                     Re-download even when a valid final file exists.
  --no-resume-partials        Ignore *.partial files and restart partial downloads.
  --help                      Show this help.

Outputs under --output-root:
  ${DEFAULT_VULNERABLE_BUCKET}/<package>/<version>.tgz
  ${DEFAULT_BENIGN_BUCKET}/<package>/<version>.tgz
  artifact-index.jsonl        One planned row per unique package@version@bucket
  cases-index.jsonl           Per scraped case mapping to bucket artifacts
  download-events.jsonl       Append-only resumable status/event log
  download-summary.json       Latest summary

Rate limiting:
  Retries 429/5xx with exponential backoff, honors Retry-After, and honors
  GitHub x-ratelimit-remaining/x-ratelimit-reset headers. If GITHUB_TOKEN is
  present, it is used for GitHub URLs without printing the token.
`;
}

function parseArgs(argv) {
  const args = {
    input: DEFAULT_INPUT,
    outputRoot: DEFAULT_OUTPUT_ROOT,
    vulnerableBucket: DEFAULT_VULNERABLE_BUCKET,
    benignBucket: DEFAULT_BENIGN_BUCKET,
    registry: DEFAULT_REGISTRY,
    concurrency: DEFAULT_CONCURRENCY,
    maxCases: null,
    limitArtifacts: null,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    progressEvery: DEFAULT_PROGRESS_EVERY,
    dryRun: false,
    planOnly: false,
    force: false,
    resumePartials: true,
    help: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--help") args.help = true;
    else if (arg === "--input") args.input = argv[++i];
    else if (arg === "--output-root") args.outputRoot = argv[++i];
    else if (arg === "--vulnerable-bucket") args.vulnerableBucket = argv[++i];
    else if (arg === "--benign-bucket") args.benignBucket = argv[++i];
    else if (arg === "--registry") args.registry = argv[++i];
    else if (arg === "--concurrency") args.concurrency = Number(argv[++i]);
    else if (arg === "--max-cases") args.maxCases = Number(argv[++i]);
    else if (arg === "--limit-artifacts") args.limitArtifacts = Number(argv[++i]);
    else if (arg === "--timeout-ms") args.timeoutMs = Number(argv[++i]);
    else if (arg === "--progress-every") args.progressEvery = Number(argv[++i]);
    else if (arg === "--dry-run") args.dryRun = true;
    else if (arg === "--plan-only") args.planOnly = true;
    else if (arg === "--force") args.force = true;
    else if (arg === "--no-resume-partials") args.resumePartials = false;
    else throw new Error(`Unknown argument: ${arg}`);
  }

  for (const [name, value] of [
    ["--concurrency", args.concurrency],
    ["--timeout-ms", args.timeoutMs],
    ["--progress-every", args.progressEvery],
  ]) {
    if (!Number.isInteger(value) || value <= 0) {
      throw new Error(`${name} must be a positive integer`);
    }
  }
  for (const [name, value] of [
    ["--max-cases", args.maxCases],
    ["--limit-artifacts", args.limitArtifacts],
  ]) {
    if (value != null && (!Number.isInteger(value) || value <= 0)) {
      throw new Error(`${name} must be a positive integer`);
    }
  }
  return args;
}

async function readJsonl(path, maxRecords) {
  const text = await readFile(path, "utf8");
  const records = [];
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i].trim();
    if (!line) continue;
    try {
      records.push(JSON.parse(line));
    } catch (error) {
      throw new Error(`Invalid JSONL at ${path}:${i + 1}: ${error.message}`);
    }
    if (maxRecords != null && records.length >= maxRecords) break;
  }
  return records;
}

function roleVersion(record, role) {
  const candidates = Array.isArray(record.candidate_versions) ? record.candidate_versions : [];
  return candidates.find((candidate) => candidate?.role === role && typeof candidate.version === "string")?.version ?? null;
}

function exactVersionFromRange(range) {
  if (typeof range !== "string") return null;
  const trimmed = range.trim();
  const exact = /^=?\s*v?(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)$/.exec(trimmed);
  if (exact) return exact[1];
  const quotedExact = /^=\s*"?v?(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)"?$/.exec(trimmed);
  return quotedExact?.[1] ?? null;
}

function parseSemver(version) {
  if (typeof version !== "string") return null;
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(version.trim());
  if (!match) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] ?? "",
  };
}

function compareSemver(a, b) {
  const av = parseSemver(a);
  const bv = parseSemver(b);
  if (!av || !bv) return null;
  for (const key of ["major", "minor", "patch"]) {
    if (av[key] !== bv[key]) return av[key] < bv[key] ? -1 : 1;
  }
  if (av.prerelease === bv.prerelease) return 0;
  if (!av.prerelease) return 1;
  if (!bv.prerelease) return -1;
  return av.prerelease.localeCompare(bv.prerelease);
}

function satisfiesComparator(version, op, target) {
  const cmp = compareSemver(version, target);
  if (cmp == null) return false;
  if (!op || op === "=") return cmp === 0;
  if (op === "<") return cmp < 0;
  if (op === "<=") return cmp <= 0;
  if (op === ">") return cmp > 0;
  if (op === ">=") return cmp >= 0;
  return false;
}

function satisfiesBasicRange(version, range) {
  if (typeof range !== "string" || !range.trim()) return false;
  const disjuncts = range.split("||").map((part) => part.trim()).filter(Boolean);
  if (disjuncts.length === 0) return false;
  return disjuncts.some((part) => {
    const normalized = part.replace(/,/g, " ").trim();
    if (/^[*xX]$/.test(normalized)) return true;
    const exact = exactVersionFromRange(normalized);
    if (exact) return satisfiesComparator(version, "=", exact);
    if (/[~^]/.test(normalized)) return false;
    const comparators = [...normalized.matchAll(/(<=|>=|<|>|=)?\s*v?(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)/g)];
    if (comparators.length === 0) return false;
    return comparators.every((match) => satisfiesComparator(version, match[1] || "=", match[2]));
  });
}

function pickHighestAffectedVersion(packument, affectedRange, firstPatchedVersion) {
  const versions = Object.keys(packument?.versions ?? {}).filter((version) => parseSemver(version));
  const candidates = versions.filter((version) => {
    if (!satisfiesBasicRange(version, affectedRange)) return false;
    if (firstPatchedVersion && compareSemver(version, firstPatchedVersion) != null) {
      return compareSemver(version, firstPatchedVersion) < 0;
    }
    return true;
  });
  candidates.sort((a, b) => compareSemver(b, a) ?? b.localeCompare(a));
  return candidates[0] ?? null;
}

function packagePathSegments(packageName) {
  if (typeof packageName !== "string" || !packageName) return ["unknown"];
  return packageName
    .split("/")
    .filter(Boolean)
    .map((part) => part.replace(/[^A-Za-z0-9@._-]/g, "_"));
}

function safeVersionName(version) {
  return String(version).replace(/[^A-Za-z0-9._+-]/g, "_");
}

function artifactPath(outputRoot, bucketDir, packageName, version) {
  return join(outputRoot, bucketDir, ...packagePathSegments(packageName), `${safeVersionName(version)}.tgz`);
}

function npmPackageUrl(registry, packageName) {
  const encoded = packageName.startsWith("@")
    ? `@${encodeURIComponent(packageName.slice(1).split("/")[0])}/${encodeURIComponent(packageName.split("/")[1] ?? "")}`
    : encodeURIComponent(packageName);
  return `${registry.replace(/\/+$/, "")}/${encoded}`;
}

function tarballUrlAllowed(url) {
  try {
    const parsed = new URL(url);
    return ["http:", "https:"].includes(parsed.protocol) && ALLOWED_TARBALL_HOSTS.has(parsed.hostname.toLowerCase());
  } catch {
    return false;
  }
}

function distForVersion(packument, version) {
  const block = packument?.versions?.[version];
  if (!block || typeof block !== "object") return null;
  const dist = block.dist;
  if (!dist || typeof dist !== "object" || typeof dist.tarball !== "string") return null;
  if (!tarballUrlAllowed(dist.tarball)) {
    return { blockedTarball: dist.tarball };
  }
  return {
    tarball: dist.tarball,
    integrity: typeof dist.integrity === "string" ? dist.integrity : null,
    shasum: typeof dist.shasum === "string" ? dist.shasum : null,
    unpackedSize: Number.isFinite(dist.unpackedSize) ? dist.unpackedSize : null,
    fileCount: Number.isFinite(dist.fileCount) ? dist.fileCount : null,
  };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
  if (remaining === "0" && Number.isFinite(reset) && reset > 0) {
    // GitHub reset is epoch seconds. Add a small guard so we do not retry
    // exactly on the boundary and get another secondary 429/403.
    return Math.max(0, reset * 1000 - Date.now() + 2_000);
  }
  return null;
}

let githubNextRequestAtMs = 0;

async function waitForGithubWindow(url) {
  if (!isGithubUrl(url)) return;
  const waitMs = githubNextRequestAtMs - Date.now();
  if (waitMs > 0) {
    log(`[raw-bundles] GitHub rate-limit window active; waiting ${Math.ceil(waitMs / 1000)}s`);
    await sleep(waitMs);
  }
}

function rememberGithubWindow(url, response) {
  if (!isGithubUrl(url)) return;
  const waitMs = githubResetWaitMs(response);
  if (waitMs != null) {
    githubNextRequestAtMs = Math.max(githubNextRequestAtMs, Date.now() + waitMs);
  }
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

function requestHeadersForUrl(url, headers) {
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
  // GitHub returns both 429 and 403 for primary/secondary rate limiting.
  if (response.status === 403 && isGithubUrl(url)) {
    return response.headers.get("x-ratelimit-remaining") === "0" || response.headers.has("retry-after");
  }
  return false;
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
          log(`[raw-bundles] ${new URL(url).hostname} returned HTTP ${response.status}; backing off ${Math.ceil(waitMs / 1000)}s before retry ${attempt + 1}/${MAX_RETRIES}`);
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
  const response = await fetchWithRetry(url, {
    headers: { Accept: "application/json" },
    timeoutMs,
  });
  return response.json();
}

function sriMatches(integrity, bytes) {
  if (!integrity) return true;
  const parts = String(integrity).split(/\s+/).filter(Boolean);
  for (const part of parts) {
    const dash = part.indexOf("-");
    if (dash <= 0) continue;
    const algo = part.slice(0, dash);
    const expected = part.slice(dash + 1);
    if (!["sha1", "sha256", "sha384", "sha512"].includes(algo)) continue;
    const actual = createHash(algo).update(bytes).digest("base64");
    if (actual === expected) return true;
  }
  return false;
}

async function hashFile(path) {
  return new Promise((resolve, reject) => {
    const sha1 = createHash("sha1");
    const sha256 = createHash("sha256");
    const sha512 = createHash("sha512");
    const stream = createReadStream(path);
    stream.on("data", (chunk) => {
      sha1.update(chunk);
      sha256.update(chunk);
      sha512.update(chunk);
    });
    stream.on("error", reject);
    stream.on("end", () => {
      resolve({
        sha1: sha1.digest("hex"),
        sha256: sha256.digest("hex"),
        sha512Base64: sha512.digest("base64"),
      });
    });
  });
}

async function readWholeFile(path) {
  const fh = await open(path, "r");
  try {
    const { size } = await fh.stat();
    const buf = Buffer.alloc(size);
    await fh.read(buf, 0, size, 0);
    return buf;
  } finally {
    await fh.close();
  }
}

async function validateArtifact(path, dist) {
  let s;
  try {
    s = await stat(path);
  } catch {
    return { ok: false, reason: "missing" };
  }
  if (!s.isFile() || s.size <= 0) return { ok: false, reason: "empty" };

  const hashes = await hashFile(path);
  if (dist?.shasum && hashes.sha1 !== dist.shasum) {
    return { ok: false, reason: "sha1_mismatch", bytes: s.size, ...hashes };
  }
  if (dist?.integrity) {
    // Avoid reading twice for the common sha512 integrity case.
    const ok = String(dist.integrity)
      .split(/\s+/)
      .filter(Boolean)
      .some((part) => part.startsWith("sha512-") && part.slice("sha512-".length) === hashes.sha512Base64);
    if (!ok) {
      const bytes = await readWholeFile(path);
      if (!sriMatches(dist.integrity, bytes)) {
        return { ok: false, reason: "integrity_mismatch", bytes: s.size, ...hashes };
      }
    }
  }
  return { ok: true, bytes: s.size, ...hashes };
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

function nowIso() {
  return new Date().toISOString();
}

function formatError(error) {
  if (error && typeof error === "object" && "stack" in error && error.stack) return error.stack;
  if (error && typeof error === "object" && "message" in error && error.message) return error.message;
  return String(error);
}

function log(message) {
  console.error(`${nowIso()} ${message}`);
}

process.on("unhandledRejection", (error) => {
  log(`[raw-bundles] unhandledRejection: ${formatError(error)}`);
});

process.on("uncaughtException", (error) => {
  log(`[raw-bundles] uncaughtException: ${formatError(error)}`);
  process.exitCode = 1;
});

async function downloadArtifact(task, args, eventsPath) {
  const finalPath = task.path;
  const partialPath = `${finalPath}.partial`;
  await mkdir(dirname(finalPath), { recursive: true });

  if (!args.force) {
    const existing = await validateArtifact(finalPath, task.dist);
    if (existing.ok) {
      const row = {
        schema_version: "modulewarden.raw_bundle_download_event.v1",
        timestamp: nowIso(),
        status: "existing",
        bucket: task.bucket,
        package: task.package,
        version: task.version,
        role: task.role,
        url: task.url,
        path: finalPath,
        case_ids: [...task.caseIds].sort(),
        advisory_ids: [...task.advisoryIds].sort(),
        bytes: existing.bytes,
        sha1: existing.sha1,
        sha256: existing.sha256,
      };
      await appendJsonl(eventsPath, row);
      return row;
    }
  }

  if (!args.resumePartials) {
    await rm(partialPath, { force: true });
  }

  let start = 0;
  try {
    const partial = await stat(partialPath);
    if (partial.isFile()) start = partial.size;
  } catch {
    start = 0;
  }

  const headers = start > 0 ? { Range: `bytes=${start}-` } : {};
  const response = await fetchWithRetry(task.url, {
    headers,
    timeoutMs: args.timeoutMs,
    okStatuses: [200, 206, 416],
  });

  if (response.status === 416) {
    const partialValid = await validateArtifact(partialPath, task.dist);
    if (partialValid.ok) {
      await rename(partialPath, finalPath);
      const row = {
        schema_version: "modulewarden.raw_bundle_download_event.v1",
        timestamp: nowIso(),
        status: "downloaded",
        resumed: true,
        bucket: task.bucket,
        package: task.package,
        version: task.version,
        role: task.role,
        url: task.url,
        path: finalPath,
        case_ids: [...task.caseIds].sort(),
        advisory_ids: [...task.advisoryIds].sort(),
        bytes: partialValid.bytes,
        sha1: partialValid.sha1,
        sha256: partialValid.sha256,
      };
      await appendJsonl(eventsPath, row);
      return row;
    }
    await rm(partialPath, { force: true });
    throw new Error("server returned 416 for partial file, and partial did not validate");
  }

  const append = start > 0 && response.status === 206;
  const flags = append ? "a" : "w";
  const resumed = append;
  if (start > 0 && response.status === 200) start = 0;

  if (!response.body) throw new Error("empty response body");
  const nodeStream = Readable.fromWeb(response.body);
  await pipeline(nodeStream, createWriteStream(partialPath, { flags }));

  const valid = await validateArtifact(partialPath, task.dist);
  if (!valid.ok) {
    await rm(partialPath, { force: true });
    throw new Error(`downloaded artifact failed validation: ${valid.reason}`);
  }
  await rename(partialPath, finalPath);

  const row = {
    schema_version: "modulewarden.raw_bundle_download_event.v1",
    timestamp: nowIso(),
    status: "downloaded",
    resumed,
    bucket: task.bucket,
    package: task.package,
    version: task.version,
    role: task.role,
    url: task.url,
    path: finalPath,
    case_ids: [...task.caseIds].sort(),
    advisory_ids: [...task.advisoryIds].sort(),
    bytes: valid.bytes,
    sha1: valid.sha1,
    sha256: valid.sha256,
  };
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

function mergeArtifact(map, artifact) {
  const key = `${artifact.bucket}\0${artifact.package}\0${artifact.version}`;
  const existing = map.get(key);
  if (!existing) {
    map.set(key, artifact);
    return artifact;
  }
  for (const caseId of artifact.caseIds) existing.caseIds.add(caseId);
  for (const advisoryId of artifact.advisoryIds) existing.advisoryIds.add(advisoryId);
  return existing;
}

function taskToIndexRow(task) {
  return {
    schema_version: "modulewarden.raw_bundle_artifact.v1",
    bucket: task.bucket,
    role: task.role,
    package: task.package,
    version: task.version,
    path: task.path,
    url: task.url,
    integrity: task.dist.integrity,
    shasum: task.dist.shasum,
    unpacked_size: task.dist.unpackedSize,
    file_count: task.dist.fileCount,
    case_ids: [...task.caseIds].sort(),
    advisory_ids: [...task.advisoryIds].sort(),
  };
}

async function writeJsonl(path, rows) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, rows.map((row) => JSON.stringify(row)).join("\n") + (rows.length ? "\n" : ""), "utf8");
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(usage());
    return;
  }

  args.input = resolve(args.input);
  args.outputRoot = resolve(args.outputRoot);

  const records = await readJsonl(args.input, args.maxCases);
  const packumentCache = new Map();
  const artifactMap = new Map();
  const caseRows = [];
  const skipped = [];
  let phase = "planning";
  let processedRecords = 0;
  let packumentStarted = 0;
  let packumentDone = 0;
  let packumentFailed = 0;
  let downloadDone = 0;
  let downloadTotal = 0;

  log(`[raw-bundles] loaded ${records.length} scraped cases from ${args.input}`);
  log(`[raw-bundles] output root: ${args.outputRoot}`);
  log(`[raw-bundles] buckets: vulnerable=${args.vulnerableBucket}, benign=${args.benignBucket}`);

  const heartbeat = setInterval(() => {
    log(
      `[raw-bundles] heartbeat phase=${phase} cases=${processedRecords}/${records.length} ` +
        `packuments=${packumentDone}/${packumentStarted} failed_packuments=${packumentFailed} ` +
        `planned_artifacts=${artifactMap.size} downloads=${downloadDone}/${downloadTotal}`
    );
  }, HEARTBEAT_MS);
  heartbeat.unref?.();

  function markCaseProcessed() {
    processedRecords += 1;
    if (processedRecords === 1 || processedRecords % args.progressEvery === 0 || processedRecords === records.length) {
      log(
        `[raw-bundles] planning ${processedRecords}/${records.length} cases; ` +
          `packuments=${packumentDone}/${packumentStarted}; artifacts=${artifactMap.size}`
      );
    }
  }

  async function getPackument(packageName) {
    if (!packumentCache.has(packageName)) {
      packumentStarted += 1;
      const promise = fetchJson(npmPackageUrl(args.registry, packageName), args.timeoutMs)
        .then((value) => {
          packumentDone += 1;
          if (packumentDone === 1 || packumentDone % args.progressEvery === 0) {
            log(`[raw-bundles] fetched ${packumentDone}/${packumentStarted} packuments`);
          }
          return value;
        })
        .catch((error) => {
          packumentDone += 1;
          packumentFailed += 1;
          log(`[raw-bundles] packument failed for ${packageName}: ${error.message}`);
          return { __error: error };
        });
      packumentCache.set(packageName, promise);
    }
    const result = await packumentCache.get(packageName);
    if (result?.__error) throw result.__error;
    return result;
  }

  await workerPool(records, args.concurrency, async (record) => {
    const packageName = record.package;
    const caseId = String(record.case_id ?? "unknown_case");
    const advisoryIds = Array.isArray(record.advisory_ids) ? record.advisory_ids.map(String) : [];
    const row = {
      schema_version: "modulewarden.raw_bundle_case.v1",
      case_id: caseId,
      package: packageName ?? null,
      case_type: record.case_type ?? null,
      advisory_ids: advisoryIds,
      severity: record.severity ?? null,
      affected_range: record.affected_range ?? null,
      first_patched_version: record.first_patched_version ?? null,
      source_code_location: record.source_code_location ?? null,
      vulnerable: null,
      benign: null,
      skips: [],
    };

    if (typeof packageName !== "string" || !packageName) {
      row.skips.push("missing_package");
      caseRows.push(row);
      markCaseProcessed();
      skipped.push({ case_id: caseId, reason: "missing_package" });
      return;
    }

    let packument;
    try {
      packument = await getPackument(packageName);
    } catch (error) {
      row.skips.push(`packument_error:${error.message}`);
      caseRows.push(row);
      markCaseProcessed();
      skipped.push({ case_id: caseId, package: packageName, reason: "packument_error", error: error.message });
      return;
    }

    const firstPatched = roleVersion(record, "first_patched") ?? record.first_patched_version ?? null;
    let vulnerable = roleVersion(record, "likely_affected") ?? exactVersionFromRange(record.affected_range);
    if (!vulnerable) {
      vulnerable = pickHighestAffectedVersion(packument, record.affected_range, firstPatched);
      if (vulnerable) row.inferred_vulnerable_version = vulnerable;
    }

    for (const spec of [
      { side: "vulnerable", bucket: args.vulnerableBucket, role: "likely_affected", version: vulnerable },
      { side: "benign", bucket: args.benignBucket, role: "first_patched", version: firstPatched },
    ]) {
      if (!spec.version) {
        row.skips.push(`${spec.side}:missing_version`);
        continue;
      }
      const dist = distForVersion(packument, spec.version);
      if (!dist) {
        row.skips.push(`${spec.side}:version_not_in_packument:${spec.version}`);
        continue;
      }
      if (dist.blockedTarball) {
        row.skips.push(`${spec.side}:blocked_tarball_host:${dist.blockedTarball}`);
        continue;
      }
      const path = artifactPath(args.outputRoot, spec.bucket, packageName, spec.version);
      const artifact = mergeArtifact(artifactMap, {
        bucket: spec.bucket,
        role: spec.role,
        package: packageName,
        version: spec.version,
        path,
        url: dist.tarball,
        dist,
        caseIds: new Set([caseId]),
        advisoryIds: new Set(advisoryIds),
      });
      row[spec.side] = {
        bucket: spec.bucket,
        role: spec.role,
        version: spec.version,
        path: artifact.path,
        url: artifact.url,
        integrity: artifact.dist.integrity,
        shasum: artifact.dist.shasum,
      };
    }

    caseRows.push(row);
    markCaseProcessed();
  });

  phase = "writing-index";
  log(`[raw-bundles] planning complete; writing indexes for ${artifactMap.size} unique artifacts`);
  caseRows.sort((a, b) => String(a.case_id).localeCompare(String(b.case_id)));
  let tasks = [...artifactMap.values()].sort((a, b) =>
    a.bucket.localeCompare(b.bucket) || a.package.localeCompare(b.package) || a.version.localeCompare(b.version)
  );
  if (args.limitArtifacts != null) tasks = tasks.slice(0, args.limitArtifacts);

  const artifactRows = tasks.map(taskToIndexRow);
  const counts = {
    input_cases: records.length,
    cases_with_vulnerable: caseRows.filter((row) => row.vulnerable).length,
    cases_with_benign: caseRows.filter((row) => row.benign).length,
    unique_artifacts: tasks.length,
    by_bucket: Object.fromEntries(
      [args.vulnerableBucket, args.benignBucket].map((bucket) => [bucket, tasks.filter((task) => task.bucket === bucket).length])
    ),
    packuments_fetched: packumentCache.size,
    skipped_cases_or_sides: caseRows.reduce((total, row) => total + row.skips.length, 0),
  };

  if (args.dryRun) {
    phase = "complete";
    clearInterval(heartbeat);
    console.log(JSON.stringify({ input: args.input, output_root: args.outputRoot, dry_run: true, counts }, null, 2));
    return;
  }

  await mkdir(args.outputRoot, { recursive: true });
  await mkdir(join(args.outputRoot, args.vulnerableBucket), { recursive: true });
  await mkdir(join(args.outputRoot, args.benignBucket), { recursive: true });
  await writeJsonl(join(args.outputRoot, "artifact-index.jsonl"), artifactRows);
  await writeJsonl(join(args.outputRoot, "cases-index.jsonl"), caseRows);

  // Full npm packuments are large (popular packages carry thousands of
  // versions). We only need artifactRows/caseRows after planning, so drop the
  // cache before streaming tarballs. Without this, long full-corpus runs can
  // hit V8's old-space limit right as downloads begin.
  packumentCache.clear();
  if (globalThis.gc) globalThis.gc();
  log(`[raw-bundles] released packument cache after planning`);

  if (args.planOnly) {
    const summary = { generated_at: nowIso(), input: args.input, output_root: args.outputRoot, plan_only: true, counts };
    await writeFile(join(args.outputRoot, "download-summary.json"), `${JSON.stringify(summary, null, 2)}\n`, "utf8");
    phase = "complete";
    clearInterval(heartbeat);
    console.log(JSON.stringify(summary, null, 2));
    return;
  }

  const eventsPath = join(args.outputRoot, "download-events.jsonl");
  const results = [];
  let done = 0;
  const downloadProgressEvery = Math.max(1, Math.min(args.progressEvery, 10));
  phase = "downloading";
  downloadTotal = tasks.length;
  log(`[raw-bundles] starting downloads for ${tasks.length} unique artifacts with concurrency=${args.concurrency}`);
  await workerPool(tasks, args.concurrency, async (task) => {
    try {
      const row = await downloadArtifact(task, args, eventsPath);
      results.push(row);
      done += 1;
      downloadDone = done;
      if (done === 1 || done % downloadProgressEvery === 0 || done === tasks.length) {
        log(`[raw-bundles] ${done}/${tasks.length} ${row.status}: ${task.package}@${task.version} -> ${task.bucket}`);
      }
    } catch (error) {
      const row = {
        schema_version: "modulewarden.raw_bundle_download_event.v1",
        timestamp: nowIso(),
        status: "failed",
        bucket: task.bucket,
        package: task.package,
        version: task.version,
        role: task.role,
        url: task.url,
        path: task.path,
        case_ids: [...task.caseIds].sort(),
        advisory_ids: [...task.advisoryIds].sort(),
        error: error.message,
      };
      await appendJsonl(eventsPath, row);
      results.push(row);
      done += 1;
      downloadDone = done;
      log(`[raw-bundles] failed ${done}/${tasks.length}: ${task.package}@${task.version} -> ${task.bucket}: ${error.message}`);
    }
  });

  const statusCounts = results.reduce((acc, row) => {
    acc[row.status] = (acc[row.status] ?? 0) + 1;
    return acc;
  }, {});
  const bytes = results.reduce((total, row) => total + (Number(row.bytes) || 0), 0);
  const summary = {
    generated_at: nowIso(),
    input: args.input,
    output_root: args.outputRoot,
    counts,
    download_status: statusCounts,
    downloaded_or_existing_bytes: bytes,
    downloaded_or_existing_gib: Number((bytes / 1024 / 1024 / 1024).toFixed(3)),
  };
  await writeFile(join(args.outputRoot, "download-summary.json"), `${JSON.stringify(summary, null, 2)}\n`, "utf8");
  phase = "complete";
  clearInterval(heartbeat);
  console.log(JSON.stringify(summary, null, 2));
}

main().catch((error) => {
  log(`[raw-bundles] fatal: ${formatError(error)}`);
  process.exitCode = 1;
});
