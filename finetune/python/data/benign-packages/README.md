# benign-packages

Seed corpus of 20 top npm packages used as **clean baselines** by the
synthetic attack injector at `finetune/python/data/patterns/injector.py`.

## Why this exists

The 26-pattern attack catalog produces synthetic training examples by
mutating real benign package trees: it adds a `postinstall` script, edits
`package.json`, drops a credential-exfil payload, etc., then writes the
mutated result as a known-bad case for the training corpus.

Without a benign baseline corpus the synthetic track is fully blocked.
The walker still produces real GHSA cases (Class B CVE diffs), but the
~8,000 synthetic Class A and Class C examples that the hackathon plan
calls for never get generated.

## How to seed it

```bash
bash finetune/python/data/benign-packages/seed.sh
```

This downloads 20 top npm packages from the public registry, extracts
them into `extracted/<package>-<version>/`, and leaves them ready for
the injector. Approximately 50-100 MB on disk.

To bundle and upload to the team Nextcloud (rather than commit to git):

```bash
bash finetune/python/data/benign-packages/seed.sh --upload-to-nextcloud
```

This requires `.env` at the repo root with `NEXTCLOUD_*` variables set
(see `.env.example`).

## Selection criteria

Picked for diversity. The injector tests each pattern against multiple
package layouts so it does not overfit to a single shape:

| Layout | Packages |
|---|---|
| Single-file simple | `ms`, `minimist`, `json5`, `nanoid` |
| Build-tools | `commander`, `yargs`, `semver`, `glob`, `rimraf`, `uuid` |
| HTTP/IO | `axios`, `express`, `debug`, `dotenv` |
| Logging | `winston`, `pino` |
| UI runtime | `react`, `react-dom`, `chalk` |
| Utility classic | `lodash` |

## What is NOT in here

- npm packages with known compromise history (event-stream, ua-parser-js,
  coa, rc, postmark-mcp). Those live in `demo/incidents/` as faithful
  reconstructions for the live demo.
- Packages requiring native compilation or platform-specific binaries.
  The injector should test against pure-JS surfaces.
- Packages with restrictive licenses. All 20 selections are MIT/Apache/BSD.

## Refresh policy

Re-run `seed.sh` when:
- A new pattern needs a layout the current 20 do not cover.
- A package update fundamentally changes the layout (rare).
- Building a new fine-tune corpus where seed-corpus drift matters.

The script is idempotent: existing extracted directories are skipped.
