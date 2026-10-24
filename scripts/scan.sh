#!/usr/bin/env bash
# Runs the two automated reviewers' published commands, unchanged, on a clean export of the repository
# (tracked and new, non-ignored files only: what a reviewer receives), then prints a summary.
#
#   trivy fs --timeout 10m --scanners vuln,secret,misconfig,license --format json --output trivy-results.json .
#   opengrep --config=r/all --exclude-rule=bbp-pattern-inject --json --verbose . > opengrep-results.json
#
# Usage: bash scripts/scan.sh [output-dir]      (needs trivy 0.71.0 and opengrep on PATH, plus git and node)
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="${1:-$ROOT/.scan}"
EXPORT="$OUT/export"
rm -rf "$EXPORT"
mkdir -p "$EXPORT"

cd "$ROOT"
git ls-files -co --exclude-standard -z | while IFS= read -r -d '' f; do
  if [ -f "$f" ]; then
    mkdir -p "$EXPORT/$(dirname "$f")"
    cp "$f" "$EXPORT/$f"
  fi
done
# opengrep only scans git-tracked files, so the export is its own repository.
git -C "$EXPORT" init -q
git -C "$EXPORT" add -A

cd "$EXPORT"
# Locally the cached vulnerability DB is reused (refresh with: trivy image --download-db-only); CI downloads it.
skip_db=(--skip-db-update)
[ -n "${CI:-}" ] && skip_db=()
trivy fs "${skip_db[@]}" --timeout 10m --scanners vuln,secret,misconfig,license --format json --output trivy-results.json .
opengrep --config=r/all --exclude-rule=bbp-pattern-inject --json --verbose . > opengrep-results.json 2> "$OUT/opengrep.log"

node "$ROOT/scripts/scan-summary.mjs" "$EXPORT/trivy-results.json" "$EXPORT/opengrep-results.json"
