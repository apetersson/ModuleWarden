# ModuleWarden Demo Preflight Checklist

Single-page punch list. Execute Saturday night, then re-execute the
time-sensitive items Sunday morning at T-2 hours. Strike through items
aloud as you complete them.

Keep this file open on the second laptop. Tag any FAIL item with a name
and a fix-by time.

---

## 1. Repo state

- [ ] `git status` on the demo machine shows clean working tree, no
  uncommitted edits
- [ ] `git pull --ff-only` succeeds against `origin/main`
- [ ] `git log -1 --oneline` matches the head of the deck's "what's
  shipped" slide
- [ ] `pnpm install` exits 0 with no warnings about missing extras
- [ ] `pnpm -r build` exits 0 across all packages
- [ ] `pip install pytest jsonschema` returns success
- [ ] `pytest finetune/python/tests/ demo/tests/ chat/tests/` returns 0
  (target: 53/53 pass)

## 2. Demo machine

- [ ] Docker stack starts cleanly: `docker compose up -d`
- [ ] `docker compose ps` shows postgres, verdaccio, api-proxy, worker all
  Up
- [ ] Healthcheck passes: `curl -sf http://localhost:8080/healthz`
  returns the api-proxy health payload
- [ ] Dashboard boots: `cd packages/web-ui && pnpm dev` then visit
  `http://localhost:5173`. All 6 nav tabs (Dashboard, Queue, Prompts,
  Campaigns, Evaluation, Underwriter) render without console errors.
- [ ] Underwriter view loads. Verify all 5 panels render with mock
  portfolio data.
- [ ] All three offline incidents run:
  `python -m demo.run_incident_replay --list` then replay each.
- [ ] Fresh Control Evidence Memo exists at
  `demo/outputs/postmark-mcp-1.0.16__<today>.md`
- [ ] `demo/recordings/backup-demo-*.cast` exists and is under 5 MB
- [ ] Backup cast plays end to end:
  `asciinema play demo/recordings/backup-demo-*.cast`
- [ ] Terminal font size is set to demo-readable (target row 2 of the
  venue back wall)
- [ ] System sleep + lid-close power settings are set to "do nothing"
  for the next 4 hours
- [ ] Display sleep timer is disabled
- [ ] Notifications are silenced (Do Not Disturb / Focus mode on)
- [ ] Slack, Discord, mail clients are quit (not just minimized)

## 3. Slide deck

- [ ] Final version locked on `finetune/python/pitch/slide-deck.md` (no
  edits after T-2)
- [ ] Deck renders identically on the demo laptop's projector resolution
  (1920x1080, then 1280x720 fallback)
- [ ] Custom fonts render; no glyph substitution boxes on any slide
- [ ] Speaker notes are visible on the secondary screen only
- [ ] Slide 5 (demo) has the backup-variant bullets visible if Andrew
  freezes
- [ ] Slide 12 (the ask) has the right contact email and repo URL
  (`github.com/apetersson/ModuleWarden`)
- [ ] Page numbers match what Andreas will call out from the script
- [ ] No tracked-changes or comment bubbles visible in the export
- [ ] Slide 4 architecture diagram shows the three-layer stack
  (deterministic gate, MW fine-tuned model, DeepSeek V3 second opinion)

## 4. Network

- [ ] Venue wifi credentials saved, tested with `curl https://example.com`
- [ ] Hotspot fallback: phone hotspot password is on the sticky note
- [ ] Hotspot tested: laptop joins, can reach example.com
- [ ] Offline demo runs with wifi OFF (proves the demo is local-only).
  Confirm with `python -m demo.run_incident_replay --incident postmark-mcp-1.0.16`
  with the wifi adapter disabled.
- [ ] No background process is making cloud calls during the demo
  (check `lsof -i` on Linux/macOS or Resource Monitor on Windows for
  surprises)

## 5. Roles

- [ ] Andrew confirms he runs the laptop and types the demo commands
- [ ] Andreas confirms he drives slides 1 to 4, 7 to 10, takes Q&A on
  systems and integration
- [ ] Handoff at slide 5 (demo) is rehearsed once on Saturday night
- [ ] Q&A backstop named: if asked something neither knows, the answer
  is "great question, we will follow up by email today"
- [ ] One of the two has the Q&A escalation card from
  `pitch/q-and-a-prep.md` in pocket

## 6. Submission

- [ ] Final deck uploaded to the submission portal (PDF + source)
- [ ] Repo link in the submission form points to
  `https://github.com/apetersson/ModuleWarden` at a specific commit hash,
  not a branch HEAD that can move
- [ ] Demo video (the asciinema-derived YouTube unlisted URL) is in the
  form
- [ ] `demo/backup-urls.txt` is committed and pushed so the link
  survives a fresh clone
- [ ] Model card (if the deck mentions one) is uploaded; it lives at
  `finetune/python/eval/results/model-card.md` after Saturday training
- [ ] Team contact email is monitored on both phones for judge
  follow-ups
- [ ] Submission confirmation email is saved to a phone screenshot
  (proof of timestamp)

## 7. Stage kit (in the bag)

- [ ] Both laptops above 80 percent battery
- [ ] Both chargers
- [ ] HDMI-to-USB-C dongle
- [ ] HDMI-to-HDMI cable, 2 m or longer
- [ ] US-to-EU power adapter
- [ ] Sticky note with hotspot password and backup video URLs
- [ ] Printed Q&A card
- [ ] Phone with the backup cast URL cached offline
- [ ] Water bottle

---

## Sign-off

- Saturday night execution: ___ (initials) at ___ (time)
- Sunday morning re-check: ___ (initials) at ___ (time)
- Any FAIL items left open: ___ (list with fix-by times)
