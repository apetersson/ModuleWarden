#!/usr/bin/env bash

printDumpDebug=0

debug() {
  case "$printDumpDebug" in
    1|true|TRUE|yes|YES|on|ON) echo "$@" >&2 ;;
  esac
}

EXCLUDED_FOLDERS=(
  "deployments"
  "assets"
  "backups"
  "bazel-*"
  "bower_components"
  "buck-out"
  "build"
  "contracts"
  "coverage"
  "deps"
  "dist"
  "dump"
  ".cache"
  ".git"
  ".gradle"
  ".idea"
  ".mypy_cache"
  ".next"
  ".nuxt"
  ".pytest_cache"
  ".tox"
  ".venv"
  "__pycache__"
  "logs"
  "node_modules"
  "out"
  "pgdata"
  "postgres-data"
  "postgres_data"
  "postgresql"
  "public"
  "storybook-static"
  "target"
  "testdata"
  "tmp"
  "var"
  "vendor"
  "NSISLibs"
)
EXCLUDED_FILETYPES=(
  "package-lock.json"
  "*.otf"
  "*.ttf"
  ".env*"
  "*.webp"
  "*.gif"
  "*.mp4"
  "*.png"
  "*.svg"
  "*.jpeg"
  "*.jpg"
  ".DS_Store"
  "*.ico"
  "*.lock"
  "*.pyc"
  "*.sqlite"
  "*.sqlite3"
  "*.sqlitedb"
  "*.sqlite-wal"
  "*.sqlite-shm"
  "*.zip"
  "*.tar*"
  "*.tgz"
  "*.gz"
  "*.bz2"
  "*.log"
  "*.out"
  "*.err"
  "*.trace"
  "*.db"
  "*.db3"
  "*.h2.db"
  "*.mdb"
  "*.pdb"
  "*.bin"
  "*.dat"
  "*.pak"
  "*.npz"
  "*.npy"
  "*.pkl"
  "*.h5"
  "*.wasm"
  "*.class"
  "*.jar"
  "*.war"
  "*.dll"
  "*.so"
  "*.dylib"
  "*.exe"
)
MAX_SIZE=51200

if [ "$#" -gt 0 ]; then
  TARGET_DIRS=("$@")
else
  TARGET_DIRS=(".")
fi

GITIGNORE_RULES=()
GITIGNORE_NEGATED=()

load_gitignore_rules() {
  local target="$1"
  debug "Loading .gitignore rules for: $target"
  GITIGNORE_RULES=()
  GITIGNORE_NEGATED=()

  local files=()
  local root=""

  if command -v git >/dev/null 2>&1; then
    root=$(git -C "$target" rev-parse --show-toplevel 2>/dev/null || true)
  fi

  if [ -n "$root" ] && [ -f "$root/.gitignore" ]; then
    files+=("$root/.gitignore")
  fi
  if [ -f "$target/.gitignore" ] && [ "$target/.gitignore" != "$root/.gitignore" ]; then
    files+=("$target/.gitignore")
  fi

  if [ "${#files[@]}" -eq 0 ]; then
    debug "No .gitignore files found for: $target"
  else
    debug "Using .gitignore files: ${files[*]}"
  fi

  for gi in "${files[@]}"; do
    while IFS= read -r line || [ -n "$line" ]; do
      line="${line%$'\r'}"
      [ -z "$line" ] && continue
      case "$line" in
        \#*) continue ;;
      esac
      if [[ "$line" == \\#* || "$line" == \\!* ]]; then
        line="${line#\\}"
      fi
      local neg=0
      if [[ "$line" == \!* ]]; then
        neg=1
        line="${line#\!}"
      fi
      [ -z "$line" ] && continue
      GITIGNORE_RULES+=("$line")
      GITIGNORE_NEGATED+=("$neg")
    done < "$gi"
  done

  debug "Loaded ${#GITIGNORE_RULES[@]} .gitignore rules for: $target"
}

gitignore_pattern_matches() {
  local pattern="$1"
  local relpath="$2"
  local anchored=0
  local dir_only=0

  if [[ "$pattern" == /* ]]; then
    anchored=1
    pattern="${pattern#/}"
  fi
  if [[ "$pattern" == */ ]]; then
    dir_only=1
    pattern="${pattern%/}"
  fi
  [ -z "$pattern" ] && return 1

  if [[ "$pattern" == *"/"* ]]; then
    if [ "$anchored" -eq 1 ]; then
      if [ "$dir_only" -eq 1 ]; then
        [[ "$relpath" == "$pattern/"* ]]
      else
        [[ "$relpath" == "$pattern" || "$relpath" == "$pattern/"* ]]
      fi
    else
      if [ "$dir_only" -eq 1 ]; then
        [[ "$relpath" == "$pattern/"* || "$relpath" == "*/$pattern/"* ]]
      else
        [[ "$relpath" == "$pattern" || "$relpath" == "$pattern/"* || "$relpath" == "*/$pattern" || "$relpath" == "*/$pattern/"* ]]
      fi
    fi
    return $?
  fi

  local IFS='/'
  local parts=()
  read -r -a parts <<< "$relpath"
  local last_index=$((${#parts[@]} - 1))
  local i
  for i in "${!parts[@]}"; do
    if [ "$anchored" -eq 1 ] && [ "$i" -ne 0 ]; then
      continue
    fi
    if [[ "${parts[$i]}" == $pattern ]]; then
      if [ "$dir_only" -eq 1 ] && [ "$i" -eq "$last_index" ]; then
        continue
      fi
      return 0
    fi
  done
  return 1
}

is_gitignored() {
  local relpath="$1"
  [ "${#GITIGNORE_RULES[@]}" -eq 0 ] && return 1
  local ignore=0
  local i
  for i in "${!GITIGNORE_RULES[@]}"; do
    if gitignore_pattern_matches "${GITIGNORE_RULES[$i]}" "$relpath"; then
      if [ "${GITIGNORE_NEGATED[$i]}" -eq 1 ]; then
        ignore=0
      else
        ignore=1
      fi
    fi
  done
  [ "$ignore" -eq 1 ]
}

FILES=()

for target in "${TARGET_DIRS[@]}"; do
  target="${target%/}"
  [ -z "$target" ] && target="."

  debug "Scanning target: $target"
  load_gitignore_rules "$target"

  FIND_CMD=(find "$target")
  FIND_CMD+=("(")
  for folder in "${EXCLUDED_FOLDERS[@]}"; do
    FIND_CMD+=("-path" "*/$folder/*" "-prune" "-o")
  done
  FIND_CMD+=("-false" ")")
  FIND_CMD+=("-o" "(" "-type" "f" "(")
  for ft in "${EXCLUDED_FILETYPES[@]}"; do
    FIND_CMD+=("!" "-name" "$ft")
  done
  FIND_CMD+=(")" "-print0" ")")

  debug "Running find for: $target"
  while IFS= read -r -d '' f; do
    if [ "${#GITIGNORE_RULES[@]}" -gt 0 ]; then
      rel="$f"
      if [ "$target" = "." ]; then
        rel="${rel#./}"
      else
        rel="${rel#$target/}"
      fi
      if is_gitignored "$rel"; then
        continue
      fi
    fi
    FILES+=("$f")
  done < <("${FIND_CMD[@]}")
  debug "Finished find for: $target (total files so far: ${#FILES[@]})"
done

# --- 1. summary ---------------------------------------------------------------
debug "Preparing output for ${#FILES[@]} files..."
echo "### File list (size in bytes)"
for f in "${FILES[@]}"; do
  size=$(stat -f %z "$f")
  printf "%s\t%s\n" "$size" "$f"
done
echo

# --- 2. details ---------------------------------------------------------------
for f in "${FILES[@]}"; do
  size=$(stat -f %z "$f")
  echo "Filename: $f"
  if (( size <= MAX_SIZE )); then
    cat "$f"
  else
    echo "(file ${size} bytes)"
  fi
  echo
done