#!/usr/bin/env bash
# Restore COC node data from backup
# Usage: bash scripts/restore-node.sh <backup.tar.gz> [target_dir]
set -euo pipefail

if [[ $# -lt 1 ]]; then
  echo "Usage: $0 <backup.tar.gz> [target_dir]"
  exit 1
fi

BACKUP_FILE="$1"
TARGET_DIR="${2:-${COC_DATA_DIR:-$HOME/.clawdbot/coc}}"

if [[ ! -f "$BACKUP_FILE" ]]; then
  echo "Error: backup file not found: $BACKUP_FILE"
  exit 1
fi

# Verify backup integrity
echo "Verifying backup integrity..."
if ! tar -tzf "$BACKUP_FILE" >/dev/null 2>&1; then
  echo "Error: backup file is corrupted"
  exit 1
fi
echo "  Backup file is valid."

# Check if node is running
if pgrep -f "node.*index.ts" >/dev/null 2>&1; then
  echo "Warning: COC node appears to be running."
  echo "Please stop the node before restoring."
  echo "  e.g.: kill \$(pgrep -f 'node.*index.ts')"
  exit 1
fi

# Clear target and restore
echo "Restoring to: $TARGET_DIR"
rm -rf "$TARGET_DIR"
mkdir -p "$(dirname "$TARGET_DIR")"
tar -xzf "$BACKUP_FILE" -C "$(dirname "$TARGET_DIR")"

echo ""
echo "Restore complete."
echo "  Target: $TARGET_DIR"
echo "  Start the node to resume from the backed-up state."
