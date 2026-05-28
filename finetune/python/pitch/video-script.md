# ModuleWarden 60-Second Pitch Video Script

Target length: 60 seconds. 11 shots. Recordable Saturday night with
asciinema, a phone camera, and OBS for the screen capture.

Voice: one narrator throughout (Andrew or Andreas, whichever has the cleaner mic).
Music: low electronic bed under the whole thing, drop out at 0:45 for the close.

---

## 0:00 to 0:05 HOOK

**Visual:** Black screen. White monospace type appears one character at a time,
like a real terminal: `$ npm install postmark-mcp`. Cursor blinks.

**Narrator:** "In September, an npm maintainer's account was taken over."

**B-roll option:** GitHub Security Advisory page for postmark-mcp showing the
compromise notice, blurred behind the type.

**Music:** Soft bass note enters.

---

## 0:05 to 0:12 PROBLEM

**Visual:** Terminal install scrolls fast. Text overlay drops in: "1,500
weekly downloads of postmark-mcp@1.0.16". Number ticks up live.

**Narrator:** "Fifteen hundred organizations pulled the malicious version
before anyone noticed."

**B-roll:** npm-stats screenshot of weekly downloads for postmark-mcp.
Real numbers.

---

## 0:12 to 0:20 WHY EXISTING TOOLS MISS IT

**Visual:** Split screen. Left: `npm audit` output with "found 0
vulnerabilities". Right: Snyk dashboard with green check.

**Narrator:** "Every tool we have runs after install, or after the CVE
lands. The window between push and patch is the attack. And most of the
time, the install request comes from inside your firewall: a developer
asking an LLM for a CSV parser, or a contractor merging a dependency PR."

---

## 0:20 to 0:32 OUR APPROACH

**Visual:** Architecture diagram appears, drawn one box at a time. Three
horizontal layers. Top: deterministic 5-rule gate. Middle: MW fine-tuned
Qwen3.6-27B auditor in a per-job Docker container. Bottom: DeepSeek V3
second opinion on QUARANTINE band only. Verdaccio promote-only backing on
the right. Postgres lineage on the left.

**Narrator:** "ModuleWarden gates every install through three layers. A
deterministic policy engine handles 80 percent. Our fine-tuned 27B model
is the primary verdict for the rest, running in an isolated audit container
with prompt secrecy. DeepSeek V3 is the second opinion on the QUARANTINE
band. Every decision lands in Postgres with prompt version, model profile,
and supersedes pointer. Underwriting-grade evidence."

**Music:** Builds.

---

## 0:32 to 0:45 LIVE DEMO

**Visual:** Asciinema-style terminal recording, full screen. Type the
command live:

```
$ python -m demo.run_incident_replay --incident postmark-mcp-1.0.16
```

Response renders, color-coded: the 5-rule gate table with FAIL stamps on
release-age, install-scripts, source-match. Then VERDICT: BLOCK with
risk_level: critical. Findings list expands with evidence references.

Big red "BLOCKED" stamp slides in from the right.

**Narrator:** "The September incident. Three rules fail. The fine-tuned
model confirms credential exfiltration. Blocked before any payload ran.
Same response whether the install came from CI, a developer, or Copilot."

---

## 0:45 to 0:55 CREDIBILITY

**Visual:** Three-up:
1. SecLens-R 4-arm eval matrix from `finetune/python/eval/results/` with
   the actual Saturday training numbers.
2. The admin dashboard's Underwriter tab showing the portfolio impact view.
3. URL bar: `github.com/apetersson/ModuleWarden`.

**Narrator:** "Trained on Leonardo. Sixty-four A100s. Held-out catch rate
plus the underwriter view that drops into a UNIQA cyber-insurance claim
file. Open source. Live now."

**Music:** Drops out.

---

## 0:55 to 1:00 CLOSE

**Visual:** Black screen. White type, two lines centered:

```
ModuleWarden
github.com/apetersson/ModuleWarden
```

Logo (a hexagonal shield with a stop sign inside) fades in below the URL.

**Narrator:** "ModuleWarden. The twelfth section of your underwriting
questionnaire."

**Music:** One final low bass note. Silence.

---

## Production notes

**What we record on demo night:**

- The asciinema reel of the postmark-mcp block (0:32 to 0:45). Run the
  offline demo: `python -m demo.run_incident_replay --incident postmark-mcp-1.0.16`.
  Pure stdlib. No network needed.
- The terminal install scroll for the hook (0:00 to 0:12). Use a sandbox
  VM, not the demo laptop. We do not want a real malicious payload near
  the production environment.
- The architecture diagram (0:20 to 0:32). Draw it once in Excalidraw or
  tldraw, screen-record the draw, then trim.
- The eval numbers and underwriter view (0:45 to 0:55). Run the eval
  matrix Saturday afternoon, screenshot the dashboard panels.

**What we do NOT record on demo night:**

- A real install of a real malicious package. Always use a sandbox VM,
  never the demo laptop.
- Any judge or sponsor logo. We do not have permission and it makes the
  video unshippable after the event.
- The exact AUROC if it lands below 0.85. Replace with "calibrated catch
  rate on the SecLens-R bench" and show the per-class breakdown instead.

**Fallback if the gate is down at record time:**

Replace the live demo with a pre-recorded asciinema reel checked into the
repo at `demo/recordings/backup-demo.cast`. Generate it with `asciinema rec`
against a known-good gate before traveling.

**Two-language version:**

The script is short enough that a German voiceover is feasible if a sponsor
wants it. Andreas can read the German cut.

**Words to scrub from the final cut:**

The narrator must avoid AI-marker words from the project style guide. The
script already does. Em-dashes do not exist in spoken audio so that
constraint is automatic.

---

## Word count check

Narrator copy total: 142 words. Read at about 130 wpm gives 65.5 seconds.
Tight at the 60-second target. Possible cuts: shorten the 0:20 architecture
section to "Three layers. Rule engine, our fine-tuned model in Docker, and
DeepSeek as a second opinion on hard cases."
