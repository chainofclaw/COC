#!/usr/bin/env bash
# Backup COC node data (LevelDB)
# Usage: bash scripts/backup-node.sh [data_dir] [output_dir]
set -euo pipefail

DATA_DIR="${1:-${COC_DATA_DIR:-$HOME/.clawdbot/coc}}"
OUTPUT_DIR="${2:-./backups}"
RPC_URL="${COC_RPC_URL:-http://127.0.0.1:18780}"

mkdir -p "$OUTPUT_DIR"

# Get current block height via RPC
HEIGHT="unknown"
if command -v curl &>/dev/null; then
  RESP=$(curl -sf -X POST "$RPC_URL" \
    -H "Content-Type: application/json" \
    -d '{"jsonrpc":"2.0","method":"eth_blockNumber","params":[],"id":1}' 2>/dev/null || echo "")
  if [[ -n "$RESP" ]]; then
    HEX=$(echo "$RESP" | grep -o '"result":"0x[0-9a-fA-F]*"' | cut -d'"' -f4)
    if [[ -n "$HEX" ]]; then
      HEIGHT=$((HEX))
    fi
  fi
fi

DATE=$(date -u +%Y%m%d-%H%M%S)
BACKUP_NAME="coc-backup-${DATE}-h${HEIGHT}"
BACKUP_PATH="${OUTPUT_DIR}/${BACKUP_NAME}.tar.gz"

echo "Starting backup..."
echo "  Data dir:  $DATA_DIR"
echo "  Height:    $HEIGHT"
echo "  Output:    $BACKUP_PATH"

# Create tar.gz of the data directory
tar -czf "$BACKUP_PATH" -C "$(dirname "$DATA_DIR")" "$(basename "$DATA_DIR")"

SIZE=$(du -h "$BACKUP_PATH" | cut -f1)
echo ""
echo "Backup complete:"
echo "  File:   $BACKUP_PATH"
echo "  Size:   $SIZE"
echo "  Height: $HEIGHT"
