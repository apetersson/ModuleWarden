# Demo recording storyboard

Total length target: 90s. Times are cumulative seconds from t=0 (ffmpeg start).

| t (s) | Pane     | Action                                                                  |
|-------|----------|-------------------------------------------------------------------------|
|   0   | both     | Both windows visible: Terminal (left half), Chrome (right half).        |
|   2   | terminal | Type `cd /tmp/mw-demo && npm install dotenv@17.4.2` slowly.             |
|   8   | terminal | Enter → npm contacts proxy → 403/blocked output appears in red.         |
|  14   | browser  | Focus Chrome. Dashboard already loaded. Pan to columns.                 |
|  18   | browser  | Click Manual Audit → type `tiny`, leave version blank, click Audit.     |
|  24   | browser  | Repeat for `delay` and `nanoid`.                                        |
|  32   | browser  | Watch Queued/Running columns light up. Pan to progress bar.             |
|  44   | browser  | Click the Quarantined column header → expand dotenv card.               |
|  52   | browser  | Click the dotenv row → detail view with verdict/summary visible.        |
|  62   | browser  | Click Prompts nav → expand first prompt-pack → show sections.           |
|  72   | terminal | Focus Terminal. Type `npm install left-pad`.                            |
|  78   | terminal | Enter → succeeds → "+ left-pad@1.3.0" appears.                          |
|  85   | both     | Hold final frame for 5s.                                                |
|  90   | -        | ffmpeg stop.                                                            |

## Window layout (1920x1080 assumed; adjust via osascript bounds)

- Terminal.app:   {0,   0, 960, 1080}
- Chrome:         {960, 0, 1920, 1080}

## Files

- `orchestrator.sh` — top-level conductor. Starts ffmpeg, launches playwright
  driver in background, launches Terminal driver, waits, stops ffmpeg.
- `playwright_demo.mjs` — Node script using `playwright` package directly
  (NOT playwright-cli) so we can `await page.waitForTimeout(...)` etc.
- `terminal_demo.applescript` — Opens Terminal.app, positions it, sends
  keystrokes at scheduled offsets.
- `setup_npm_sandbox.sh` — Creates `/tmp/mw-demo/` with `.npmrc` pointing
  at `http://localhost:8080/`.

## Dependencies to install

- `ffmpeg` (brew install ffmpeg) — for avfoundation screen capture.
- `playwright` Node package — `pnpm add -D -w playwright` (or use existing
  installation under `node_modules/.bin/`).
