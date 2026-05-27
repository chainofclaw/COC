# Become a 88780 Validator (External Operators)

> Read first: [`public-endpoints-88780.md`](./public-endpoints-88780.md) for
> the network's chainId / RPC / contract addresses. This doc is the
> step-by-step procedure to put a new validator into the active BFT set
> from scratch.

[中文版](./external-validator-onboarding.zh.md)

## Who this is for

Operators outside the founding team who want to run a 88780 validator.
Adding a validator on 88780 is **permissionless**: any 32-COC stake on
the `ValidatorRegistry` contract gets you into the active BFT set within
one poll cycle (~60s) — no manual coordination with existing operators.

If you are a core-team operator running an internal validator, see
[`validator-registry-reader-enablement-88780.md`](./validator-registry-reader-enablement-88780.md)
instead — that doc covers the node-side reader configuration and the
multisig-coordinated bootstrap.

## What you need before starting

| Resource | Detail |
|----------|--------|
| **Node hardware** | 4 cores / 16 GB RAM / 250 GB SSD minimum (8/32/500 recommended for canary headroom). Public IP with stable DNS or static IP |
| **Network** | TCP 28780 (RPC) + 29780 (wire P2P) reachable from peers; 18781 (WebSocket optional). Outbound to other validators on the same ports |
| **OS** | Linux (Ubuntu 22.04+ tested); systemd; Node.js 22+ for the chain engine |
| **32 COC stake** | Hard requirement (`MIN_STAKE` in `ValidatorRegistry`). Plus a few extra COC for gas. Get via faucet (capped at 10 COC/24h) or buy/borrow OTC during canary; mainnet TGE will introduce a market |
| **Validator signing key** | A fresh secp256k1 keypair. **Do not reuse** a wallet key — slashes burn this key's stake and you don't want the same key in MetaMask |

## Step 0 — Generate the validator signing key

```bash
mkdir -p ~/.coc/keys
node -e '
  const { Wallet } = require("ethers");
  const w = Wallet.createRandom();
  // pubkey is 65-byte uncompressed (0x04 || X || Y); nodeId is
  // keccak256(pubkey[1:65]). Both required for the stake() call.
  const { keccak256 } = require("ethers");
  const pubkey = w.signingKey.publicKey;
  const nodeId = keccak256("0x" + pubkey.slice(4));
  const fs = require("fs");
  fs.writeFileSync(process.env.HOME + "/.coc/keys/validator.json", JSON.stringify({
    address: w.address,
    privateKey: w.privateKey,
    publicKey: pubkey,
    nodeId: nodeId,
  }, null, 2));
  console.log("validator addr:", w.address);
  console.log("nodeId:       ", nodeId);
'
chmod 600 ~/.coc/keys/validator.json
```

**Critical**: back up `validator.json` securely. Losing this key forfeits
your stake — you'll have to `requestUnstake()` from the key you DO still
have, wait 14 days, then `withdrawStake()`. If you lose ALL access to the
signing key, the stake is locked forever (no social recovery yet).

## Step 1 — Pre-fund the signing-key EOA

The signing-key EOA needs ≥ 32 COC for the stake transaction plus a small
gas buffer. The faucet caps at 10 COC/24h per address — so:

```bash
# Approach 1: pre-fund from an existing wallet (preferred for adults)
# Send 32.1 COC from your funded wallet to the address from Step 0.

# Approach 2: hit faucet 4 times over 4 days (only viable for testing)
for i in 1 2 3 4; do
  curl -X POST https://faucet.chainofclaw.io/faucet/request \
    -H 'content-type: application/json' \
    -d "{\"address\":\"$(jq -r .address ~/.coc/keys/validator.json)\"}"
  echo "  ...wait 24h, repeat"
done
```

Verify balance:

```bash
ADDR=$(jq -r .address ~/.coc/keys/validator.json)
curl -s https://rpc.chainofclaw.io \
  -H 'content-type: application/json' \
  -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"eth_getBalance\",\"params\":[\"$ADDR\",\"latest\"]}" \
  | jq -r .result \
  | xargs -I{} node -e "console.log(parseInt('{}',16)/1e18, 'COC')"
# Expect: ≥ 32.1
```

## Step 2 — Stand up the node

Follow [`operations-manual.en.md`](./operations-manual.en.md) for the
full node bringup. Quick summary:

```bash
# Clone + install
git clone https://github.com/chainofclaw/COC.git ~/coc && cd ~/coc
npm install  # workspace install

# Config — minimum viable
cat > /etc/coc/node-1.json <<EOF
{
  "chainId": 88780,
  "nodeId": "$(jq -r .nodeId ~/.coc/keys/validator.json)",
  "enableBft": true,
  "enableWireProtocol": true,
  "dataDir": "/var/lib/coc/node-1",
  "validators": [
    "0xde4e7889aa9007318ff261b1ee675f1305153590",
    "0xdefc8430388093fdfacb0a929fedc14d2e631d19",
    "0xcc64096600c1759d7aaea91166837a5873175867",
    "0x5e773c9359a6bb416bdfffe0c9aac9f568bd11ae",
    "0x919a0fd04d9ed960c9e26379aa18f11457e9e3e8",
    "0xb939e5a68abd2e000e78876bd86edd1cbba49eb9"
  ],
  "peers": [
    {"id": "0xde4e7889aa9007318ff261b1ee675f1305153590", "url": "http://209.74.64.88:39780"},
    {"id": "0xdefc8430388093fdfacb0a929fedc14d2e631d19", "url": "http://199.192.16.79:29780"},
    {"id": "0xcc64096600c1759d7aaea91166837a5873175867", "url": "http://159.198.36.3:29780"},
    {"id": "0x5e773c9359a6bb416bdfffe0c9aac9f568bd11ae", "url": "http://159.198.36.25:29780"},
    {"id": "0x919a0fd04d9ed960c9e26379aa18f11457e9e3e8", "url": "http://34.139.57.20:29780"},
    {"id": "0xb939e5a68abd2e000e78876bd86edd1cbba49eb9", "url": "http://159.198.44.136:29780"}
  ]
}
EOF

# Env — point at the ValidatorRegistry so the reader picks up your stake
cat > /etc/coc/node-1.env <<EOF
COC_NODE_KEY=$(jq -r .privateKey ~/.coc/keys/validator.json)
COC_VALIDATOR_REGISTRY_ADDRESS=0x4441299c118373fDC96bE1983d42C79e19CDb4F0
COC_NODE_CONFIG=/etc/coc/node-1.json
COC_DATA_DIR=/var/lib/coc/node-1
EOF
chmod 600 /etc/coc/node-1.env

# systemd unit + start
systemctl enable --now coc-node@1
journalctl -u coc-node@1 -f
```

Wait for snap-sync to finish:

```
[INFO][consensus] snap sync complete
[INFO][persistent-engine] applyBlock phase ... height: <current_head> phase: done
```

Your node now mirrors the chain but is **not yet a validator** — the
`validators` config bootstraps you as a non-voting observer. The next
step makes you a real validator on-chain.

## Step 3 — Stake into ValidatorRegistry

This single transaction puts you into the active BFT set:

```bash
node -e '
  const { Wallet, JsonRpcProvider, parseEther, Contract } = require("ethers");
  const fs = require("fs");
  const k = JSON.parse(fs.readFileSync(process.env.HOME + "/.coc/keys/validator.json"));

  const RPC = "https://rpc.chainofclaw.io";
  const REGISTRY = "0x4441299c118373fDC96bE1983d42C79e19CDb4F0";
  const ABI = ["function stake(bytes32 nodeId, bytes pubkeyNode) external payable"];

  (async () => {
    const p = new JsonRpcProvider(RPC);
    const w = new Wallet(k.privateKey, p);
    const c = new Contract(REGISTRY, ABI, w);

    console.log("staking from:", w.address);
    console.log("nodeId:     ", k.nodeId);
    const tx = await c.stake(k.nodeId, k.publicKey, { value: parseEther("32") });
    console.log("tx hash:    ", tx.hash);
    const r = await tx.wait();
    console.log("mined block:", r.blockNumber, "status:", r.status);
  })();
'
```

Expected output:
```
staking from: 0x<your_signer_addr>
nodeId:       0x<your_nodeId>
tx hash:      0x<stake_tx>
mined block:  <N>  status: 1
```

If the tx reverts with:
- `InsufficientBond` — fund the signer EOA up to 32 COC and retry
- `InvalidNodeId` — your `nodeId` doesn't match `keccak256(pubkey[1:])`; regenerate via Step 0
- `AlreadyRegistered` — this `nodeId` is already in the registry (either you've staked before, or someone else used the same nodeId — virtually impossible with random key gen)
- `ValidatorSetFull` — all 21 slots taken. Wait for an active validator to `requestUnstake()`, or watch for them to be slashed out

## Step 4 — Verify BFT inclusion

Within one poll cycle (~60s default; the existing validators have their
`ValidatorRegistryReader` polling at this rate), every existing node
sees the `ValidatorRegistered` event and the reader updates BFT:

```bash
# Expected log on YOUR node:
journalctl -u coc-node@1 -n 100 --no-pager | grep -E "reader initialized|validator set updated"
# Should show:
#   [INFO][validator-registry-reader] reader initialized
#     activeCount: 7  (was 6 before your stake)
#   [INFO][node] BFT validator set updated from ValidatorRegistry
#     count: 7  ids: [..., 0x<your_nodeId_lowercased_trailing_20B>]
```

Cross-verify by polling any existing validator's RPC:

```bash
# Public RPC reads through to the cluster
curl -s https://rpc.chainofclaw.io \
  -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"coc_getBftStatus"}' | jq .
# Look at result.validators — should include your address
```

Within a few BFT rounds (so within a couple of minutes), your node should
start signing prepare/commit messages and your `coc_getBftStatus` shows
`prepareVotes` / `commitVotes` incrementing.

## Step 5 — Run

Validator life:

- **Monitoring**: hit your node's `/metrics` (port 9100) for Prometheus.
  Key metrics: `coc_block_height` (must keep up with peers, gap > 5 blocks
  sustained = problem), `coc_bft_round_phase`, `coc_validator_active`
- **Rewards**: PoSe v2 emission lands on your nodeId after each finalized
  epoch (currently dormant on 88780 — emission turn-on is a separate
  governance event). Track via `PoSeManagerV2.pendingWithdrawals(yourAddr)`
- **Don't double-sign**: `EquivocationDetector` watches for two signed
  prepare/commit messages at the same height with different blockHashes.
  A single equivocation event slashes 10% of your stake. The most common
  cause is running two nodes with the same signing key — never do this.
  Backup-restore drills must shut down the primary before bringing up
  the secondary
- **Software updates**: when a new node release lands, follow the rolling
  pattern — at most one validator down at a time (chaos T2 showed that
  two simultaneously down + dead-proposer-slot stalls the chain ~2.5min)

## Step 6 — Voluntary exit

When you want to stop running a validator:

```bash
node -e '
  const { Wallet, JsonRpcProvider, Contract } = require("ethers");
  const fs = require("fs");
  const k = JSON.parse(fs.readFileSync(process.env.HOME + "/.coc/keys/validator.json"));
  const ABI = ["function requestUnstake(bytes32 nodeId) external"];
  (async () => {
    const w = new Wallet(k.privateKey, new JsonRpcProvider("https://rpc.chainofclaw.io"));
    const c = new Contract("0x4441299c118373fDC96bE1983d42C79e19CDb4F0", ABI, w);
    const tx = await c.requestUnstake(k.nodeId);
    console.log("unstake-request tx:", tx.hash);
    await tx.wait();
    console.log("done — wait 14 days before withdrawStake()");
  })();
'
```

You exit the active BFT set immediately on `requestUnstake()`. Stake
remains held by the contract for 14 days (`UNSTAKE_LOCKUP`) — this window
exists so any equivocation evidence emerging after your exit can still
slash you.

After 14 days, withdraw:

```bash
node -e '
  /* same boilerplate as above, but */
  const ABI = ["function withdrawStake(bytes32 nodeId) external"];
  /* c.withdrawStake(k.nodeId) ... */
'
```

You can decommission the node anytime after `requestUnstake()`. Keep the
signing key around until after `withdrawStake()` succeeds — and ideally
forever, in case slash evidence emerges that lets the operator community
verify the legitimate exit.

## Troubleshooting

| Symptom | Likely cause | Fix |
|---------|-------------|-----|
| `stake()` reverts with `InsufficientBond` | Signer EOA < 32 COC | Fund 32.1 COC and retry |
| Node syncs but `coc_getBftStatus` shows you not voting | Reader hasn't picked up stake event | Check node log for `reader initialized` line; confirm `COC_VALIDATOR_REGISTRY_ADDRESS` env is set; wait one more poll cycle |
| Wire-peer connection refused from other validators | Firewall on port 29780 (or 39780 for v1) | Open inbound TCP port matching `wirePort` in config |
| Node falls behind 5+ blocks sustained | Hardware/network too weak | See chaos memory `coc-88780-2026-05-26-chaos-engineering-T1-T8.md` § T1 — at minimum: 4 cores, decent network round-trip to other validators |
| Got slashed unexpectedly | Equivocation — most likely two nodes signed same height | Stop ALL instances using this signing key. File a public issue with the EquivocationDetector event log + your operational story |

For anything not in this table, post on
<https://github.com/chainofclaw/COC/discussions> with your validator
address (NOT your private key) and `journalctl -u coc-node@1 -n 500`.

## See also

- [`public-endpoints-88780.md`](./public-endpoints-88780.md) — chainId, RPC, contract addresses
- [`validator-registry-reader-enablement-88780.md`](./validator-registry-reader-enablement-88780.md) — node-side reader internals
- [`operations-manual.en.md`](./operations-manual.en.md) — full node deployment
- [`operator-runbook.md`](./operator-runbook.md) — slashing response, governance participation
- [`disaster-recovery-88780.md`](./disaster-recovery-88780.md) — when things go wrong
- [`SECURITY.md`](../SECURITY.md) — vulnerability disclosure
