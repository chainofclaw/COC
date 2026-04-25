# COC Testnet Current Status (2026-04-24)

> Snapshot of the COC testnet configuration after Phase C Step 2 completed on **2026-04-24**.
> Chinese version: `testnet-status-2026-04-24.zh.md`.

## 1. Version Summary

| Item | Status |
|---|---|
| Is the testnet running the latest version? | **✅ Yes.** All validators / agent / relayer / provers run `coc-runtime:phase-c-step2` or `coc-node:phase-c-step1` |
| Phase progress | Phase C **Step 2 fully deployed**; PoSe v2 end-to-end pipeline verified |
| Current git commit | `e9207ab` (feat(coc-node): v2 EIP-712 signing for Storage + Relay receipts) |
| Branch | `fix/phase-c-p2p-storage` |
| Milestone tag | `phase-c-step2-batchv2-success-2026-04-24` |
| Chain height at check time | 12 247, all 3 validators in sync |
| BFT quorum | ✅ Healthy, all 3 validators at same height |
| On-chain `submitBatchV2` | ✅ Succeeded (tx `0xebe72a05...d15`, status=1, gasUsed=319 344) |

## 2. Infrastructure

### 2.1 Server

| Property | Value |
|---|---|
| Hostname | `server1.clawchain.io` |
| Public IP | `199.192.16.79` |
| OS | Debian 12 (cloud) |
| Disk | 237 G total, ~199 G free |
| SSH config alias | `coc-testnet` |
| Source path | `/root/clawd/COC` |

### 2.2 Running Containers

12 containers, grouped by role:

```
┌─ Consensus layer (BFT validators) ─────────────────────────────┐
│  coc-node-1    coc-node:phase-c-step1    (healthy)            │
│  coc-node-2    coc-node:phase-c-step1    (healthy)            │
│  coc-node-3    coc-node:phase-c-step1    (healthy)            │
└────────────────────────────────────────────────────────────────┘

┌─ Read-only observer (sync-node) ───────────────────────────────┐
│  coc-sync-node    coc-node:fix-speculative-disable (OLD)      │
│    ⚠ Still on Phase B image. As a non-producing observer      │
│      it does not affect BFT, but should be upgraded to        │
│      phase-c-step1 at the next maintenance window.             │
└────────────────────────────────────────────────────────────────┘

┌─ PoSe v2 prover layer ─────────────────────────────────────────┐
│  coc-prover-1    coc-runtime:phase-c-step2  (serves :19901)   │
│  coc-prover-2    coc-runtime:phase-c-step2  (serves :19902)   │
│  coc-prover-3    coc-runtime:phase-c-step2  (serves :19903)   │
│    Each prover shares the corresponding validator's           │
│    blockstore (docker volume node{N}-data, read-write).       │
└────────────────────────────────────────────────────────────────┘

┌─ PoSe v2 coordination layer ───────────────────────────────────┐
│  coc-agent       coc-runtime:phase-c-step2                    │
│    challenger + aggregator; 30s tick; runs the full           │
│    challenge→receipt→verify→batch→submitBatchV2 pipeline.     │
│  coc-relayer     coc-runtime:phase-c-step2                    │
│    epoch finalization, reward distribution, slash triggers.   │
└────────────────────────────────────────────────────────────────┘

┌─ Auxiliary services ───────────────────────────────────────────┐
│  coc-explorer    ghcr.io/chainofclaw/coc-explorer:latest      │
│    Next.js block explorer (127.0.0.1:3000)                    │
│  coc-faucet      ghcr.io/chainofclaw/coc-faucet:latest        │
│    Faucet (0.0.0.0:3003)                                      │
│  openclaw-1      ghcr.io/openclaw/openclaw:latest             │
│    OpenClaw agent runtime (independent of COC).               │
└────────────────────────────────────────────────────────────────┘
```

## 3. Network Port Mapping

### 3.1 Externally accessible (bound to `0.0.0.0`)

| Service | Host port | Container port | Purpose |
|---|---|---|---|
| node-1 RPC | `28780` | 18780 | JSON-RPC (primary entry) |
| node-1 WS | `28781` | 18781 | WebSocket RPC / eth_subscribe |
| node-1 P2P | `29780` | 19780 | HTTP gossip (peer discovery) |
| node-1 Wire | `29781` | 19781 | Binary wire protocol (FindNode / BlockRequest) |
| node-2 RPC | `28782` | — | Same pattern as node-1 |
| node-2 WS | `28783` | — | |
| node-2 P2P | `29782` | — | |
| node-2 Wire | `29783` | — | |
| node-3 RPC | `28784` | — | |
| node-3 WS | `28785` | — | |
| node-3 P2P | `29784` | — | |
| node-3 Wire | `29785` | — | |
| **node-1 IPFS HTTP** | **`28786`** | **5001** | **Added 2026-04-25**: UnixFS `/api/v0/add`, `/api/v0/cat`, `/ipfs/<cid>` gateway for external testing. ⚠️ **No auth, no rate limit** — testnet only. |
| sync-node RPC | `18780` | — | Read-only aggregating RPC (public entry) |
| sync-node WS | `18781` | — | |
| Explorer | `3000` | 3000 | Next.js dev server (127.0.0.1 only) |
| Faucet | `3003` | 3003 | Faucet UI + API |
| Prometheus | `9101-9104` | 9100 | Per-node Prometheus endpoint |

### 3.2 Container-only (`coc-rpc` docker network)

| Service | Intra-container address | Purpose |
|---|---|---|
| prover-1/2/3 | `prover-N:18800` | PoSe challenge/receipt handling |
| agent metrics | `agent:9200` | Runtime internal metrics |
| node-2/3 IPFS | `node-N:5001` | IPFS HTTP API; container-only. node-1 is exposed via host port 28786 |

✅ **Since 2026-04-25, node-1's IPFS HTTP is publicly accessible** at `http://199.192.16.79:28786`. External clients can directly PUT/GET:
```bash
# Upload
curl -X POST http://199.192.16.79:28786/api/v0/add -F file=@somefile.bin

# Download
curl http://199.192.16.79:28786/api/v0/cat?arg=<CID>
```
⚠️ **node-2/3 are still container-only at port 5001**. Node-1 is the sole public IPFS entry; uploads automatically replicate to the other two via push-to-K + DHT gossip.

## 4. Chain Parameters

| Parameter | Value |
|---|---|
| chainId | **18780** |
| block time | 3 000 ms |
| finality depth | 3 blocks |
| max TX per block | 100 |
| BFT prepare/commit timeout | 5 000 ms / 5 000 ms |
| PoSe epoch | 3 600 s (1 hour) |
| Validator count | 3 |
| Consensus | BFT-lite (≥2/3 stake quorum) |

### 4.1 Validators

| Node | Validator address | Key source | PoSe NodeID (= keccak256(pubkey)) | Balance |
|---|---|---|---|---|
| node-1 | `0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266` | Hardhat acct #0 | `0x7b8c787b0e5055300f13733856377c0b855c204ae32ed48dffddc1e059076f04` | 9 980.89 ETH |
| node-2 | `0x70997970C51812dc3A010C7d01b50e0d17dc79C8` | Hardhat acct #1 | `0xb8fdf03c6b15dfd781c47a20474745a4ee69d8e1ef92aa886cb57e7ed0906d88` | 1.98 ETH |
| node-3 | `0x3c44CdDdB6a900fa2b585dd299e03d12FA4293BC` | Hardhat acct #2 | `0x86fc22d816900e3d25ac919122d6e59e1289bb0e199d8742b662266364a94c3d` | 1.98 ETH |

### 4.2 PoSe Operator (challenger + agent key)

| Property | Value |
|---|---|
| Address | `0x0fC876c0b47575cFa81de526C1ac0E7b5b6b427a` |
| Balance | 9.99 ETH (covers operator bond + days of gas) |
| Role | Signing account for agent / relayer txs; registered as a standalone PoSe challenger node |

## 5. On-chain Contracts (PoSe v2 + Governance)

**Deployer**: `0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266` (node-1's key)
**Deploy time**: 2026-04-24 08:04 UTC

| Contract | Address | Bytecode size | Init status |
|---|---|---|---|
| `PoSeManagerV2` | `0xCD8a1C3ba11CF5ECfa6267617243239504a98d90` | 36 514 | **✅ Initialized** (chainId=18780, verifyingContract=self, challengeBondMin=0.02 ETH) |
| `CidRegistry` | `0xb7278A61aa25c888815aFC32Ad3cC52fF24fE575` | 4 186 | No init needed; currently 3 CIDs registered |
| `SoulRegistry` | `0x1291Be112d480055DaFd8a610b7d1e203891C274` | 30 228 | Deployed, not in use |
| `DIDRegistry` | `0x5f3f1dBD7B74C6B46e8c44f98792A1dAf8d69154` | 21 164 | Deployed, not in use |

### 5.1 PoSeManagerV2 Domain

```
DOMAIN_SEPARATOR  = 0x210c4104e22518643cd21d46997d1921ad8ecd0475c5df0fda8e3a975a6af1e1
domain.name       = "COCPoSe"
domain.version    = "2"
chainId           = 18780
verifyingContract = 0xCD8a1C3ba11CF5ECfa6267617243239504a98d90
challengeBondMin  = 0.02 ETH
```

⚠️ **Deployment gotcha (hit on 2026-04-24)**:
The contract's constructor takes no parameters, but `DOMAIN_SEPARATOR` is set only inside `initialize(chainId, verifyingContract, challengeBondMin)`. If the Hardhat deploy script doesn't call `initialize`, the contract is half-initialized (`DOMAIN_SEPARATOR=0x0000...`). All witness-quorum signatures then fail EIP-712 domain match and `submitBatchV2` reverts. **`initialize` MUST be called post-deploy.**

### 5.2 Registered PoSe v2 Nodes

| NodeID | Operator (who called registerNode) |
|---|---|
| `0xd306e71dc0a8554f...225f1d52` | `0x0fC876c0...6b427a` (agent self-register) |
| `0x7b8c787b0e505530...059076f04` | `0xf39Fd6e5...92266` (node-1) |
| `0xb8fdf03c6b15dfd7...0906d88` | `0x70997970...79C8` (node-2) |
| `0x86fc22d816900e3d...64a94c3d` | `0x3c44CdDd...4293BC` (node-3) |

### 5.3 Registered CIDs (CidRegistry)

Count: **3**. Test files uploaded during Phase C verification (IPFS CIDv1 `bafybe...`).

## 6. Docker Image Versions

| Image | Tag | ImageID | Purpose |
|---|---|---|---|
| `coc-node` | `phase-c-step1` | `73edf1d790cb` | Chain engine (validators + sync-node) |
| `coc-runtime` | `phase-c-step2` | `fb7901d588a1` | Agent / relayer / prover sidecar |
| `coc-node` | `ghcr.io/chainofclaw/coc-node:latest` | (alias of above) | Compose fallback |
| `coc-runtime` | `ghcr.io/chainofclaw/coc-runtime:latest` | (alias of above) | Compose fallback |

Rollback images (last stable Phase B):
- `coc-node:fix-speculative-disable` (`4b432901742c`) — still in use by sync-node

## 7. Configuration Files

### 7.1 Validator Config (`docker/testnet-configs/node-{1,2,3}.json`)

Key fields (only `nodeId` and `peers` differ per node):
```json
{
  "nodeId": "<validator address>",
  "chainId": 18780,
  "rpcBind": "0.0.0.0",
  "rpcPort": 18780,
  "p2pBind": "0.0.0.0",
  "p2pPort": 19780,
  "wsBind": "0.0.0.0",
  "wsPort": 18781,
  "ipfsBind": "0.0.0.0",
  "wireBind": "0.0.0.0",
  "wirePort": 19781,
  "validators": [
    "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266",
    "0x70997970c51812dc3a010c7d01b50e0d17dc79c8",
    "0x3c44cdddb6a900fa2b585dd299e03d12fa4293bc"
  ],
  "peers":            [ /* P2P URLs of the other two validators */ ],
  "dhtBootstrapPeers":[ /* wire ports of the other two validators */ ],
  "enableBft": true,
  "enableWireProtocol": true,
  "enableDht": true,
  "enableSnapSync": true,
  "blockTimeMs": 3000,
  "finalityDepth": 3,
  "maxTxPerBlock": 100
}
```

### 7.2 Agent Config (`docker/testnet-runtime-configs/agent.json`)

```json
{
  "dataDir": "/data/coc/runtime",
  "storageDir": "/shared-blockstore/storage",
  "nodeUrl": "http://node-1:18780",
  "l1RpcUrl": "http://node-1:18780",
  "l2RpcUrl": "http://node-1:18780",
  "chainId": 18780,
  "protocolVersion": 2,
  "poseManagerAddress": "0xCD8a1C3ba11CF5ECfa6267617243239504a98d90",
  "poseManagerV2Address": "0xCD8a1C3ba11CF5ECfa6267617243239504a98d90",
  "verifyingContract": "0xCD8a1C3ba11CF5ECfa6267617243239504a98d90",
  "cidRegistryAddress": "0xb7278A61aa25c888815aFC32Ad3cC52fF24fE575",
  "poseStorageFromBlockstore": true,
  "nodeEndpoints": {
    "0x7b8c787b...076f04": "http://prover-1:18800",
    "0xb8fdf03c...906d88": "http://prover-2:18800",
    "0x86fc22d8...a94c3d": "http://prover-3:18800"
  },
  "agentIntervalMs": 30000,
  "agentBatchSize": 5,
  "agentSampleSize": 2,
  "agentMetricsPort": 9200
}
```

**Environment variables**:
- `COC_OPERATOR_PK = 0x8b3a350cf5c34c9194ca3a545d6546d9f8b66d0f6937f33ce3cbb7a7e3c7eca0` (operator private key)

### 7.3 Prover Config (`docker/testnet-runtime-configs/provers/node-{1,2,3}.json`)

Same across all three provers; only the injected key differs:
```json
{
  "dataDir": "/data/coc",
  "storageDir": "/data/coc/storage",
  "nodeBind": "0.0.0.0",
  "nodePort": 18800,
  "chainId": 18780,
  "protocolVersion": 2,
  "poseManagerV2Address": "0xCD8a1C3ba11CF5ECfa6267617243239504a98d90",
  "verifyingContract": "0xCD8a1C3ba11CF5ECfa6267617243239504a98d90",
  "poseStorageFromBlockstore": true
}
```

**Environment variables per prover**:
- `COC_CONFIG = /app/config.json`
- `COC_NODE_PK = <validator private key>` (each prover holds its corresponding validator's key)
- `COC_RPC_URL = http://node-N:18780` (critical: prover needs to query the validator's RPC for chain tip)

**Volume mount**:
- `docker_node{N}-data:/data/coc` (read-write, shares the validator's blockstore)

### 7.4 Relayer Config

Same `chainId`, `poseManagerV2Address`, and `verifyingContract` as the agent.
- `COC_SLASHER_PK = 0xdbda1821b80551c171720b42e0ca60ef6d611f8c6e3853e54af5d3f8ef500c4c`

## 8. Docker Volumes

| Volume | Size | Purpose |
|---|---|---|
| `docker_node1-data` | 21 MB | node-1 chain state + IPFS blockstore |
| `docker_node2-data` | 13 MB | node-2 |
| `docker_node3-data` | 13 MB | node-3 |
| `docker_sync-data` | 4 MB | sync-node snapshot |
| `docker_runtime-data` | 8 KB | Agent / relayer state (pending receipts, nonce log) |

## 9. Backup & Rollback

### 9.1 Established backups

`/root/phase-c-rollback.20260424-094001/`
```
-rw-r--r-- 3.3M node1-data.tar.gz
-rw-r--r-- 3.3M node2-data.tar.gz
-rw-r--r-- 3.3M node3-data.tar.gz
```
Node state snapshots taken immediately before Phase C went live.

`/root/clawd/COC.phase-b-stable.20260424-094001/`
Full Phase B source tree snapshot.

`/root/clawd/COC/docker/docker-compose.testnet.yml.pre-phase-c.20260424-094001`
`/root/clawd/COC/docker/testnet-configs.pre-phase-c.20260424-094001/`
Pre-Phase-C compose + config copies.

### 9.2 Rollback procedure

If Phase C develops a severe issue during soak, revert to Phase B:

```bash
# 1. Stop services
cd /root/clawd/COC/docker && docker compose -f docker-compose.testnet.yml down agent relayer

# 2. Restore the Phase B image (still in the local registry)
sed -i "s|coc-node:phase-c-step1|coc-node:fix-speculative-disable|" docker-compose.testnet.yml

# 3. Optional: restore volume data
for n in 1 2 3; do
  docker run --rm -v docker_node${n}-data:/data -v /root/phase-c-rollback.20260424-094001:/b alpine sh -c "rm -rf /data/* && tar xzf /b/node${n}-data.tar.gz -C /data"
done

# 4. Restart
docker compose -f docker-compose.testnet.yml up -d node-1 node-2 node-3
```

Source-side rollback:
```bash
cd /root/clawd/COC
git checkout phase-b-stable-2026-04-24
# Then rebuild the image
docker build -f docker/Dockerfile.node -t coc-node:rollback .
```

### 9.3 Key Git Tags (all pushed to `origin` NGPlateform/COC)

| Tag | Meaning |
|---|---|
| `phase-b-stable-2026-04-24` | **Rollback baseline** — last stable pre-Phase-C |
| `phase-c-candidate-2026-04-24` | Phase C PR first push |
| `phase-c-testnet-verified-2026-04-24` | Storage distribution working |
| `phase-c-gossip-verified-2026-04-24` | Cross-node DHT gossip working |
| `phase-c-step2-bootstrapped-2026-04-24` | PoSe v2 infrastructure in place |
| `phase-c-step2-provers-2026-04-24` | 3 prover sidecars deployed |
| `phase-c-step2-verified-2026-04-24` | Full challenge→verify chain passing |
| **`phase-c-step2-batchv2-success-2026-04-24`** | **Current** — batchV2 on-chain status=1 |

## 10. Access & Common Operations

### 10.1 SSH to the testnet

```bash
ssh coc-testnet   # uses the alias in ~/.ssh/config
```

### 10.2 Check chain height

```bash
for n in 1 2 3; do
  port=$((28780 + (n-1)*2))
  bn=$(curl -s -X POST "http://199.192.16.79:$port" -H content-type:application/json \
    -d '{"jsonrpc":"2.0","method":"eth_blockNumber","id":1}' \
    | python3 -c "import sys,json; print(int(json.load(sys.stdin)['result'],16))")
  echo "node-$n: $bn"
done
```

### 10.3 Check PoSe v2 state

```bash
ssh coc-testnet 'cd /root/clawd/COC/contracts && node --experimental-strip-types --input-type=module <<JS
import { JsonRpcProvider, Contract } from "ethers"
const p = new JsonRpcProvider("http://127.0.0.1:28780")
const c = new Contract("0xCD8a1C3ba11CF5ECfa6267617243239504a98d90", [
  "function getActiveNodeCount() view returns (uint256)",
  "function DOMAIN_SEPARATOR() view returns (bytes32)",
], p)
console.log("active nodes:", (await c.getActiveNodeCount()).toString())
console.log("domain_separator:", await c.DOMAIN_SEPARATOR())
JS'
```

### 10.4 Log inspection

```bash
ssh coc-testnet 'docker logs --tail 50 coc-agent 2>&1 | grep -iE "batchV2|tick ok|verify"'
ssh coc-testnet 'docker logs --tail 50 coc-relayer'
ssh coc-testnet 'docker logs --tail 50 coc-prover-1'
```

### 10.5 PUT/GET test files via IPFS

**External direct (recommended, available since 2026-04-25)**:
```bash
# Upload
head -c 4096 /dev/urandom > /tmp/t.bin
curl -sf -X POST http://199.192.16.79:28786/api/v0/add -F file=@/tmp/t.bin
# → {"Name":"t.bin","Hash":"bafybe...","Size":"4096"}

# Download (note 50 MiB readFile cap)
curl -sf "http://199.192.16.79:28786/api/v0/cat?arg=<CID>" -o out.bin
```

**Container-internal (legacy path; also for node-2/3)**:
```bash
ssh coc-testnet 'docker exec coc-node-1 sh -c "head -c 4096 /dev/urandom > /tmp/t.bin && curl -sf -X POST http://localhost:5001/api/v0/add -F file=@/tmp/t.bin"'
```

### 10.6 Explorer / Faucet URLs

- Explorer (local HTTP): `http://199.192.16.79:3000` if exposed via reverse proxy, otherwise `ssh -L 3000:127.0.0.1:3000 coc-testnet` for local forwarding.
- Faucet: `http://199.192.16.79:3003`

## 11. Known Issues & Next Steps

### 11.1 Phase C remnants (all defer to the next phase)

| Issue | Impact | Priority |
|---|---|---|
| `coc-sync-node` still on Phase B image | No functional impact; observer doesn't produce blocks | Low |
| Storage challenges skip in `pickRandomChallengeTarget` | Agent can't resolve Merkle meta from the shared blockstore (path convention mismatch). Uptime/Relay already pass | Medium |
| HTTP `/api/v0/add` does not auto-call `CidRegistry.register()` | Operators must manually register CIDs on-chain before the challenger can challenge them | Medium |
| `reward manifest write failed (EACCES)` | Permission issue on `/data/coc/runtime/reward-manifests` inside the agent container | Low, only affects local backup |
| Relayer reward-claim path not end-to-end verified | `submitBatchV2` succeeds on-chain, but `claimRewards` pipeline has not yet cycled once | Medium |

### 11.2 Recommended next steps

1. **Fix Storage challenges**: change `resolveMeta` to query the prover's `/pose/storage-meta` RPC instead of the shared blockstore.
2. **CidRegistry auto-register hook**: add an optional tx step in `ipfs-http.ts`'s `handleAdd` (config-flagged).
3. **Soak monitoring**: 24h watch on `batchV2` cadence, `pendingV2` queue length, and `storageGb` accumulation.
4. **Deploy script fix**: add a post-deploy `initialize()` call to `contracts/deploy/deploy-pose.ts`.

## 12. Change Log

| Date | Version | Change |
|---|---|---|
| 2026-04-24 | 1.0 | Initial snapshot after Phase C Step 2 full deployment |
| 2026-04-25 | 1.1 | node-1 IPFS HTTP exposed on host port `28786` → container `5001` for external testing. compose backup at `docker-compose.testnet.yml.bak.20260425-010705`. Node-2/3 remain container-only on 5001. |

---

**Note**: The snapshot in this document corresponds to roughly **2026-04-24 12:30 UTC**. If further deployments or config changes occur, update the relevant sections and add an entry to §12. The single source of truth remains the testnet's live config + chain state.
