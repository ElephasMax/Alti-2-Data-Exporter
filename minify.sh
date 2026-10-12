#!/usr/bin/env bash
# Minify the web page's JavaScript into js/export.min.js (the file index.html loads).
# Requires esbuild: brew install esbuild (or npm install -g esbuild).
set -euo pipefail

cd "$(dirname "$0")"

SRC="${1:-js/export_YWl1ZW.js}"
OUT="js/export.min.js"

if ! command -v esbuild >/dev/null 2>&1; then
  echo "esbuild not found. Install it with: brew install esbuild" >&2
  exit 1
fi

if [ ! -f "$SRC" ]; then
  echo "Source file not found: $SRC" >&2
  exit 1
fi

esbuild "$SRC" --minify --outfile="$OUT"
