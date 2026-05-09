#!/usr/bin/env bash
# migrate-bft-to-registry.sh — R1.3 SOP for switching the COC chain's BFT
# validator source from a hardcoded list (legacy) to ValidatorRegistry-driven
# (Sprint 4 of Phase F+G).
#
# Why this script exists:
#   The legacy `config.validators[]` array is loaded at boot and never
#   changes. ValidatorRegistry exposes the current active set via
#   getActiveValidators() and ValidatorRegistryReader replays
#   ValidatorRegistered/Activated/Deactivated events to keep BFT in sync
#   with on-chain state. Migrating means re-rolling each node with the
#   COC_VALIDATOR_REGISTRY_ADDRESS env var injected (R1.2) and restarting
#   the systemd service.
#
# Why this is risky:
#   If the registry's active set ⊊ hardcoded set OR if some peer nodes
#   restart before others, BFT can lose quorum or two halves of the
#   network can disagree on who's a validator → fork or freeze.
#
#   Worse, the GCP 5-cluster currently shares only 2 EVM identities
#   (anchor-1 = anvil-2, anchor-2 + burst-1/2/3 = anvil-1) — the same
#   keys upstream validators 2 and 3 are using. Enabling BFT under
#   ValidatorRegistry on these nodes would equivocate against upstream.
#   The pre-check below detects this and refuses to apply.
#
# Modes:
#   --dry-run   (default) print what would happen, run pre-check only
#   --apply     execute the migration (only after pre-check + confirmation)
#   --check-only  run pre-check, no rollout plan output
#
# Pre-check (all must pass):
#   1. ValidatorRegistry active count ≥ 3
#   2. The set of (active validator nodeIds) ⊇ {hardcoded upstream validators}
#      (so upstream BFT participants stay in the new set)
#   3. 5 GCP nodes' eth_coinbase ∩ active set is either ∅ (observers stay
#      observers) OR the full coinbase set is in active (all 5 promoted) —
#      no "half in, half out" allowed
#   4. Upstream 3 validator RPCs all reachable
#   5. Chain producing blocks at sane rate (≥ 1 block / 10 s averaged over 30 s)
#
# Rollout (--apply only):
#   Phase 1-5: rolling restart 5 GCP nodes (burst-3 → burst-2 → burst-1
#              → anchor-2 → anchor-1), each with health check between.
#   Phase 6: upstream 3 validators — NOT touched by this script.
#            Operator coordinates separately, see HANDOFF.md.
#   Post-verify: journalctl shows "BFT validator set updated from ValidatorRegistry"
#                on each restarted node.
#
# Rollback (manual): re-render env without --validator-registry-address,
# redeploy. Or SSH into each node and remove the COC_VALIDATOR_REGISTRY_*
# lines from /etc/coc/node-1.env, then `systemctl restart coc-node@1`.

set -o pipefail
# Note: -u disabled because we accumulate counters across the GCP-coinbase
# loop where some refs would be unset before declare. The pre-check logic
# is robust to that without -u; keeping pipefail for the curl|python3 chains.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=/dev/null
. "$SCRIPT_DIR/gcloud/_lib.sh"

MODE="dry-run"
case "${1:-}" in
  --apply)      MODE="apply" ;;
  --check-only) MODE="check-only" ;;
  --dry-run|"") MODE="dry-run" ;;
  *) echo "usage: $0 [--dry-run|--apply|--check-only]" >&2; exit 2 ;;
esac

REGISTRY_FILE="$SCRIPT_DIR/../contracts/deployed-registries-newchain.json"
if [[ ! -f "$REGISTRY_FILE" ]]; then
  echo "ERROR: $REGISTRY_FILE missing" >&2; exit 2
fi

VALIDATOR_REGISTRY_ADDR=$(jq -r '.contracts.ValidatorRegistry.address' "$REGISTRY_FILE")
VALIDATOR_REGISTRY_FROM_BLOCK=$(jq -r '.contracts.ValidatorRegistry.block' "$REGISTRY_FILE")
CHAIN_ID=$(jq -r '.chainId' "$REGISTRY_FILE")

# Hardcoded upstream validator addresses come from config.env's
# COC_UPSTREAM_VALIDATORS (each "ADDR:HOST:P2P:WIRE")
declare -a UPSTREAM_ADDRS=()
declare -a UPSTREAM_RPCS=()
for entry in "${COC_UPSTREAM_VALIDATORS[@]}"; do
  IFS=':' read -r addr host p2p wire <<< "$entry"
  UPSTREAM_ADDRS+=("${addr,,}")
  UPSTREAM_RPCS+=("http://$host:28780")
done

cat <<EOF
==> migrate-bft-to-registry.sh
    Mode:                  $MODE
    chainId:               $CHAIN_ID
    ValidatorRegistry:     $VALIDATOR_REGISTRY_ADDR
    Hardcoded upstream:    ${UPSTREAM_ADDRS[*]}
EOF

# ── Pre-check 1: registry active count ≥ 3 ──────────────────────────────────
echo
echo "==> Pre-check 1: ValidatorRegistry active count"
ACTIVE_OUT=$(node --experimental-strip-types --input-type=module -e "
import { Contract, JsonRpcProvider } from 'ethers'
import { readFile } from 'node:fs/promises'
const { abi } = JSON.parse(await readFile('$SCRIPT_DIR/../contracts/artifacts/contracts-src/governance/ValidatorRegistry.sol/ValidatorRegistry.json','utf-8'))
const p = new JsonRpcProvider('${UPSTREAM_RPCS[0]}')
const reg = new Contract('$VALIDATOR_REGISTRY_ADDR', abi, p)
const active = await reg.getActiveValidators()
console.log('ACTIVE_COUNT=' + active.length)
const ops = []
for (const nid of active) {
  const v = await reg.getValidator(nid)
  ops.push(v.operator.toLowerCase())
}
console.log('OPERATORS=' + ops.join(','))
" 2>&1)
ACTIVE_COUNT=$(echo "$ACTIVE_OUT" | grep -oE 'ACTIVE_COUNT=[0-9]+' | cut -d= -f2)
ACTIVE_OPS=$(echo "$ACTIVE_OUT" | grep -oE 'OPERATORS=.*' | cut -d= -f2-)
echo "    active count: $ACTIVE_COUNT"
echo "    operators:    $ACTIVE_OPS"

PASSED=1
if (( ACTIVE_COUNT < 3 )); then
  echo "    ❌ FAIL: need ≥3 active, have $ACTIVE_COUNT (BFT requires ⌈2N/3⌉ ≥ 2 ⇒ N ≥ 3)"
  PASSED=0
else
  echo "    ✅ PASS"
fi

# ── Pre-check 2: hardcoded upstream ⊆ active set ────────────────────────────
echo
echo "==> Pre-check 2: hardcoded upstream validators ⊆ active set"
MISSING=0
for addr in "${UPSTREAM_ADDRS[@]}"; do
  if [[ ",$ACTIVE_OPS," == *",$addr,"* ]]; then
    echo "    ✅ $addr present"
  else
    echo "    ❌ MISSING: $addr (would lose quorum if migrated)"
    MISSING=1
  fi
done
if (( MISSING > 0 )); then
  PASSED=0
  echo "    ❌ FAIL: hardcoded upstream not ⊆ active; would drop quorum"
fi

# ── Pre-check 3: GCP coinbase 集合 vs active ────────────────────────────────
echo
echo "==> Pre-check 3: GCP node coinbases vs active set"
declare -A COINBASES
for vm_var in COC_ANCHOR_1 COC_ANCHOR_2 COC_BURST_1 COC_BURST_2 COC_BURST_3; do
  name_var="${vm_var}_NAME"; zone_var="${vm_var}_ZONE"
  ip=$(gcloud compute instances describe "${!name_var}" --zone="${!zone_var}" --project="$COC_GCP_PROJECT" --format="value(networkInterfaces[0].accessConfigs[0].natIP)" 2>/dev/null || echo "")
  if [[ -z "$ip" ]]; then
    echo "    ⚠️  ${!name_var} not reachable (assumed offline)"
    continue
  fi
  cb=$(curl -s --max-time 5 -H 'Content-Type: application/json' --data '{"jsonrpc":"2.0","method":"eth_coinbase","params":[],"id":1}' "http://$ip:28780" 2>/dev/null | python3 -c 'import json,sys; print(json.load(sys.stdin).get("result","").lower())' 2>/dev/null)
  COINBASES[${!name_var}]="$cb"
  echo "    ${!name_var}: $cb"
done

# Count GCP nodes whose coinbase is in active set
IN=0; OUT=0
for cb in "${COINBASES[@]}"; do
  if [[ ",$ACTIVE_OPS," == *",$cb,"* ]]; then
    IN=$((IN+1))
  else
    OUT=$((OUT+1))
  fi
done
GCP_TOTAL=${#COINBASES[@]}
echo "    GCP nodes IN active: $IN, OUT: $OUT (total: $GCP_TOTAL)"
if (( IN > 0 && OUT > 0 )); then
  PASSED=0
  echo "    ❌ FAIL: half-in/half-out — some GCP nodes would activate as validators while others stay observer; equivocation risk"
elif (( IN == GCP_TOTAL )); then
  echo "    ✅ PASS: all GCP nodes would be validators (5-of-N quorum)"
elif (( IN == 0 )); then
  echo "    ✅ PASS: all GCP nodes stay observer (registry only seeds remote validator set)"
fi

# Detect shared-private-key hazard (multiple GCP nodes with same coinbase)
declare -A CB_COUNT
for cb in "${COINBASES[@]}"; do
  CB_COUNT[$cb]=$(( ${CB_COUNT[$cb]:-0} + 1 ))
done
SHARED=0
for cb in "${!CB_COUNT[@]}"; do
  if (( CB_COUNT[$cb] > 1 )); then
    echo "    ⚠️  WARN: $cb used by ${CB_COUNT[$cb]} GCP nodes (shared private key)"
    if (( IN > 0 )); then
      SHARED=1
    fi
  fi
done
if (( SHARED > 0 )); then
  PASSED=0
  echo "    ❌ FAIL: GCP nodes share private keys AND would be active validators → equivocation guaranteed"
fi

# ── Pre-check 4: upstream RPCs reachable ────────────────────────────────────
echo
echo "==> Pre-check 4: upstream RPCs reachable"
for rpc in "${UPSTREAM_RPCS[@]}"; do
  bn=$(curl -s --max-time 5 -H 'Content-Type: application/json' --data '{"jsonrpc":"2.0","method":"eth_blockNumber","params":[],"id":1}' "$rpc" 2>/dev/null | python3 -c 'import json,sys; r=json.load(sys.stdin).get("result","0x0"); print(int(r,16))' 2>/dev/null || echo "0")
  if (( bn > 0 )); then
    echo "    ✅ $rpc h=$bn"
  else
    echo "    ❌ $rpc unreachable"
    PASSED=0
  fi
done

# ── Pre-check 5: chain producing blocks ─────────────────────────────────────
echo
echo "==> Pre-check 5: block production rate"
RPC0=${UPSTREAM_RPCS[0]}
H0=$(curl -s --max-time 5 -H 'Content-Type: application/json' --data '{"jsonrpc":"2.0","method":"eth_blockNumber","params":[],"id":1}' "$RPC0" | python3 -c 'import json,sys; print(int(json.load(sys.stdin)["result"],16))')
echo "    h@t0:  $H0"
sleep 30
H1=$(curl -s --max-time 5 -H 'Content-Type: application/json' --data '{"jsonrpc":"2.0","method":"eth_blockNumber","params":[],"id":1}' "$RPC0" | python3 -c 'import json,sys; print(int(json.load(sys.stdin)["result"],16))')
DELTA=$((H1 - H0))
echo "    h@t30: $H1 (Δ=$DELTA blocks in 30s ⇒ $((DELTA*2)) blocks/min)"
if (( DELTA < 3 )); then
  echo "    ❌ FAIL: < 3 blocks in 30 s — chain stalled; do not migrate"
  PASSED=0
else
  echo "    ✅ PASS"
fi

# ── Verdict ─────────────────────────────────────────────────────────────────
echo
echo "================================================================"
if (( PASSED == 1 )); then
  echo "✅ ALL PRE-CHECKS PASSED"
else
  echo "❌ PRE-CHECKS FAILED — do not migrate yet"
  cat <<'EOR'

Recommended remediation paths (pick whichever applies):

  (a) Stake 3+ unique-identity validators into ValidatorRegistry that
      include all hardcoded upstream addresses, BEFORE running migration.
      Each upstream operator must self-stake (we only have anchor-1 +
      anchor-2 stakes from P3-A, missing 0xf39Fd6...).

  (b) Re-deploy the GCP 5 nodes with 5 fresh independent private keys
      (not anvil-1 shared between 4 nodes). Each gets its own observer
      identity. Then stake all 5 into the registry → 8-of-8 quorum
      including upstream.

  (c) Fork off an independent chainId (R1.4) where the GCP 5 nodes are
      the only validators with fresh keys — register all 5, run migration,
      observe H15 fallback. Does not touch the upstream testnet at all.

  (d) Defer until upstream operators coordinate a synchronized roll-out
      (every BFT node must restart together for the migration to be safe).
EOR
  echo "================================================================"
  if [[ "$MODE" == "apply" ]]; then
    echo "REFUSING to apply due to pre-check failure."
  fi
  exit 1
fi

if [[ "$MODE" == "check-only" ]]; then
  echo "(check-only mode — exiting without rollout plan)"
  exit 0
fi

# ── Rollout plan ────────────────────────────────────────────────────────────
cat <<EOR

================================================================
ROLLOUT PLAN (5 GCP nodes, NOT touching upstream)
================================================================
Each step: stop service → edit env → restart → wait 90s → health check

  Step 1: burst-3 (asia-southeast1-c)  — most-distant zone first
  Step 2: burst-2 (us-west1-a)
  Step 3: burst-1 (europe-west1-b)
  Step 4: anchor-2 (asia-east1-a)
  Step 5: anchor-1 (us-central1-a)     — last (anchor-1 is closest to operator)

Health check after each step:
  - eth_blockNumber on the restarted node ≥ height-at-step-start - 5
  - sudo journalctl -u coc-node@1 -n 50 must contain
    "BFT validator set updated from ValidatorRegistry" within 60s
  - Cluster aggregate produce rate stays ≥ 3 blocks / 30 s

If any step's health check fails:
  - Abort: do NOT proceed to the next step
  - Rollback: SSH into the failing node, remove COC_VALIDATOR_REGISTRY_*
    from /etc/coc/node-1.env, restart coc-node@1
  - Prior already-migrated nodes can be left as-is (they keep working
    because ValidatorRegistry active ⊇ hardcoded; they read the same
    set as the unmigrated ones do)

Upstream 3 validators are OUTSIDE this script's blast radius.
Operators of 209.74.64.88 / 159.198.44.136 / 199.192.16.79 must
coordinate their own roll-out using the same per-node procedure.
EOR

if [[ "$MODE" == "dry-run" ]]; then
  cat <<EOR

(dry-run mode — to actually migrate, re-run with --apply.
 Each step is interactive: you'll be asked y/N before stop/start.)
EOR
  exit 0
fi

# ── Apply mode (interactive per-step) ───────────────────────────────────────
read -r -p "Proceed with apply? (yes/no): " confirm
[[ "$confirm" == "yes" ]] || { echo "aborted"; exit 0; }

echo "TODO: apply mode is intentionally not implemented in this iteration."
echo "Use the rollout plan above as a manual SOP. Each step is a single"
echo "30-stop-burst.sh + edit /etc/coc/node-1.env + 31-start-burst.sh"
echo "(or stop/start-anchor.sh for anchors). Wait for health check"
echo "before proceeding. This guard exists to prevent accidental"
echo "automation of an irreversible cluster-wide change."
exit 0
