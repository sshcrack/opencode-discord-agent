#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUTPUT="${1:-/tmp/opencode-discord.zip}"

cd "$REPO_ROOT"

git ls-files --cached --others --exclude-standard | zip -q "$OUTPUT" -@

echo "Created $OUTPUT from all non-gitignored files"
