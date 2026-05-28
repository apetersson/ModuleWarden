#!/usr/bin/env bash
# Seed top npm packages as benign baselines for the synthetic attack injector.
#
# The injector at finetune/python/data/patterns/injector.py mutates real npm
# package trees to produce synthetic training examples. Without a committed
# baseline corpus the synthetic track is blocked. This script downloads 20
# top npm packages by weekly download count, extracts them into per-package
# directories, and leaves them ready for `injector.apply_pattern()`.
#
# Output directory: finetune/python/data/benign-packages/extracted/
# Total disk: ~50-100 MB across 20 packages.
#
# These are PUBLIC npm packages of well-known benign software. They are
# safe to commit if desired, but the default workflow uploads the
# extracted/ directory to Nextcloud via:
#     ./finetune/scripts/nextcloud-sync.sh push <tarball-of-extracted>
#
# Usage:
#   bash finetune/python/data/benign-packages/seed.sh
#   bash finetune/python/data/benign-packages/seed.sh --upload-to-nextcloud

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
OUT_DIR="$SCRIPT_DIR/extracted"

# Pre-flight: required tooling on PATH.
for tool in npm curl tar; do
  if ! command -v "$tool" >/dev/null 2>&1; then
    echo "FAIL: $tool not found on PATH" >&2
    if [ "$tool" = "npm" ]; then
      echo "  Hint: source ~/.nvm/nvm.sh or ensure your Node version manager is active" >&2
    fi
    exit 1
  fi
done

mkdir -p "$OUT_DIR"

# 20 top-downloaded benign npm packages. Picked for diversity:
# different ecosystems (build tools, http, fs, parsers, etc.) and
# different package layouts (single-file, src dir, dist+src split).
PACKAGES=(
  "lodash@4.17.21"
  "chalk@5.3.0"
  "axios@1.7.7"
  "express@4.21.1"
  "react@18.3.1"
  "react-dom@18.3.1"
  "dotenv@16.4.5"
  "commander@12.1.0"
  "yargs@17.7.2"
  "minimist@1.2.8"
  "debug@4.3.7"
  "ms@2.1.3"
  "uuid@10.0.0"
  "nanoid@5.0.7"
  "semver@7.6.3"
  "glob@11.0.0"
  "rimraf@6.0.1"
  "json5@2.2.3"
  "winston@3.15.0"
  "pino@9.5.0"
)

for spec in "${PACKAGES[@]}"; do
  pkg="${spec%@*}"
  ver="${spec##*@}"
  safe_name="$(echo "$pkg" | tr '/' '_')"
  target="$OUT_DIR/${safe_name}-${ver}"

  if [ -d "$target" ]; then
    echo "skip  $spec (already extracted)"
    continue
  fi

  echo "fetch $spec"
  tarball_url=$(npm view "$spec" dist.tarball 2>/dev/null || true)
  if [ -z "$tarball_url" ]; then
    echo "  warn: no tarball for $spec, skipping"
    continue
  fi

  tmpfile="$OUT_DIR/.${safe_name}-${ver}.tgz"
  if ! curl -sfL "$tarball_url" -o "$tmpfile"; then
    echo "  warn: curl failed for $spec, skipping"
    rm -f "$tmpfile"
    continue
  fi
  if [ ! -s "$tmpfile" ]; then
    echo "  warn: empty tarball for $spec, skipping"
    rm -f "$tmpfile"
    continue
  fi

  mkdir -p "$target"
  if ! tar -xzf "$tmpfile" -C "$target" --strip-components=1 2>/dev/null; then
    echo "  warn: tar extract failed for $spec, cleaning up"
    rm -rf "$target" "$tmpfile"
    continue
  fi
  rm -f "$tmpfile"
  echo "  done: $target"
done

echo ""
echo "Seeded benign packages:"
ls -1 "$OUT_DIR" | wc -l
echo "Total bytes:"
du -sb "$OUT_DIR" | cut -f1

if [ "${1:-}" = "--upload-to-nextcloud" ]; then
  REPO_ROOT="$(cd "$SCRIPT_DIR/../../../.." && pwd)"
  bundle="$REPO_ROOT/finetune/corpus/benign-packages-seed.tar.gz"
  echo ""
  echo "Bundling for Nextcloud upload..."
  tar -czf "$bundle" -C "$OUT_DIR" .
  echo "  $(stat -c '%s' "$bundle" 2>/dev/null || stat -f '%z' "$bundle") bytes"
  bash "$REPO_ROOT/finetune/scripts/nextcloud-sync.sh" push "$bundle" "benign-packages-seed.tar.gz"
fi
