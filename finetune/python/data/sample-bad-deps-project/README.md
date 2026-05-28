# sample-bad-deps-project

End-to-end test surface for the ModuleWarden gate. A minimal Node.js
project whose `package.json` declares known-compromised npm versions
alongside known-clean baselines. Used to verify the gate blocks the bad
versions before any payload executes.

## Safety model

This project NEVER runs `npm install` on the host. All execution happens
inside a Docker container with three independent safety layers:

1. `--network none` cuts the container off from the public internet.
   The container can only reach the MW gate on a private bridge network.
2. `--read-only` plus a tmpfs `/tmp` makes the filesystem immutable.
   Even if a postinstall script ran, it could not persist anywhere.
3. `npm install --ignore-scripts` is hard-coded into the test script.
   The package's `postinstall` hooks never execute under any condition.

The test passes if and only if:

- The gate BLOCKED the malicious versions (HTTP 451 on tarball serve).
- The gate ALLOWED the benign versions (HTTP 200 on tarball serve).
- No malicious script ran inside the container (verified by checking
  there are no new files in /tmp and no outbound network attempts in
  the container log).

## Layout

```
sample-bad-deps-project/
  package.json       # 5 known-bad + 5 known-clean dep entries
  .npmrc             # routes npm at the MW gate (http://mw-gate:8080)
  Dockerfile         # alpine, --ignore-scripts, read-only fs
  docker-compose.yml # isolated bridge network, no external egress
  test-gate.sh       # runs npm install, asserts each expected verdict
  expected.json      # ground-truth verdict per package version
```

## Running the test

```bash
# REQUIRED: pin the project name so the network gets the predictable name
# `modulewarden_default` regardless of the repo directory name.
export COMPOSE_PROJECT_NAME=modulewarden

# From the MW repo root, bring up the production stack first:
docker compose up -d            # postgres + verdaccio + api-proxy + worker

# Verify the network exists with the right name:
docker network ls | grep modulewarden_default

# Then run the test project against the live gate:
cd finetune/python/data/sample-bad-deps-project
docker compose up --abort-on-container-exit --exit-code-from tester
```

If the network is named differently (e.g. `_mw-clone_default`), the test
exits 2 with `network modulewarden_default declared as external, but
could not be found`. Set `COMPOSE_PROJECT_NAME=modulewarden` and bring
the stack back up.

Expected output (last line):

```
PASS  sample-bad-deps: 5 BLOCK + 5 ALLOW matched, 0 script executions
```

If the gate is NOT running on port 8080 the test fails fast with a
connection-refused error rather than degrading to a direct npm install.

## Known-bad dependencies (expected verdict BLOCK)

| Package | Version | Incident | Class |
|---|---|---|---|
| postmark-mcp | 1.0.16 | Sep 2025 maintainer takeover, BCC credential exfil | A |
| event-stream | 3.3.6 | Nov 2018 transitive malware via flatmap-stream | A |
| ua-parser-js | 0.7.29 | Oct 2021 cryptominer + credential exfil | A |
| coa | 2.0.3 | Nov 2021 maintainer takeover, credential exfil | A |
| rc | 1.2.9 | Nov 2021 maintainer takeover, malicious payload | A |

All five have public GHSA records. The gate's source-match rule plus
release-age rule plus lifecycle-script triage are sufficient to block
each one without consulting the model.

## Known-clean dependencies (expected verdict ALLOW)

| Package | Version | Notes |
|---|---|---|
| lodash | 4.17.21 | Pinned LTS, source-match 99 percent |
| chalk | 5.3.0 | Pinned LTS |
| commander | 12.1.0 | Pinned LTS |
| express | 4.21.1 | Pinned LTS |
| react | 18.3.1 | Pinned LTS |

These prove the gate is not just stamping BLOCK on everything. They
are also five of the twenty baselines used by the synthetic injector at
`finetune/python/data/benign-packages/`.

## What this is NOT

- Not a continuous-fuzz harness. A single deterministic check per run.
- Not a place to add new malicious packages without GHSA citations. If
  the incident does not have a public advisory, it does not belong here.
- Not a replacement for the offline incident replay at
  `demo/run_incident_replay.py`. The offline replay tests the dossier-
  to-report path with pre-prepared fixtures. This project tests the
  gate-to-install path end-to-end against the live npm registry.

## Adding a new known-bad case

1. Confirm the incident has a public GHSA advisory (or equivalent OSV
   entry).
2. Add the package and version to `package.json` under `dependencies`.
3. Add a row to `expected.json` with `verdict: "block"` and the GHSA id.
4. Run `docker compose up --abort-on-container-exit`. The test should
   continue to PASS; the new entry adds one more BLOCK assertion.
