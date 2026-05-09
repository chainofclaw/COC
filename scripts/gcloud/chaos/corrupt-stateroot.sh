#!/usr/bin/env bash
# chaos/corrupt-stateroot.sh — Corrupt a single block's stateRoot in leveldb to
# force the snap-sync recovery path (Phase H5 onPersistentDivergence).
#
# What it does:
#   1. Stops coc-node@1 on the target VM
#   2. Picks a recent persisted block
#   3. Overwrites its stateRoot field with a corrupted value
#   4. Restarts coc-node@1
#   5. Watches journalctl for "early peer-quorum divergence" and forceSnapSync
#
# Usage:
#   bash corrupt-stateroot.sh <node-name>
#
# Verification expectation:
#   Within 60s, the node should detect divergence vs peers, trigger snap-sync,
#   and recover ≥3 fresh blocks from upstream.

set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=/dev/null
. "$SCRIPT_DIR/../_lib.sh"
require_gcloud

NODE="${1:-}"
if [[ -z "$NODE" ]]; then
  echo "usage: $0 <node-name>" >&2; exit 2
fi

ZONE="$(resolve_zone "$NODE")"
echo "==> Corrupting stateRoot on $NODE ($ZONE). This will trigger snap-sync."
echo "    The node MUST be already deployed and synced."

gcloud compute ssh "$NODE" --zone="$ZONE" --project="$COC_GCP_PROJECT" --quiet --command='
set -e
sudo systemctl stop coc-node@1
DATA_DIR=/var/lib/coc/node-1
DB="$DATA_DIR/chaindata"
if [[ ! -d "$DB" ]]; then
  echo "ERROR: leveldb dir not found at $DB"
  exit 1
fi

# Use ldb tool from the node node_modules to find a block-header key. Easier:
# corrupt by writing a known-bad blob into the leveldb manifest by appending a
# sentinel stale block-header. Production-realistic version uses Node helper:
sudo node --experimental-strip-types - "$DB" <<NODE_EOF
const { Level } = require("/opt/coc/node_modules/level");
(async () => {
  const db = new Level(process.argv[2], { valueEncoding: "json" });
  await db.open();
  let count = 0;
  for await (const [k, v] of db.iterator({ limit: 10000 })) {
    if (typeof k === "string" && k.startsWith("blocks/") && v && v.stateRoot) {
      const corrupted = "0x" + "de".repeat(32);
      console.log(`Corrupting ${k} stateRoot ${v.stateRoot} -> ${corrupted}`);
      await db.put(k, { ...v, stateRoot: corrupted });
      count++;
      if (count >= 3) break;
    }
  }
  await db.close();
  console.log(`Corrupted ${count} block headers`);
})().catch(e => { console.error(e); process.exit(2); });
NODE_EOF

sudo systemctl start coc-node@1
echo "Restarted. Watch logs: sudo journalctl -u coc-node@1 -f | grep -E \"snap-sync|divergence|forceSnapSync\""
'

echo ""
echo "==> Watch recovery on $NODE:"
echo "    gcloud compute ssh $NODE --zone=$ZONE --command='sudo journalctl -u coc-node@1 -n 200 -f | grep -E \"snap-sync|divergence|forceSnapSync|finalized\"'"
