# ValidatorRegistryReader Enablement on 88780 — Operations SOP

**Status (2026-05-27):** Reader code is implemented, wired, and unit-tested
(11 cases pass). 88780 nodes do **not** yet have the reader active — they're
running with the static `validators` config. This document is the
operational runbook for activating the reader, which is the core of Phase A
"external validator onboarding" work in the [canary launch plan](../home/bob/.claude/plans/applyblock-delightful-hennessy.md).

## What the reader does

The reader (`runtime/lib/validator-registry-reader.ts`) mirrors the on-chain
`ValidatorRegistry` proxy (`0x4441299c118373fDC96bE1983d42C79e19CDb4F0` on
88780) into the node's BFT coordinator. Without it, the BFT validator set is
hardcoded at startup and external operators who stake 32 ETH via
`ValidatorRegistry.stake()` are **silently ignored** until each running node
manually restarts with edited config — breaking the permissionless promise.

After activation, this becomes the canonical flow for adding/removing
validators:

1. Operator calls `ValidatorRegistry.stake(nodeId, pubkeyNode)` from their
   signing-key wallet with `msg.value = 32 ETH`
2. Contract emits `ValidatorRegistered` event
3. Within `pollIntervalMs` (default 60s), every node's reader sees the event,
   updates its local active set, and pushes it into the BFT coordinator via
   `consensus.onValidatorSetChange(next)` (PR-1B path)
4. From the next BFT round onward, the new validator participates in
   prepare/commit quorum

## Pre-flight: 6 current validators must register on-chain

The reader's `seedFromContractState()` reads `ValidatorRegistry.getActiveValidators()`.
Today that returns an empty array because the current 6 validators were
hardcoded into config, not staked on-chain. If we enable the reader against
an empty registry, the index.ts wiring falls back to the static config
(`if (active.length === 0)` → keep fallback), so the reader is harmless. But
it's also useless until we migrate the 6 to be on-chain registered.

### Step 1 — each validator operator runs the staking transaction

For each validator host, the operator (with the validator's signing key in
`~/.coc/keys/`) executes:

```bash
# On the operator's workstation, NOT on the validator node directly.
# Signing key for validator-i lives in their ~/.coc/keys/ — never check in.
node -e '
const { Wallet, JsonRpcProvider, parseEther, Contract } = require("ethers");
const fs = require("fs");

// Validator signing key — operator-specific.
const SIGN_KEY = fs.readFileSync(process.env.SIGN_KEY_PATH, "utf-8").trim();
const PUBKEY   = process.env.PUBKEY;   // 65 B 0x04-prefixed, derive from SIGN_KEY
const NODE_ID  = process.env.NODE_ID;  // keccak256(pubkey[1:65])

const RPC = "http://209.74.64.88:38780";  // any healthy 88780 RPC
const REG = "0x4441299c118373fDC96bE1983d42C79e19CDb4F0";  // ValidatorRegistry proxy
const REG_ABI = ["function stake(bytes32 nodeId, bytes pubkeyNode) external payable"];

(async () => {
  const p = new JsonRpcProvider(RPC);
  const w = new Wallet(SIGN_KEY, p);
  const c = new Contract(REG, REG_ABI, w);
  const tx = await c.stake(NODE_ID, PUBKEY, { value: parseEther("32") });
  console.log("stake tx:", tx.hash);
  const r = await tx.wait();
  console.log("mined:", r.blockNumber, "status:", r.status);
})();
'
```

Each operator needs to know:
- **Signing key** — their validator's private key (already in use for BFT signing)
- **Pubkey** — derivable from signing key as 65-byte uncompressed secp256k1 (`0x04 || X || Y`)
- **NodeId** — `keccak256(pubkey[1:65])`. Already consistent with how the node has been signing BFT messages (per `node/src/crypto/signer.ts`)

⚠ **Funding**: each validator's signing-key EOA needs ≥ 32 ETH at the time
of staking. Validators on 88780 likely don't have this on their signing-key
EOA today (rewards have accumulated to operator addresses, not signing
addresses). **Pre-fund 32.1 ETH** (extra for gas) from the deployer EOA to
each signing-key EOA before staking.

Verify pre-staking:
```bash
# For each validator's signing addr <V>, expect 32.1+ ETH:
curl -s http://209.74.64.88:38780 -H 'content-type:application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"eth_getBalance","params":["<V>","latest"]}' \
  | jq -r '.result' | xargs -I{} python3 -c "print(int('{}', 16)/1e18, 'ETH')"
```

Verify post-staking:
```bash
# ValidatorRegistry.activeValidatorCount() should equal 6:
curl -s http://209.74.64.88:38780 -H 'content-type:application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"eth_call",
       "params":[{"to":"0x4441299c118373fDC96bE1983d42C79e19CDb4F0",
                  "data":"0x<selector for activeValidatorCount()>"},"latest"]}' \
  | jq .result
# Expected: "0x0000000000000000000000000000000000000000000000000000000000000006"
```

## Step 2 — enable the reader on each node

Once the 6 validators are on-chain registered, add the env var to each
node's `coc-node@*.env` file:

```ini
# /etc/coc/node-<N>.env
COC_VALIDATOR_REGISTRY_ADDRESS=0x4441299c118373fDC96bE1983d42C79e19CDb4F0
# Optional — defaults to http://127.0.0.1:<rpcPort>
COC_VALIDATOR_REGISTRY_RPC_URL=http://127.0.0.1:38780
# Optional — defaults to 60_000ms
# COC_VALIDATOR_REGISTRY_POLL_INTERVAL_MS=60000
```

(There's no `validatorRegistryAddress` field in the existing JSON config;
the env var is the canonical entry point. See `node/src/config.ts:566`.)

## Step 3 — rolling restart, one validator at a time

**Critical**: per chaos test T2, restarting 2+ validators in parallel risks
H15 fallback stall. **Restart one at a time, validate, then proceed.**

For each validator host (one at a time, in order v1, v3, v4, v5, obs-1, v2):

```bash
# Edit env file on the host
ssh -i ~/.ssh/openclaw_server_key root@<host> '
  echo "COC_VALIDATOR_REGISTRY_ADDRESS=0x4441299c118373fDC96bE1983d42C79e19CDb4F0" >> /etc/coc/node-<unit>.env
  systemctl restart coc-node@<unit>
'

# Wait for the new node to rejoin BFT (~30s) before doing the next.
# Verify: probe RPC eth_blockNumber + check log for "reader initialized" line.
ssh -i ~/.ssh/openclaw_server_key root@<host> \
  'journalctl -u coc-node@<unit> -n 100 --no-pager | grep "reader initialized\|BFT validator set updated"'
```

Expected log lines after restart:
```
[INFO][validator-registry-reader] reader initialized
  address: 0x4441299c118373fDC96bE1983d42C79e19CDb4F0
  activeCount: 6
  lastScannedBlock: <current head>

[INFO][node] BFT validator set updated from ValidatorRegistry
  count: 6
  ids: [<6 validator IDs in sorted order>]
```

If `activeCount` is < 6 or the BFT set update doesn't fire: roll back the
env var, restart that node, investigate. **Do not proceed to the next node**
until the current one's reader is healthy.

## Step 4 — end-to-end verification (7th validator dry-run)

Once all 6 nodes have the reader active:

1. **Generate a fresh keypair**:
   ```bash
   node -e 'const {Wallet}=require("ethers"); const w=Wallet.createRandom();
            console.log(JSON.stringify({addr:w.address, pk:w.privateKey, pubkey:w.signingKey.publicKey}))'
   ```

2. **Fund 32.1 ETH** from deployer or faucet (whichever has 32+ ETH balance).

3. **Stake** via the same script template as Step 1.

4. **Verify within 60s** (one poll cycle) — each node's log must show:
   ```
   [INFO][validator-registry-reader] reader initialized OR scan tick added
   [INFO][node] BFT validator set updated from ValidatorRegistry
     count: 7
     ids: [..., <new validator id>]
   ```

5. **Verify on-chain BFT participation** — query each node's RPC for
   `coc_validatorSet()` (or `eth_call ValidatorRegistry.getActiveValidators()`).
   Both should report 7.

6. **Block production** — chain continues at ~2-3s/block with the new
   validator in the prepare/commit rotation.

7. **Cleanup** — operator calls `requestUnstake()` then `withdrawStake()`
   after 14d UNSTAKE_LOCKUP. Reader removes the validator from active set on
   the deactivation event.

## Rollback procedure

If the reader misbehaves (e.g. emits add/remove events with wrong IDs, or
the BFT coordinator rejects the set), roll back per node:

```bash
# Remove the env var line
ssh root@<host> '
  sed -i "/COC_VALIDATOR_REGISTRY_ADDRESS/d" /etc/coc/node-<unit>.env
  systemctl restart coc-node@<unit>
'
```

The reader sidecar (`<dataDir>/validator-registry-reader.state.json`) is
safe to leave — it'll just be ignored when the env var is absent. Delete it
if you suspect corruption (`rm <dataDir>/validator-registry-reader.state.json`).

The hardcoded `validators` config in each node's JSON remains the safety
net: even with the reader enabled, an empty active set from the registry
falls back to the static config (index.ts:1043 `if (active.length === 0) ...`).

## Verification commands (cheat sheet)

```bash
# 1. Reader sidecar exists + cursor advanced:
ssh root@<host> 'cat /var/lib/coc/node-<unit>/validator-registry-reader.state.json'
# Expected: {"lastScannedBlock":"<current head>"}

# 2. Most recent reader scan tick + active set on this node:
ssh root@<host> 'journalctl -u coc-node@<unit> -n 200 --no-pager \
  | grep -E "reader initialized|validator set updated|scan tick failed" \
  | tail -10'

# 3. On-chain active validator count (any RPC):
curl -s http://209.74.64.88:38780 -H 'content-type:application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"eth_call",
       "params":[{"to":"0x4441299c118373fDC96bE1983d42C79e19CDb4F0",
                  "data":"0x69d76d09"},"latest"]}'
# selector 0x69d76d09 = activeValidatorCount() ; result is 32-byte hex int.

# 4. BFT round currently running with the new set:
curl -s http://209.74.64.88:38780 -H 'content-type:application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"coc_getBftStatus"}'
# Look at `validators` field — should match the on-chain active set.
```

## References

- Reader implementation: `runtime/lib/validator-registry-reader.ts`
- Reader unit tests (11 cases): `runtime/lib/validator-registry-reader.test.ts`
- Wiring + retry logic: `node/src/index.ts:1027-1118`
- BFT update path: `node/src/consensus.ts:992-995` (`onValidatorSetChange`)
- ValidatorRegistry contract: `contracts/contracts-src/governance/ValidatorRegistry.sol`
- ValidatorRegistry proxy: `0x4441299c118373fDC96bE1983d42C79e19CDb4F0`
  (from `configs/deployed-contracts-88780.json`)
- Canary readiness plan: `/home/bob/.claude/plans/applyblock-delightful-hennessy.md`
  § A.1.1
