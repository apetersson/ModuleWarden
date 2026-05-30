#!/usr/bin/env bash
# Conductor for the ModuleWarden demo screen recording.
# Usage:
#   demo/recording/orchestrator.sh           # full recorded run
#   DRY_RUN=1 demo/recording/orchestrator.sh # no ffmpeg; capture frame screenshots instead
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"

OUT_DIR="demo/outputs"
OUT_MP4="$OUT_DIR/demo-recording.mp4"
mkdir -p "$OUT_DIR"

bash demo/recording/setup_npm_sandbox.sh

# Pick avfoundation screen index (macOS). Default to 1; user can override.
SCREEN_IDX="${SCREEN_IDX:-1}"

if [[ "${DRY_RUN:-0}" != "1" ]]; then
  echo "[orchestrator] starting ffmpeg → $OUT_MP4"
  ffmpeg -y -f avfoundation -framerate 30 -i "${SCREEN_IDX}:none" \
    -c:v libx264 -preset veryfast -pix_fmt yuv420p \
    -t 95 "$OUT_MP4" >/tmp/mw-demo-ffmpeg.log 2>&1 &
  FFMPEG_PID=$!
  trap 'kill $FFMPEG_PID 2>/dev/null || true' EXIT
  sleep 1
fi

# Kick off Terminal driver in background (it self-delays)
osascript demo/recording/terminal_demo.applescript >/tmp/mw-demo-applescript.log 2>&1 &
APPLE_PID=$!

# Run playwright synchronously; it pins the runtime to ~92s
node demo/recording/playwright_demo.mjs

wait $APPLE_PID 2>/dev/null || true

if [[ "${DRY_RUN:-0}" != "1" ]]; then
  wait $FFMPEG_PID 2>/dev/null || true
  echo "[orchestrator] done → $OUT_MP4"
  ls -lh "$OUT_MP4"
fi
