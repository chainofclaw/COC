#!/usr/bin/env bash
# deploy-rolling-safe.sh <target-sha> — rolling deploy to the 5 prod
# validators with a BFT-rejoin gate between each node.
#
# Root cause this guards against (2026-05-16 incident): the plain rolling
# script only waited for the restarted validator's block HEIGHT to catch up,
# then moved on. But "height synced" ≠ "rejoined BFT as a proposer". When the
# proposer rotation landed on the just-restarted (not-yet-ready) validator,
# it could not propose and the whole chain stalled ~10 min until the Phase
# H15 fallback override fired.
#
# Fix: after restarting each validator, GATE 2 verifies the *network* chain
# tip keeps advancing — i.e. BFT is healthy WITH this validator back in the
# set — before touching the next one. If the tip stops, the deploy ABORTS
# rather than cascading the stall by restarting the next validator too.
#
# Usage:  bash scripts/deploy-rolling-safe.sh <target-sha>
set -u

TARGET="${1:-}"
[ -z "$TARGET" ] && { echo "usage: $0 <target-sha>"; exit 2; }

SSH_KEY="${COC_SSH_KEY:-$HOME/.ssh/openclaw_server_key}"
RPC=https://clawchain.io/api/testnet/rpc
SYNC_GRACE=180        # GATE 1: max wait for restarted node to catch up
                      # (a cold COC node boot — state load + replay — can
                      #  take 60-90s before RPC even answers; 120s left too
                      #  little headroom and false-aborted a healthy v3 on
                      #  the 2026-05-16 deploy)
BFT_GATE_TIMEOUT=150  # GATE 2: max wait for network tip to resume advancing
BFT_MIN_ADVANCE=5     # GATE 2: blocks the network tip must climb post-restart
SETTLE=20             # grace after a node passes both gates

# name:host:unit:rpc_port
validators=(
  "v1:209.74.64.88:coc-node@88:38780"
  "v2:159.198.44.136:coc-node@1:28780"
  "v3:199.192.16.79:coc-node@88:28780"
  "v4:159.198.36.3:coc-node@1:28780"
  "v5:159.198.36.25:coc-node@1:28780"
)

netTip() {
  curl -sk --max-time 8 "$RPC" -H 'content-type:application/json' \
    -d '{"jsonrpc":"2.0","id":1,"method":"eth_blockNumber"}' \
    | python3 -c "import json,sys; print(int(json.load(sys.stdin)['result'],16))" 2>/dev/null
}

for entry in "${validators[@]}"; do
  IFS=':' read -r name host unit port <<< "$entry"
  echo "=========================================="
  echo "[$name@$host → $unit] deploying $TARGET"
  echo "=========================================="

  pre_tip=$(netTip)
  echo "[$name] pre-restart network tip: ${pre_tip:-ERR}"

  ssh -o ConnectTimeout=10 -i "$SSH_KEY" root@"$host" bash -s <<EOF
set -e
git config --global --add safe.directory /opt/coc 2>/dev/null || true
cd /opt/coc
git fetch origin main --quiet
git checkout -f $TARGET --quiet
git rev-parse --short HEAD | sed "s/^/[$name] HEAD: /"
systemctl restart $unit
sleep 3
systemctl is-active $unit | sed "s/^/[$name] status: /"
EOF
  rc=$?
  if [ $rc -ne 0 ]; then
    echo "[$name] ABORT — ssh/restart failed (rc=$rc)"
    exit 1
  fi

  # ---- GATE 1: restarted node catches up to where the chain was ----
  echo "[$name] GATE 1: local height >= $pre_tip ..."
  g1_deadline=$(( $(date +%s) + SYNC_GRACE ))
  g1_ok=0
  while [ $(date +%s) -lt $g1_deadline ]; do
    h=$(ssh -o ConnectTimeout=5 -i "$SSH_KEY" root@"$host" \
      "curl -s --max-time 3 http://127.0.0.1:$port -H 'content-type:application/json' -d '{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"eth_blockNumber\"}' | python3 -c \"import json,sys; print(int(json.load(sys.stdin)['result'],16))\" 2>/dev/null" 2>/dev/null)
    if [ -n "$h" ] && [ -n "$pre_tip" ] && [ "$h" -ge "$pre_tip" ]; then
      echo "[$name] GATE 1 OK — local height $h"
      g1_ok=1; break
    fi
    echo "[$name]   local=${h:-?} need>=$pre_tip"
    sleep 4
  done
  if [ $g1_ok -ne 1 ]; then
    echo "[$name] ABORT — GATE 1 timeout: node did not catch up in ${SYNC_GRACE}s"
    exit 1
  fi

  # ---- GATE 2: network tip keeps advancing (BFT healthy with node back) ----
  gate_base=$(netTip)
  target_advance=$(( ${gate_base:-0} + BFT_MIN_ADVANCE ))
  echo "[$name] GATE 2: network tip must reach $target_advance (base $gate_base + $BFT_MIN_ADVANCE) ..."
  g2_deadline=$(( $(date +%s) + BFT_GATE_TIMEOUT ))
  g2_ok=0
  while [ $(date +%s) -lt $g2_deadline ]; do
    t=$(netTip)
    if [ -n "$t" ] && [ "$t" -ge "$target_advance" ]; then
      echo "[$name] GATE 2 OK — network tip advanced to $t (BFT healthy)"
      g2_ok=1; break
    fi
    echo "[$name]   net tip=${t:-?} need>=$target_advance"
    sleep 6
  done
  if [ $g2_ok -ne 1 ]; then
    echo "[$name] ABORT — GATE 2 timeout: network tip stalled after $name restart."
    echo "[$name] Chain may be in a proposer stall. NOT restarting the next"
    echo "[$name] validator. Investigate before continuing."
    exit 1
  fi

  echo "[$name] DONE — both gates passed. Settling ${SETTLE}s."
  sleep $SETTLE
done

echo "=========================================="
echo "All 5 validators upgraded to $TARGET — every node passed GATE 1 (sync)"
echo "+ GATE 2 (BFT liveness). No proposer stall cascaded."
echo "=========================================="
