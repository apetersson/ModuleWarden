# Case Sourcing and Scraping Method

## Purpose

Scraping creates candidate cases, not final training data. The scraper should collect advisories, normalize package/version metadata, and propose version pairs. Humans or high-quality teacher review then promote selected candidates into `golden-cases.json`.

## Primary Sources

### GitHub Global Security Advisories

Use GitHub's REST endpoint:

```text
GET https://api.github.com/advisories
```

Useful query parameters:

- `ecosystem=npm`
- `type=reviewed`
- `type=malware`
- `severity=high` or `severity=critical`
- `published=YYYY-MM-DD..YYYY-MM-DD`
- `updated=YYYY-MM-DD..YYYY-MM-DD`
- `per_page=100`
- `after=<cursor>`

Use `GITHUB_TOKEN` when available to improve rate-limit behavior. Public resources can be fetched without a token.

### OSV

Use OSV for enrichment and cross-checking:

```text
POST https://api.osv.dev/v1/query
POST https://api.osv.dev/v1/querybatch
GET  https://api.osv.dev/v1/vulns/{id}
```

Use `ecosystem: "npm"` and package names or package URLs.

### npm Registry Packuments

Use npm packuments for version metadata:

```text
GET https://registry.npmjs.org/{package}
GET https://registry.npmjs.org/{package}/{version}
```

Packuments provide versions, dist metadata, publish times, scripts, dependencies, maintainers, repository URLs, and tarball URLs.

## Output Files

The scraper writes JSONL to:

```text
finetune/corpus/scraped-cases.jsonl
```

Each line is a normalized candidate case:

```json
{
  "case_id": "ghsa_GHSA_xxxx_npm_package",
  "source": "github_advisory",
  "case_type": "cve_diff",
  "package": "package-name",
  "advisory_ids": ["GHSA-...", "CVE-..."],
  "severity": "high",
  "affected_range": "< 1.2.3",
  "first_patched_version": "1.2.3",
  "candidate_versions": [],
  "benign_neighbor_versions": [],
  "references": [],
  "triage_status": "candidate"
}
```

## Pipeline

1. Fetch GitHub reviewed npm advisories.
2. Fetch GitHub npm malware advisories.
3. Normalize advisories by package.
4. Enrich with npm packument data.
5. Infer candidate versions:
   - `first_patched_version` for fixed-version examples;
   - highest affected version before the patch when inferable;
   - nearest previous and next versions as benign neighbors.
6. Enrich or cross-check with OSV by package/version.
7. Write candidates as JSONL.
8. Manually promote high-quality cases into `golden-cases.json`.

## Triage States

- `candidate`: scraped but not reviewed.
- `needs_enrichment`: package/version mapping is incomplete.
- `promoted`: selected for dossier generation.
- `rejected`: unsuitable for training.

## Known Limitations

- Advisory ranges do not always identify the introducing version.
- CVE fixes do not always map to npm tarball diffs.
- GitHub malware advisories and CVE advisories represent different threat classes.
- SZZ-style vulnerable-introducing diff inference is noisy and should be treated as a weak signal.
- Scraped data should not be used directly for final labels without review.

## Source References

- GitHub Global Security Advisories REST API: `https://docs.github.com/en/rest/security-advisories/global-advisories`
- OSV API: `https://google.github.io/osv.dev/api/`
- npm Registry API: `https://github.com/npm/registry/blob/main/docs/REGISTRY-API.md`
