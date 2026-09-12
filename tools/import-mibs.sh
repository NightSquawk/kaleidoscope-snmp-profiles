#!/usr/bin/env bash
# Copy vendor MIB directories from a local MIB collection into mibs/.
# Usage: tools/import-mibs.sh <source-dir> <vendor> [<vendor> ...]
# Copies <source-dir>/<vendor>/ → mibs/<vendor>/ for each vendor named.
# All regular files are copied (many vendors ship MIBs without an extension);
# the compiler skips READMEs, licences, archives and empty files itself.
set -euo pipefail

if [[ $# -lt 2 ]]; then
  echo "usage: $0 <source-dir> <vendor> [<vendor> ...]" >&2
  exit 2
fi

src=$1; shift
root=$(cd "$(dirname "$0")/.." && pwd)

for vendor in "$@"; do
  from="$src/$vendor"
  to="$root/mibs/$vendor"
  if [[ ! -d "$from" ]]; then
    echo "skip $vendor: $from is not a directory" >&2
    continue
  fi
  mkdir -p "$to"
  rsync -a --prune-empty-dirs \
    --exclude='.*' --exclude='*.zip' --exclude='*.gz' --exclude='*.tgz' --exclude='*.tar' \
    --exclude='*.html' --exclude='*.htm' --exclude='*.pdf' --exclude='*.md' \
    "$from/" "$to/"
  count=$(find "$to" -type f | wc -l)
  echo "$vendor: mibs/$vendor/ now holds $count file(s)"
done

echo "Now run: cd tools && pnpm compile"
