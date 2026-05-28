#!/usr/bin/env bash
# Nextcloud sync helper for ModuleWarden finetune data.
#
# Reads credentials from .env at the repo root, so secrets never land in
# git. Two subcommands:
#
#   ./nextcloud-sync.sh pull <remote-relative-path> [local-path]
#       Download a file from Nextcloud into the repo's local staging dir.
#       If local-path is omitted, writes to finetune/corpus/<basename>.
#
#   ./nextcloud-sync.sh push <local-path> [remote-relative-path]
#       Upload a local file into the Nextcloud finetune-data folder.
#       If remote-relative-path is omitted, keeps the local basename.
#
#   ./nextcloud-sync.sh ls
#       List files currently in the finetune-data folder.
#
# Example:
#   ./nextcloud-sync.sh pull scraped-cases.npm-enriched.jsonl
#   ./nextcloud-sync.sh push finetune/corpus/sft-records.jsonl
#   ./nextcloud-sync.sh ls

set -euo pipefail

# Locate the repo root (.env lives there).
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

# Source .env if present. Never echo it.
if [ -f "$REPO_ROOT/.env" ]; then
  set -a
  # shellcheck disable=SC1091
  source "$REPO_ROOT/.env"
  set +a
fi

: "${NEXTCLOUD_URL:?NEXTCLOUD_URL must be set in .env}"
: "${NEXTCLOUD_USER:?NEXTCLOUD_USER must be set in .env}"
: "${NEXTCLOUD_PASS:?NEXTCLOUD_PASS must be set in .env}"
: "${NEXTCLOUD_FINETUNE_PATH:=/ZeroToOne_Data/finetune-data}"

BASE_URL="$NEXTCLOUD_URL/remote.php/dav/files/$NEXTCLOUD_USER$NEXTCLOUD_FINETUNE_PATH"

usage() {
  cat <<'EOF'
Usage:
  nextcloud-sync.sh ls
  nextcloud-sync.sh pull <remote-relative-path> [local-path]
  nextcloud-sync.sh push <local-path> [remote-relative-path]
EOF
  exit 2
}

cmd="${1:-}"
case "$cmd" in
  ls)
    curl -sf -u "$NEXTCLOUD_USER:$NEXTCLOUD_PASS" \
      -X PROPFIND --header "Depth: 1" \
      "$BASE_URL/" \
    | python -c "
import sys, re
data = sys.stdin.read()
hrefs = re.findall(r'<d:href>(.*?)</d:href>', data)
sizes = re.findall(r'<d:getcontentlength>(\d+)</d:getcontentlength>', data)
mtimes = re.findall(r'<d:getlastmodified>(.*?)</d:getlastmodified>', data)
for i, h in enumerate(hrefs):
    name = h.rstrip('/').split('/')[-1] or h
    if i == 0:
        continue
    idx = i - 1
    size = int(sizes[idx]) if idx < len(sizes) else 0
    size_str = f'{size/1024/1024:.2f}MB' if size > 1024*1024 else f'{size/1024:.1f}KB' if size > 1024 else f'{size}B'
    mtime = mtimes[i] if i < len(mtimes) else 'unknown'
    print(f'  {size_str:>10}  {mtime}  {name}')
"
    ;;
  pull)
    remote="${2:?remote path required}"
    local_path="${3:-$REPO_ROOT/finetune/corpus/$(basename "$remote")}"
    echo "Pulling $remote -> $local_path"
    mkdir -p "$(dirname "$local_path")"
    curl -sf -u "$NEXTCLOUD_USER:$NEXTCLOUD_PASS" \
      "$BASE_URL/$remote" -o "$local_path"
    size=$(stat -c '%s' "$local_path" 2>/dev/null || stat -f '%z' "$local_path" 2>/dev/null || echo 0)
    echo "  done: $size bytes"
    ;;
  push)
    local_path="${2:?local path required}"
    remote="${3:-$(basename "$local_path")}"
    if [ ! -f "$local_path" ]; then
      echo "Error: local file not found: $local_path" >&2
      exit 1
    fi
    size=$(stat -c '%s' "$local_path" 2>/dev/null || stat -f '%z' "$local_path" 2>/dev/null || echo 0)
    echo "Pushing $local_path ($size bytes) -> $remote"
    curl -sf -u "$NEXTCLOUD_USER:$NEXTCLOUD_PASS" \
      -T "$local_path" \
      "$BASE_URL/$remote"
    echo "  done"
    ;;
  *)
    usage
    ;;
esac
