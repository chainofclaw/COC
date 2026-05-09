#!/usr/bin/env bash
# chaos/pose-roundtrip.sh — Direct exercise of node-side PoSe HTTP endpoints.
#
# What it does:
#   1. POST /pose/challenge to issue a challenge (kind = U|S|R) with a fresh
#      challengeId + nonce
#   2. POST /pose/receipt to retrieve the receipt
#   3. Record latency + HTTP status + signature presence
#
# This does NOT spin up a full challenger/aggregator service. The goal is
# protocol-layer robustness under churn, not full PoSe pipeline.
#
# Usage:
#   bash pose-roundtrip.sh <node-ip> [--kind U|S|R] [--cid <cid>]

set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=/dev/null
. "$SCRIPT_DIR/../_lib.sh"

IP="${1:-}"
KIND="U"
CID=""
shift || true
while [[ $# -gt 0 ]]; do
  case "$1" in
    --kind) KIND="$2"; shift 2 ;;
    --cid)  CID="$2";  shift 2 ;;
    *) shift ;;
  esac
done

if [[ -z "$IP" ]]; then
  echo "usage: $0 <node-ip> [--kind U|S|R] [--cid <cid>]" >&2; exit 2
fi

# Generate fresh 32-byte ids (hex) — the node verifies these against its own
# nonce registry and rejects replays.
CHALLENGE_ID="0x$(openssl rand -hex 32)"
NONCE="0x$(openssl rand -hex 32)"
ISSUED_AT=$(($(date +%s%N) / 1000000))   # ms
DEADLINE_OFFSET=10000                     # 10 s (more permissive than node default for cross-continental RTT)

# Minimal challenge body matching what runtime/coc-node.ts expects:
BODY=$(cat <<EOF
{"challengeId":"$CHALLENGE_ID","kind":"$KIND","nonce":"$NONCE","issuedAtMs":$ISSUED_AT,"deadlineMs":$DEADLINE_OFFSET${CID:+,"cid":"$CID"}}
EOF
)

# Step 1: issue challenge
T0=$(date +%s%N)
CHALLENGE_HTTP=$(curl -sS --max-time 8 -o /tmp/coc-challenge-resp.json -w '%{http_code}' \
  -X POST -H 'Content-Type: application/json' --data "$BODY" \
  "http://$IP:28780/pose/challenge" 2>/dev/null || echo "000")
T1=$(date +%s%N)
CHALLENGE_MS=$(( (T1 - T0) / 1000000 ))

# Step 2: request receipt
T2=$(date +%s%N)
RECEIPT_HTTP=$(curl -sS --max-time 8 -o /tmp/coc-receipt-resp.json -w '%{http_code}' \
  -X POST -H 'Content-Type: application/json' \
  --data "{\"challengeId\":\"$CHALLENGE_ID\"}" \
  "http://$IP:28780/pose/receipt" 2>/dev/null || echo "000")
T3=$(date +%s%N)
RECEIPT_MS=$(( (T3 - T2) / 1000000 ))

# Parse receipt body
RECEIPT_BODY="$(cat /tmp/coc-receipt-resp.json 2>/dev/null || echo '{}')"
HAS_SIG=$(python3 -c "
import sys, json
try:
  r = json.loads(open('/tmp/coc-receipt-resp.json').read())
  print('yes' if r.get('signature') or r.get('sig') or r.get('v2', {}).get('signature') else 'no')
except: print('parse-error')
" 2>/dev/null || echo "parse-error")

printf '{"ip":"%s","kind":"%s","challenge_http":%s,"challenge_ms":%d,"receipt_http":%s,"receipt_ms":%d,"has_sig":"%s","receipt_size":%d}\n' \
  "$IP" "$KIND" "$CHALLENGE_HTTP" "$CHALLENGE_MS" "$RECEIPT_HTTP" "$RECEIPT_MS" "$HAS_SIG" "$(stat -c%s /tmp/coc-receipt-resp.json 2>/dev/null || echo 0)"
