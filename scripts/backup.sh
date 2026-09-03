#!/usr/bin/env bash
# Local backup snapshot with a rotating 3-slot window - run manually, or
# automatically after every commit via scripts/hooks/post-commit (see
# scripts/install-hooks.sh). Backups live OUTSIDE the repo so they never get
# backed up recursively and never show up in `git status`.
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BACKUP_DIR="${RACE_COMPUTER_BACKUP_DIR:-$HOME/backups/race-computer-app}"
KEEP=3

mkdir -p "$BACKUP_DIR"

timestamp="$(date +%Y%m%d-%H%M%S)"
archive="$BACKUP_DIR/race-computer-app-$timestamp.tar.gz"

# Full snapshot including .git (so a backup can restore complete history, not
# just the working tree), excluding the transient agent-worktree directory.
tar -czf "$archive" \
  --exclude=".claude/worktrees" \
  -C "$(dirname "$REPO_DIR")" \
  "$(basename "$REPO_DIR")"

echo "Backup written: $archive"

# Rotate: keep only the $KEEP most recent archives.
mapfile -t existing < <(ls -1t "$BACKUP_DIR"/race-computer-app-*.tar.gz 2>/dev/null)
if [ "${#existing[@]}" -gt "$KEEP" ]; then
  for old in "${existing[@]:$KEEP}"; do
    echo "Removing old backup: $old"
    rm -f "$old"
  done
fi
