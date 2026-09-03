#!/usr/bin/env bash
# One-time setup: installs this repo's tracked hook scripts (scripts/hooks/*)
# into .git/hooks, since git doesn't version that directory itself. Re-run
# safely any time - it just overwrites with the current tracked version.
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

for hook in "$REPO_DIR"/scripts/hooks/*; do
  name="$(basename "$hook")"
  cp "$hook" "$REPO_DIR/.git/hooks/$name"
  chmod +x "$REPO_DIR/.git/hooks/$name"
  echo "Installed hook: $name"
done
