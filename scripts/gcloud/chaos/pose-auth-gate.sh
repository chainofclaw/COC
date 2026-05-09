#!/usr/bin/env bash
# chaos/pose-auth-gate.sh — Validate the PoSe enforce-mode auth gate at the
# node /pose/* HTTP endpoints (28780). Does NOT require knowing any node's
# private key — instead generates throwaway secp256k1 keys locally and
# probes the gate's response codes for each branch:
#
#   1. no _auth envelope        → 401 "missing auth envelope"
#   2. malformed _auth shape    → 401 "invalid auth envelope fields"
#   3. clock skew >  threshold  → 401 "auth timestamp out of range"
#   4. wrong signature          → 401 "invalid auth signature"
#   5. valid sig + unknown sender → 401 (unknown sender) or 403 "challenger not allowed"
#   6. nonce replay             → 401 "auth nonce replay detected"
#
# This proves enforce mode rejects all illegitimate paths cleanly while the
# /pose/status GET (no auth) stays reachable, i.e. the protocol layer is
# auth-gated, not silently broken.
#
# Usage:
#   bash pose-auth-gate.sh [--ip <node-ip>]
#
# Defaults: probes anchor-1 IP from gcloud.

set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=/dev/null
. "$SCRIPT_DIR/../_lib.sh"

NODE_IP=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --ip) NODE_IP="$2"; shift 2 ;;
    *) shift ;;
  esac
done

if [[ -z "$NODE_IP" ]]; then
  NODE_IP=$(gcloud compute instances describe "$COC_ANCHOR_1_NAME" \
    --zone="$COC_ANCHOR_1_ZONE" --project="$COC_GCP_PROJECT" \
    --format="value(networkInterfaces[0].accessConfigs[0].natIP)" 2>/dev/null || echo "")
fi
[[ -z "$NODE_IP" ]] && { echo "no node IP resolved"; exit 2; }

URL="http://$NODE_IP:28780"
PATH_REQ="/pose/challenge"

echo "==> Probing $URL$PATH_REQ"
echo

# Helper: post a JSON body, capture HTTP code + body
post() {
  local body="$1"
  curl -sS --max-time 5 -o /tmp/coc-pose-auth-gate-resp.json \
    -w '%{http_code}' \
    -X POST -H 'Content-Type: application/json' \
    --data "$body" "$URL$PATH_REQ" 2>/dev/null || echo "000"
}

# ---- 1. /pose/status sanity (no auth required) ----
echo "[1] GET /pose/status (no auth) — expect 200"
STATUS_HTTP=$(curl -sS --max-time 5 -o /tmp/coc-status.json -w '%{http_code}' "$URL/pose/status")
echo "    HTTP $STATUS_HTTP body: $(cat /tmp/coc-status.json)"
[[ "$STATUS_HTTP" == "200" ]] || echo "    ❌ status endpoint not reachable"
echo

# ---- 2. Missing _auth envelope ----
echo "[2] POST without _auth — expect 401 'missing auth envelope'"
HTTP=$(post '{"nodeId":"0x0000000000000000000000000000000000000000000000000000000000000001"}')
echo "    HTTP $HTTP body: $(cat /tmp/coc-pose-auth-gate-resp.json)"
echo

# ---- 3. Malformed _auth (missing fields) ----
echo "[3] POST with empty _auth — expect 401 'invalid auth envelope fields'"
HTTP=$(post '{"nodeId":"0x0000000000000000000000000000000000000000000000000000000000000001","_auth":{}}')
echo "    HTTP $HTTP body: $(cat /tmp/coc-pose-auth-gate-resp.json)"
echo

# ---- 4. Clock skew too large ----
# Need a real signature for this branch — the gate checks timestamp BEFORE signature.
# Generate ephemeral private key + matching auth fields, set timestampMs = 0.
GEN_SCRIPT='
const { Wallet, hashMessage, keccak256, toBeHex } = require("ethers");
const crypto = require("crypto");
const args = JSON.parse(process.env.AUTH_ARGS);
const w = new Wallet(args.privKey);
const senderId = w.address.toLowerCase();
const path = args.path;
const nonce = args.nonce || crypto.randomUUID();
const ts = args.timestampMs;
const payload = args.payload || {};

// stable stringify (matches pose-http.ts stableStringify)
function stable(v, depth=0, seen) {
  if (depth > 64) throw new Error("too deep");
  if (typeof v === "bigint") return JSON.stringify(v.toString());
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  const tracker = seen || new WeakSet();
  if (tracker.has(v)) throw new Error("cycle");
  tracker.add(v);
  if (Array.isArray(v)) return "[" + v.map(x => stable(x, depth+1, tracker)).join(",") + "]";
  const keys = Object.keys(v).filter(k => k !== "__proto__" && k !== "constructor" && k !== "prototype").sort();
  return "{" + keys.map(k => JSON.stringify(k) + ":" + stable(v[k], depth+1, tracker)).join(",") + "}";
}

const payloadStr = stable(payload);
const payloadHash = keccak256(Buffer.from(payloadStr, "utf8"));
const message = `pose:http:${path}:${senderId}:${ts}:${nonce}:${payloadHash}`;

(async () => {
  const sig = await w.signMessage(message);
  const tampered = args.tamperSig ? sig.replace(/.$/, "0") : sig;
  const out = { ...payload, _auth: { senderId, timestampMs: ts, nonce, signature: tampered }};
  process.stdout.write(JSON.stringify(out));
})();
'

# Persist ephemeral private key for the run
PRIVKEY=$(node -e 'const {Wallet} = require("ethers"); console.log(Wallet.createRandom().privateKey)' 2>/dev/null \
  || (cd /passinger/projects/ClawdBot/COC && node -e 'const {Wallet} = require("ethers"); console.log(Wallet.createRandom().privateKey)'))

mkbody() {
  AUTH_ARGS="$1" node -e "$GEN_SCRIPT" 2>/dev/null \
    || (cd /passinger/projects/ClawdBot/COC && AUTH_ARGS="$1" node -e "$GEN_SCRIPT")
}

# Build skewed-timestamp signed body — use a plausible past timestamp far
# beyond the 120s default skew tolerance so the gate's skew branch fires
# (timestampMs<=0 lands earlier in the "invalid envelope fields" branch).
NID="0x0000000000000000000000000000000000000000000000000000000000000001"
SKEW_TS=$(( ( $(date +%s) - 3600 ) * 1000 ))
SKEW_BODY=$(mkbody "$(printf '{"privKey":"%s","path":"%s","timestampMs":%d,"payload":{"nodeId":"%s"}}' "$PRIVKEY" "$PATH_REQ" "$SKEW_TS" "$NID")")
echo "[4] POST with timestampMs 1h ago (skew>>120s) — expect 401 'auth timestamp out of range'"
HTTP=$(post "$SKEW_BODY")
echo "    HTTP $HTTP body: $(cat /tmp/coc-pose-auth-gate-resp.json)"
echo

# ---- 5. Tampered signature (last hex digit flipped) ----
NOW_MS=$(($(date +%s) * 1000))
TAMP_BODY=$(mkbody "$(printf '{"privKey":"%s","path":"%s","timestampMs":%d,"payload":{"nodeId":"%s"},"tamperSig":true}' "$PRIVKEY" "$PATH_REQ" "$NOW_MS" "$NID")")
echo "[5] POST with tampered signature — expect 401 'invalid auth signature'"
HTTP=$(post "$TAMP_BODY")
echo "    HTTP $HTTP body: $(cat /tmp/coc-pose-auth-gate-resp.json)"
echo

# ---- 6. Valid sig but ephemeral sender (not registered as operator) ----
NOW_MS=$(($(date +%s) * 1000))
NONCE_OK=$(node -e 'console.log(require("crypto").randomUUID())' 2>/dev/null || cat /proc/sys/kernel/random/uuid)
VALID_BODY=$(mkbody "$(printf '{"privKey":"%s","path":"%s","timestampMs":%d,"nonce":"%s","payload":{"nodeId":"%s"}}' "$PRIVKEY" "$PATH_REQ" "$NOW_MS" "$NONCE_OK" "$NID")")
echo "[6] POST with valid sig + unregistered challenger — expect 403 'challenger not allowed' OR 200 if allowlist empty"
HTTP=$(post "$VALID_BODY")
echo "    HTTP $HTTP body: $(cat /tmp/coc-pose-auth-gate-resp.json)"
echo

# ---- 7. Replay: send same _auth again, nonce should be tracked now ----
echo "[7] POST same body again (nonce replay) — expect 401 'auth nonce replay detected'"
HTTP=$(post "$VALID_BODY")
echo "    HTTP $HTTP body: $(cat /tmp/coc-pose-auth-gate-resp.json)"
echo

echo "==> Done. Inspect outputs above. Each line shows the gate branch + actual response."
