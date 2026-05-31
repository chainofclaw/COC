# PoSe v2 pipeline bring-up — Stage B0 runbook

**Status**: 1-node dry-run completed and verified on **obs-1** (2026-05-31).
**Parent doc**: [`audit-upgrade-sprint-2026-05.zh.md`](../audit-upgrade-sprint-2026-05.zh.md) §6.2 Stage B0.
**Companion doc**: [`667-pose-manager-v2.md`](667-pose-manager-v2.md) (Stage A — contract upgrade ceremony).

## Why this runbook

The 88780 testnet's chain layer was upgraded in Stage A (2026-05-26, multisig tx 8/9). Contract-side fixes from PRs #745/#751/#752/#754 are live, but the **PoSe v2 pipeline does not yet run in production** — the 6 production nodes only execute `node/src/index.ts` (the BFT chain engine), not `runtime/coc-node.ts` (the PoSe witness HTTP server) and not `runtime/coc-agent.ts` (the challenger/aggregator). `getActiveNodeCount()` was 0 until this runbook's dry-run.

Stage B0 brings the PoSe v2 pipeline online. It is a prerequisite for:

- Stage B (node strict mode: `COC_POSE_WITNESS_REQUIRE_VERIFIED=true` etc.) — strict mode has no effect until a witness server is actually running.
- Stage F (v1 typehash sunset via `setV1SunsetEpoch`) — sunset is meaningless without v2 traffic.
- G3 / G11 launch gates.

## Architecture at a glance

```
┌─────────────────────────┐    HTTP push    ┌──────────────────────────────┐
│ coc-agent.service       │  POST /pose/    │ coc-pose-witness.service     │
│ (challenger+aggregator) │ ──challenge───► │ (runtime/coc-node.ts, :18780)│
│                         │  POST /pose/    │                              │
│ - 60s tick              │ ──receipt─────► │ - signs receipts (RECEIPT)   │
│ - auto-registers self   │  POST /pose/    │ - verifies pushed receipts   │
│ - aggregates batch      │ ──witness─────► │   then signs WITNESS attest. │
│ - writes pending JSONL  │                 └──────────────────────────────┘
└────────┬────────────────┘
         │ disk (pending-v2.jsonl) + chain (submitBatchV2WithMetadata events)
         ▼
┌─────────────────────────┐    eth_call/sendRawTransaction    
│ coc-relayer.service     │ ─────────────────►  PoSeManagerV2 proxy 0x256eb949…
│ (epoch finalizer)       │  finalizeEpochV2 / processEpochBatches
│ - 60s tick              │  any EOA may finalize (idempotent on-chain)
└─────────────────────────┘
```

## What the dry-run validated (obs-1, 2026-05-31)

| Verification | Result |
|---|---|
| Witness server up on port 18780, **`token-required` mode** (F7 fix live) | `/health` → HTTP 200 |
| Agent systemd unit active and ticking every 60s | active, 7+ ticks no crash |
| `PoSeManagerV2.registerNode` succeeds for anchor-1 | block 485812, tx `0xa1f6d97f29fb433b92c9e4e19ee03101b3ec43b64998fbc1aa8d883e54dbc197` |
| `getActiveNodeCount()` | 0 → **1** |
| `operatorNodeCount(anchor-1)` | 1 |
| Bond paid (progressive: 1st = `MIN_BOND << 0` = `challengeBondMin`) | 0.100 ETH locked (anchor-1: 1.000 → 0.899 ETH; gas 0.000853 ETH) |
| Challenge → receipt flow | `pendingV2` accumulates per tick |
| Batch flush failure mode (expected for 1-node) | `batchV2 skipped: per-receipt witness quorum not met` (signed=0 required=1; `_validateWitnessQuorumV2` requires `(2*m+2)/3` for m active nodes) |

Single-node is intentionally batch-flush-incapable: the on-chain quorum is `⌈2/3 × m⌉` so a 1-of-1 vote rounds up to 1 required signature, and `allowEmptyBatchWitnessSubmission=false` (the secure default; owner-only) keeps anchor-1 from short-circuiting. Multi-node roll-out (§ Roll out) clears this naturally.

## Key gotchas (record before they bite the next operator)

### Gotcha 1: the repo's `docker/systemd/coc-agent.service` silently exits the agent under sandbox

`docker/systemd/coc-agent.service` ships with:

```ini
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=/var/lib/coc /var/log/coc
PrivateTmp=true
```

Symptom: agent enters a crash-restart loop (`code=exited, status=1/FAILURE`) **after** the initial `endpoint fingerprint mode` log line, **before** the first tick. `agent-error.log` is empty (no stderr written). `journalctl` shows nothing but systemd restart spam. The agent **does** call `registerNode` exactly once before the first crash — registration succeeds and is permanent — but it never completes a tick, so it appears to "register-then-die" indefinitely.

Diagnosis: run the agent foreground with the exact same env, and it completes ticks. The differential is the sandbox.

Fix in this runbook: use the **minimal-unit** template below (no sandbox directives). Long-term fix: bisect which directive (`ProtectSystem=strict` is the prime suspect — agent likely writes outside `ReadWritePaths`, possibly `~/.clawdbot/coc/`) and re-enable the rest. Tracked as a separate hardening task.

### Gotcha 2: `COC_DATA_DIR` env from the unit clashes with custom dataDir

`docker/systemd/coc-agent.service` sets `Environment=COC_DATA_DIR=/var/lib/coc/runtime` and `Environment=COC_CONFIG=/etc/coc/runtime-agent.json`. The agent's `loadConfig` then `mkdir`s the dataDir, which fails (EACCES) if your operator created a different path (`/var/lib/coc/pose`). systemd's `EnvironmentFile=` overrides `Environment=`, so set `COC_DATA_DIR` and `COC_CONFIG` in `/etc/coc/coc-agent.env` to win. This runbook does so.

### Gotcha 3: there is no systemd unit for `runtime/coc-node.ts` in the repo

`docker/systemd/coc-node.service` and `coc-node@.service` both launch `node/src/index.ts` (the chain engine), not `runtime/coc-node.ts` (the witness server). Operators must hand-write a new unit (template below) named e.g. `coc-pose-witness.service`. Otherwise the agent has nothing to push challenges to.

### Gotcha 4: anchor-1/anchor-2/burst-1 keys in `~/.coc/keys/` carry 0 ETH

These EOAs are leftover from the 2026-05-10 failed N=5 sprint (per memory). They are present, derivable, but unfunded. Reusing them as PoSe operator keys is fine (clean role separation from chain engine signing keys, fresh start) — just fund them from the deployer EOA.

## Roll out (per-node)

The dry-run pattern repeats for v1/v2/v3/v4/v5. Each per-node cost: **0.1 ETH bond** (locked ≥7 days post-registration via `unlockEpoch = registeredEpoch + 168`) + gas. Total for 5 nodes: **~0.5 ETH**.

### Per-node prerequisites

1. **Operator key**. Pick one of:
   - Reuse an existing key (e.g. anchor-2 for v1, burst-1 for v2, fresh-generate for v3/v4/v5).
   - **DO NOT reuse** the chain engine signing key (`COC_NODE_KEY` from `/etc/coc/node-N.env`). PoSe operator and BFT proposer must be different identities for incident triage.
2. **Funding**. Fund the operator EOA with ≥0.5 ETH from the deployer (`0xB4E943F5…`):
   ```bash
   node -e "
   const { Wallet, JsonRpcProvider, parseEther } = require('ethers');
   (async () => {
     const p = new JsonRpcProvider('http://209.74.64.88:38780');
     const w = new Wallet(process.env.DEPLOYER_PK, p);
     const tx = await w.sendTransaction({ to: '$OPERATOR_ADDR', value: parseEther('1') });
     await tx.wait();
   })();"
   ```
3. **Free port**. Confirm port 18780 (or your choice) is free on the host: `sudo ss -tlnp | grep 18780`. Production hosts use chain RPC on 28780/38780 + wireport 29780 + 28790/28800/28810 internal; 18780 is free (legacy 18780 testnet decommissioned 2026-05-12).

### Files to install per node

**`/etc/systemd/system/coc-pose-witness.service`** (new — repo does not ship this):

```ini
[Unit]
Description=COC PoSe v2 witness HTTP server (88780)
After=network.target coc-node@1.service
Requires=coc-node@1.service

[Service]
Type=simple
User=coc
WorkingDirectory=/opt/coc
ExecStart=/usr/bin/node --experimental-strip-types runtime/coc-node.ts
EnvironmentFile=/etc/coc/coc-pose-witness.env
Restart=on-failure
RestartSec=10
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
```

**`/etc/systemd/system/coc-agent.service`** (override the repo's sandboxed version):

```ini
[Unit]
Description=COC PoSe v2 runtime agent (88780)
After=network.target coc-pose-witness.service
Requires=coc-pose-witness.service

[Service]
Type=simple
User=coc
WorkingDirectory=/opt/coc
ExecStart=/usr/bin/node --experimental-strip-types runtime/coc-agent.ts
EnvironmentFile=/etc/coc/coc-agent.env
Restart=on-failure
RestartSec=10
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
```

**`/etc/coc/coc-pose-witness.env`** (`chmod 600`, `chown coc:coc`):

```bash
COC_NODE_BIND=127.0.0.1
COC_NODE_PORT=18780
COC_CONFIG=/etc/coc/runtime-pose.json
COC_POSE_WITNESS_AUTH_TOKEN=<32-byte hex; same value across nodes if peers will share it>
COC_POSE_WITNESS_REQUIRE_VERIFIED=false   # flip to true after all agents push v2 fields
COC_POSE_REQUIRE_VERIFIED_CHALLENGE=false # flip to true after all challengers ship v2
COC_RPC_URL=http://127.0.0.1:28780        # local chain engine RPC; v1 uses 38780
COC_NODE_KEY=<operator private key hex>
```

**`/etc/coc/coc-agent.env`** (`chmod 600`, `chown coc:coc`):

```bash
COC_DATA_DIR=/var/lib/coc/pose
COC_CONFIG=/etc/coc/runtime-pose.json
COC_OPERATOR_PK=<operator private key hex>
COC_L1_RPC_URL=http://127.0.0.1:28780
COC_NODE_URL=http://127.0.0.1:18780
COC_AGENT_INTERVAL_MS=60000
COC_AGENT_BATCH_SIZE=5
COC_NONCE_REGISTRY_PATH=/var/lib/coc/pose/nonce-registry.json
COC_PENDING_PATH=/var/lib/coc/pose/pending-v1.jsonl
COC_PENDING_V2_PATH=/var/lib/coc/pose/pending-v2.jsonl
```

**`/etc/coc/runtime-pose.json`** (chmod 644, owned coc):

```json
{
  "protocolVersion": 2,
  "chainId": 88780,
  "verifyingContract": "0x256eb949C50d5F2af8699191b1Bc043203263549",
  "poseManagerV2Address": "0x256eb949C50d5F2af8699191b1Bc043203263549",
  "nodeBind": "127.0.0.1",
  "nodePort": 18780,
  "nodeUrl": "http://127.0.0.1:18780",
  "dataDir": "/var/lib/coc/pose",
  "storageDir": "/var/lib/coc/pose/storage",
  "l1RpcUrl": "http://127.0.0.1:28780",
  "l2RpcUrl": "http://127.0.0.1:28780",
  "poseStorageFromBlockstore": false,
  "challengerSet": [],
  "aggregatorSet": [],
  "witnessNodes": [
    {"url": "http://<peer1>:18780", "witnessIndex": 0, "authToken": "<shared token>"},
    {"url": "http://<peer2>:18780", "witnessIndex": 1, "authToken": "<shared token>"}
  ],
  "requiredWitnesses": 4,
  "allowEmptyBatchWitnessSubmission": false,
  "tipToleranceBlocks": 10,
  "agentIntervalMs": 60000,
  "agentBatchSize": 5,
  "agentSampleSize": 2
}
```

Notes on `runtime-pose.json` fields:

- `witnessNodes`: list of **other** nodes the agent will solicit witness signatures from. Empty for 1-node dry-run; full 5-of-6 cross-list for production. Witness indexes 0..31 are slots in the agent's bitmap — assign each peer a stable index.
- `requiredWitnesses`: must be ≥ `⌈2/3 × m⌉` where m is the registered active node count. For 6 nodes ⌈2/3 × 6⌉ = 4.
- `challengerSet` / `aggregatorSet`: if non-empty, role rotates by `epoch % len`. Empty = self-as-both (every agent challenges its own registered nodes and aggregates).
- `nodeBind`: set to `0.0.0.0` if peers will reach this witness server over the public/private network; keep `127.0.0.1` if peers only see this host's witness via a reverse proxy. In either case, set `COC_POSE_WITNESS_TRUSTED_PROXIES` accordingly (see PR #753 / [audit doc §6.1 G3](../audit-upgrade-sprint-2026-05.zh.md#g3-cross-node-witness-collection)).

### Per-node bring-up commands

```bash
# 1. scp files to the host's /tmp/
scp coc-pose-witness.service coc-agent.service coc-pose-witness.env coc-agent.env runtime-pose.json bob@<host>:/tmp/

# 2. install + start (no chain tx yet — witness server is local-only)
ssh bob@<host> 'sudo bash -s' <<'EOF'
mv /tmp/coc-pose-witness.env /etc/coc/coc-pose-witness.env
mv /tmp/coc-agent.env        /etc/coc/coc-agent.env
mv /tmp/runtime-pose.json    /etc/coc/runtime-pose.json
chown coc:coc /etc/coc/coc-pose-witness.env /etc/coc/coc-agent.env /etc/coc/runtime-pose.json
chmod 600    /etc/coc/coc-pose-witness.env /etc/coc/coc-agent.env
chmod 644    /etc/coc/runtime-pose.json
mv /tmp/coc-pose-witness.service /etc/systemd/system/
mv /tmp/coc-agent.service        /etc/systemd/system/
install -d -o coc -g coc /var/lib/coc/pose /var/lib/coc/pose/storage /var/log/coc
systemctl daemon-reload
systemctl start coc-pose-witness
sleep 3
curl -fsS http://127.0.0.1:18780/health   # expect {"ok":true,"ts":…}
EOF

# 3. start coc-agent — THIS TRIGGERS registerNode + 0.1 ETH bond on first tick
ssh bob@<host> 'sudo systemctl start coc-agent'
sleep 30
# Verify on-chain
node -e "
const { Contract, JsonRpcProvider } = require('ethers');
const p = new JsonRpcProvider('http://209.74.64.88:38780');
const c = new Contract('0x256eb949C50d5F2af8699191b1Bc043203263549', [
  'function getActiveNodeCount() view returns (uint256)',
  'function operatorNodeCount(address) view returns (uint8)'
], p);
(async () => {
  console.log('active nodes:', (await c.getActiveNodeCount()).toString());
  console.log('this operator nodes:', (await c.operatorNodeCount('$OPERATOR_ADDR')).toString());
})();"
```

After all 6 nodes:

- `getActiveNodeCount()` should be 6
- `pendingV2` accumulates per agent
- First successful `submitBatchV2WithMetadata` tx appears once an agent reaches `agentBatchSize` AND can collect 4-of-6 witness signatures

### Rollback (if a per-node bring-up goes wrong)

```bash
ssh bob@<host> 'sudo bash -s' <<'EOF'
systemctl stop coc-agent
systemctl stop coc-pose-witness
systemctl disable coc-agent coc-pose-witness
rm -f /etc/systemd/system/coc-agent.service /etc/systemd/system/coc-pose-witness.service
rm -f /etc/coc/coc-agent.env /etc/coc/coc-pose-witness.env /etc/coc/runtime-pose.json
systemctl daemon-reload
EOF
```

**`registerNode` is NOT reversible** (no `unregisterNode` exists). To remove a node, the operator must call `requestUnbond(nodeId)` and wait `UNBOND_DELAY_EPOCHS` (168 hours ≈ 7 days), then `withdraw(nodeId)`. The chain still considers the node active during the wait window.

## Coc-relayer (separate, single instance)

After at least one batch is on-chain (multi-node), bring up exactly one `coc-relayer.service` somewhere (deployer host, or a fresh ops box):

```bash
# /etc/coc/coc-relayer.env
COC_DATA_DIR=/var/lib/coc/pose
COC_CONFIG=/etc/coc/runtime-pose.json
COC_OPERATOR_PK=<dedicated relayer EOA; fund with ~0.2 ETH for gas>
COC_L1_RPC_URL=http://127.0.0.1:28780
COC_RELAYER_INTERVAL_MS=60000
```

systemd unit: same minimal-format template, `ExecStart=/usr/bin/node --experimental-strip-types runtime/coc-relayer.ts`. Multiple relayer instances are safe (idempotent on-chain) but wasteful; one is enough.

## Status verification commands

```bash
# witness server
curl -fsS http://<host>:18780/health
ssh bob@<host> 'sudo systemctl is-active coc-pose-witness'

# agent (look for tick ok + no errors)
ssh bob@<host> 'sudo journalctl -u coc-agent -n 20 --no-pager'

# on-chain
node -e "
const { Contract, JsonRpcProvider } = require('ethers');
const p = new JsonRpcProvider('http://209.74.64.88:38780');
const c = new Contract('0x256eb949C50d5F2af8699191b1Bc043203263549', [
  'function getActiveNodeCount() view returns (uint256)',
  'function challengeBondMin() view returns (uint256)',
  'function v1SunsetEpoch() view returns (uint64)'
], p);
(async () => {
  console.log('active nodes:', (await c.getActiveNodeCount()).toString());
  console.log('bond min ETH:', Number(await c.challengeBondMin()) / 1e18);
  console.log('v1 sunset epoch:', (await c.v1SunsetEpoch()).toString());
})();"
```

## When Stage B0 is "done"

- `getActiveNodeCount() == 6`
- All 6 agents log `tick ok` every 60s without errors
- At least one `submitBatchV2WithMetadata` tx appears on-chain (proves witness quorum collection works end-to-end)
- One `coc-relayer.service` running somewhere

Once done, Stage B (`COC_POSE_WITNESS_REQUIRE_VERIFIED=true` on every node) and Stage F (`setV1SunsetEpoch(<current+24>)` via multisig) become meaningful and can proceed.

## References

- [`667-pose-manager-v2.md`](667-pose-manager-v2.md) — Stage A contract upgrade runbook
- [`../audit-upgrade-sprint-2026-05.zh.md`](../audit-upgrade-sprint-2026-05.zh.md) §6.2 — sprint-level launch plan
- Contract: `contracts/contracts-src/settlement/PoSeManagerV2.sol`
- Runtime entries: `runtime/coc-node.ts`, `runtime/coc-agent.ts`, `runtime/coc-relayer.ts`
- Existing (sandboxed, broken) units: `docker/systemd/coc-agent.service`, `docker/systemd/coc-relayer.service`

## Document metadata

- Created: 2026-05-31
- Author: dry-run on obs-1 (Stage B0.3)
- Maintenance: update the on-chain verification table when Stage B0.4 (roll-out 5 nodes) and B0.5 (start relayer) complete
