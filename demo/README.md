# ModuleWarden live-demo module

Self-contained CLI replays for the 90-second live pitch (slide 5 of the deck).
Each replay walks an incident through the deterministic policy gate, prints
the cited model verdict, and writes a Control Evidence Memo.

## Quick start

```bash
# from repo root, no docker, no network required
python -m demo.run_incident_replay --list
python -m demo.run_incident_replay --incident postmark-mcp-1.0.16
python -m demo.run_incident_replay --incident postmark-mcp-1.0.12
python -m demo.run_incident_replay --incident lodash-4.17.21
```

## What you see

For every replay the CLI prints, in order:

1. **Deterministic policy gate**: a colored five-rule table (release-age,
   install-scripts, source-match, SRI checksum, allowlist). Any FAIL row
   triggers a "quarantine" action regardless of what the model says.
2. **Cited-model audit report**: verdict, confidence, risk level, summary,
   primary findings with category, severity, claim, and evidence references
   back into the dossier.
3. **Developer-safe summary**: the short explanation that goes to the
   developer in the npm install error.
4. **Security-admin summary**: the long explanation for the team handling
   the policy override decision.
5. **Control Evidence Memo file**: written to `demo/outputs/<id>__YYYY-MM-DD.md`,
   markdown reviewable by SOC 2 auditors and cyber-policy underwriters.

## Why these three incidents

| Incident id | Verdict | Why it is in the demo |
|---|---|---|
| `postmark-mcp-1.0.16` | block | Real Sep 2025 npm compromise; centerpiece of the pitch. |
| `postmark-mcp-1.0.12` | allow | Last-known clean release of the same package; proves the gate is not stamping BLOCK on the package name. |
| `lodash-4.17.21` | allow | Mainstream popular package baseline; proves the gate is not stamping BLOCK on everything. |

## How to add an incident

1. Author `demo/incidents/<id>.dossier.json` matching `modulewarden.audit_dossier.v1`
   (see `finetune/contracts/audit-dossier.schema.json`).
2. Author the paired `demo/incidents/<id>.report.json` matching
   `modulewarden.audit_report.v1` (see `finetune/contracts/audit-report.schema.json`).
3. The CLI auto-discovers it via `--list`.

## Pre-pitch checklist

Run the automated preflight first. It fails non-zero the instant a fixture
has drifted, so a broken demo is caught backstage instead of on stage:

```bash
python -m demo.preflight            # exit 0 = demo path is green
bash demo/safe_demo.sh              # the full guided 90s run, preflight-gated
```

`safe_demo.sh` runs preflight, then walks the three incidents offline. Set
`MW_PROXY_URL=http://host:port` to add the live `npm install -> 403` moment
if the proxy stack is up; without it, the offline path is the demo and the
script still succeeds.

Manual equivalents (what preflight automates):

```bash
python -m demo.run_incident_replay --list                            # 3 incidents
python -m demo.run_incident_replay --incident postmark-mcp-1.0.16    # expect BLOCK
python -m demo.run_incident_replay --incident postmark-mcp-1.0.12    # expect ALLOW
python -m demo.run_incident_replay --incident lodash-4.17.21         # expect ALLOW
ls demo/outputs/                                                      # 3 memo files
```

## Offline guarantee

Zero network calls. Zero docker dependency. Zero external service required.
Reads fixture JSON, runs Python evaluation, writes a markdown file. Demo
runs cleanly from a freshly-cloned repo with `python` and nothing else.

## Relation to the full audit pipeline

This module is the *demo* shape of what the production gate does live. The
real pipeline lives in:

- `packages/api-proxy/` (Fastify proxy in front of Verdaccio)
- `packages/worker/` (pg-boss orchestration of audit jobs)
- `packages/audit-runner/` (per-job Docker container running the PI audit)
- `finetune/python/eval/matrix_runner.py` (4-arm offline eval matrix)

The demo CLI here uses the same `audit_dossier.v1` / `audit_report.v1`
contracts so what the audience sees is the same data shape the production
gate emits.
