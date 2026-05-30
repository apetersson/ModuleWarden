# ModuleWarden Demo Runbook: Sunday Morning

The literal steps. Do not improvise. Run this checklist top to bottom Sunday
morning, two hours before the 13:30 pitch.

This runbook covers the v2 architecture: a self-hosted npm registry proxy,
per-job Docker audit containers, Postgres decision lineage, and the
deterministic policy gate that drives the incident replays in
`demo/run_incident_replay.py`. The earlier classifier-only path described in
the previous runbook is no longer the demo surface.

---

## Pre-event setup (do this on the demo laptop, Friday night)

1. Clone the repo: `git clone https://github.com/apetersson/ModuleWarden && cd ModuleWarden`
2. Install Python deps (pure stdlib demo, but tests want pytest):
   `pip install pytest jsonschema`
3. Install Node deps for the dashboard:
   `pnpm install && pnpm -r build`
4. Install asciinema for backup video (Linux/macOS).
   On Win11 the team uses WSL2; install asciinema inside the WSL distro,
   then run all the backup commands from WSL.
5. Smoke-test all three incidents:
   `python -m demo.run_incident_replay --list` to confirm the registry, then
   `python -m demo.run_incident_replay --incident postmark-mcp-1.0.16` to
   confirm BLOCK with a Control Evidence Memo at
   `demo/outputs/postmark-mcp-1.0.16__<today>.md`.
6. Spin up the production stack for the deeper demo:
   `docker compose up -d` (postgres + verdaccio + api-proxy + worker + web-ui)
7. Boot the dashboard:
   `cd packages/web-ui && pnpm dev`. Visit `http://localhost:5173`.
   Click the "Risk portfolio" tab (`#risk-portfolio`). Confirm the five
   panels render.
8. Record the backup video:
   `bash demo/record_backup.sh` (or replay the three incidents via asciinema)
9. Upload backup to YouTube unlisted and asciinema.org. Save URLs in
   `demo/backup-urls.txt`.

## Demo morning (Sunday, T-2 hours)

1. Start the docker stack:
   `docker compose up -d` then `docker compose ps` to confirm 4 containers up
2. Boot the dashboard:
   `cd packages/web-ui && pnpm dev` then visit `http://localhost:5173`
3. Verify the offline demo runs without the stack:
   `python -m demo.run_incident_replay --list` returns the 3 incidents
4. Open the slide deck on screen 2
5. Have the backup video URLs printed on a sticky note
6. Cue the asciinema cast as a fallback in screen 3
7. Coffee

---

## Roles

- **Andrew:** runs the laptop, types the demo commands, owns the gate
  process AND drives the dashboard click-through.
- **Andreas:** drives the slide deck, narrates slides 1 to 4 and slides 7
  to 10, hands off to Andrew for slide 5 (live demo), takes Q&A on systems
  and integration.
- **Either:** handles slide 12 (the ask) and the closing line.

---

## Pre-flight checklist (T-2 hours)

Tick each one out loud. Do not skip. The full punch list lives in
`finetune/python/pitch/preflight-checklist.md`.

1. **Docker stack is up.** `docker compose ps` shows postgres, verdaccio,
   api-proxy, worker all running. If not, restart with
   `docker compose down && docker compose up -d`.
2. **Decisions table is populated.** Run a sanity query:
   `docker compose exec postgres psql -U mw -d mw -c "SELECT count(*) FROM \"Decision\""`.
   Expect at least the three incident rows from prior runs.
3. **Offline demo runs cleanly.** Run
   `python -m demo.run_incident_replay --incident postmark-mcp-1.0.16`.
   Verdict must read BLOCK with risk_level critical.
4. **All three incidents replay cleanly.** Run
   `python -m demo.run_incident_replay --list` to confirm registry, then
   replay each: lodash ALLOW, postmark-mcp@1.0.16 BLOCK,
   postmark-mcp@1.0.12 ALLOW.
5. **Control Evidence Memo renders.** Check `demo/outputs/` for a fresh
   `postmark-mcp-1.0.16__*.md` and confirm it has the rule table, model
   audit summary, and the decision footer.
6. **Dashboard loads.** Visit `http://localhost:5173`. Click each nav tab.
   Click the "Risk portfolio" tab (`#risk-portfolio`) and confirm all 5
   panels render with mock portfolio data.
7. **Screen recording is on.** OBS recording the laptop screen to disk.
   Capture every demo, do not rely on remembering to start it.
8. **Backup cast is on the second laptop.** The asciinema `.cast` from
   `demo/recordings/` plus the YouTube unlisted URL are on Andreas's
   laptop, full-screen ready. Test the AV switch.
9. **Backup cast is on the phone too.** Same `.cast` URL on Andrew's
   phone. If both laptops fail, plug the phone into the HDMI dongle.
10. **Battery and chargers.** Both laptops above 80 percent, both chargers
    in the bag, one HDMI-to-USB-C dongle, one HDMI-to-HDMI cable, one
    US-to-EU power adapter.
11. **Network plan.** Test the venue wifi. If flaky, switch to a phone
    hotspot. The offline demo runs without the internet (pure stdlib).
    Confirm by killing wifi and re-running the three incidents.
12. **Slide deck loaded.** Latest version pulled, opened in presenter mode,
    presenter notes visible on Andreas's screen.
13. **Question card.** Print the Q&A escalation matrix from
    `q-and-a-prep.md` on one card, in pocket.

---

## The demo, step by step

This is what Andrew types on stage. Pace: slow. Speak the command as you
type it. Pause after each output. Target total runtime: about 90 seconds.

### Step 1: Replay the September incident, postmark-mcp 1.0.16

```bash
python -m demo.run_incident_replay --incident postmark-mcp-1.0.16
```

Expected: red BLOCK verdict with FAIL on release-age, install-scripts,
and source-match. Cited model audit report with risk_level critical and
four HIGH-tagged findings.

Say: "Postmark-mcp 1.0.16. The September 2025 incident. Three deterministic
rules fail. The audit container's fine-tuned model confirms credential
exfiltration plus undeclared network egress. The gate refused the install
before any payload ran."

### Step 2: Open the Postgres decision row in the admin dashboard

Browser switches to `http://localhost:5173/admin`. Click the audit-run row
for postmark-mcp-1.0.16. The decision detail modal opens. Show:

- The verdict (BLOCK)
- The prompt_version stamp
- The model_profile reference
- The supersedes pointer (null because no override)
- The 4 evidence references

Say: "This is not just a security tool. This is the auditable decision
history. Every block lands in Postgres with prompt version, model profile,
evidence references, and an admin override path. A risk reviewer can pull
this row directly into a review and read why the forecast acted the way it
did."

### Step 3: Open the Risk portfolio view

Click the "Risk portfolio" nav tab (`#risk-portfolio`). The five panels
render:

1. Dependencies ranked by forecasted blast-radius trajectory: which deps
   are climbing toward critical fastest across 250 monitored orgs
2. Correlated exposure: 41 percent touched by 2026-class npm compromise
3. Incident replays: 3 Postgres decision rows
4. What the gate already caught: install deltas the deterministic gate
   adopted, waited on, or blocked before they reached a build
5. Insider risk panel: LLM-suggested installs caught in the last 30 days

(The downstream-insurance view of this same data, expected loss avoided in
EUR, lives in the archived insurance one-pager and is a one-line fallback
only.)

Say: "Most npm security stops the attacker outside the firewall. This
stops the developer inside who let Copilot suggest a malicious package, or
the contractor who pulled in an unchecked dependency. Same gate, same
evidence, same Postgres lineage. Verizon DBIR puts 74 percent of breaches
on the human element. This view ranks dependencies by forecasted
trajectory: which ones are climbing toward critical, so a reviewer vets
them first, and what the gate already caught before any of it became a
problem."

### Step 4: Replay the clean baseline (proves the gate is not just BLOCK)

```bash
python -m demo.run_incident_replay --incident lodash-4.17.21
```

Expected: green ALLOW verdict, every rule PASS.

Say: "Lodash 4.17.21. The most-installed package on npm. Every rule
passes. Verdict allow. The gate does not stamp BLOCK on everything."

### Step 5: Hand back to Andreas

Walk back to the slide deck. Andreas advances to the next slide.

---

## Fallback paths

**Docker stack is down at demo time:**

- The offline demo (`python -m demo.run_incident_replay`) does NOT need
  Docker. Skip the dashboard click-through if needed; the offline replays
  carry the demo.

**Dashboard is broken at demo time:**

- Skip the Risk portfolio view. Open the Risk portfolio screenshots from
  the slide deck appendix. Say: "The dashboard is in the repo; we will
  ship the cached version because the wifi here is flaky."

**Network is down at demo time:**

- The offline demo does not need the internet. The incident replays read
  incident fixtures from `demo/incidents/` and call the local policy
  engine. If you find yourself reaching for the internet, you took a
  wrong turn.

**A judge asks to replay a different incident:**

- The three shipped incidents are `lodash-4.17.21`, `postmark-mcp-1.0.16`,
  `postmark-mcp-1.0.12`. Anything else is outside the demo surface.
  Say: "We ship three reconstructions in-tree. Adding a new incident is
  a fifteen-minute job; I can mail you the result this afternoon."

**Andrew gets stuck typing on stage:**

- Andreas keeps narrating. The slide deck has the commands typed out as
  bullets on the demo slide's backup variant. Switch to those. Do not
  panic. Speak to the screen, not the laptop.

---

## Two-minute booth elevator pitch

For when judges or sponsors walk up to the booth between rounds. Whoever
is at the booth says this:

"ModuleWarden's deterministic gate detects the known-bad on every install
delta; the Sybilion forecast ranks which dependencies to review first by
trajectory. It is a self-hosted registry gate that produces an auditable
decision history for every install. Postgres decision lineage, per-job
Docker isolation with prompt secrecy, schema-versioned audit reports, admin
overrides with full provenance. Every block produces a row a risk reviewer
can pull up and read why the gate acted. We replay three real incidents and
prove the gate would have blocked the bad release without a denylist. Want
to see it? I will block the September postmark-mcp incident on this laptop
in 20 seconds, then open the Risk portfolio view that ranks org
dependencies by forecasted trajectory."

If they say yes, run steps 1 through 3 of the demo. If they say no, hand
them a card with the URL and one line:
"Live now at github.com/apetersson/ModuleWarden."
Move on.
