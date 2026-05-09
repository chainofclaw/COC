# COC Node Operator Runbook

Operational SOP for running a COC validator node — registration, stake lifecycle, slash response, governance participation, monitoring, and incident triage.

This document targets operators of the production testnet (`chainId 18780`) and the prod-candidate testnet (`chainId 88780`, planned). Devnet (`chainId 88888` H15 fork-off) is for fixture testing only — see `tests/multinode-integration/README.md`.

---

## 1. Validator registration

A validator is two on-chain identities tied together:

- **`ValidatorRegistry.stake(nodeId, pubkeyNode)`** — locks a 32 ETH bond and registers the node for BFT block production.
- **`PoSeManagerV2.registerNode(nodeId, pubkeyNode, ...)`** — locks `MIN_BOND` (0.02 ETH) and joins the PoSe service network for storage/uptime challenges.

The two `nodeId` conventions differ — they're not interchangeable:

| Registry | nodeId formula |
|---|---|
| `ValidatorRegistry` | `keccak256(uncompressedPubkey[1:65])` (strip the 0x04 prefix) |
| `PoSeManagerV2` | `keccak256(uncompressedPubkey)` (full 65 bytes including 0x04 prefix) |

Both contracts validate the trailing 20 bytes of the supplied nodeId match the operator address (`address(uint160(uint256(nodeId)))`).

### 1.1 Stake into ValidatorRegistry

```bash
# Compute pubkey + nodeIds (Node.js + ethers v6)
node -e '
  const { Wallet, SigningKey, keccak256 } = require("ethers")
  const w = new Wallet("$YOUR_PRIVATE_KEY")
  const pubkey = new SigningKey(w.privateKey).publicKey
  const xy = "0x" + pubkey.slice(4)
  console.log("operator:        ", w.address)
  console.log("vrNodeId:        ", keccak256(xy))
  console.log("poseNodeId:      ", keccak256(pubkey))
'

# Stake (operator wallet calls — this address pays gas + 32 ETH bond)
cast send --rpc-url $RPC --private-key $OPERATOR_KEY \
  $VALIDATOR_REGISTRY \
  "stake(bytes32,bytes)" $VR_NODE_ID $PUBKEY \
  --value 32ether
```

Reverts if:
- already registered (`AlreadyRegistered`)
- nodeId trailer doesn't match `msg.sender` (`InvalidNodeId`)
- bond < `MIN_STAKE` = 32 ETH

### 1.2 Register into PoSeManagerV2

`registerNode` is more involved — needs an `ownershipSig` proving the operator controls the BFT signing key:

```js
// ownershipSig = personal_sign(keccak256("coc-register:" || poseNodeId || operator_address))
const message = ethers.solidityPacked(
  ["string", "bytes32", "address"],
  ["coc-register:", poseNodeId, operatorAddress],
)
const ownershipSig = await wallet.signMessage(ethers.getBytes(keccak256(message)))
```

Then call `registerNode(poseNodeId, fullPubkey, serviceFlags, serviceCommitment, endpointCommitment, metadataHash, ownershipSig, "0x")` with `MIN_BOND` (0.02 ETH).

Reference: `tests/multinode-integration/scripts/deploy-pose-on-h15.mjs` shows the canonical 5-validator registration pattern.

---

## 2. Voluntary exit (unstake)

```bash
# Step 1: request unstake (no value transfer; sets unstakeRequestedAt timestamp)
cast send --rpc-url $RPC --private-key $OPERATOR_KEY \
  $VALIDATOR_REGISTRY "requestUnstake(bytes32)" $VR_NODE_ID

# Step 2: wait UNSTAKE_DELAY (default 14 days) — required cooldown.

# Step 3: claim the bond back
cast send --rpc-url $RPC --private-key $OPERATOR_KEY \
  $VALIDATOR_REGISTRY "withdraw(bytes32)" $VR_NODE_ID
```

While in the unstake-requested state the node is still in the `getActiveValidators()` set (it continues to participate in BFT) until `withdraw()` removes it. Stop the node process AFTER `withdraw()` lands, not before — leaving early triggers the H15 fallback proposer override and noise the cluster.

PoSe-side: `PoSeManagerV2` doesn't currently have a clean unstake path; deactivate by setting `serviceFlags=0` via metadata update or accept that the bond stays locked until governance changes the contract.

---

## 3. Slash response

If the on-chain `EquivocationDetector.submitEvidence` fires against your nodeId:

### 3.1 Symptoms
- `ValidatorRegistry.getValidator(yourNodeId).active == false`
- `ValidatorRegistry.getValidator(yourNodeId).stake` decreased by SLASH_BPS=1000 (10%)
- `EquivocationProven` event in the mempool/explorer for your nodeId
- Block production falls below 4-of-5 quorum if your node was carrying the round

### 3.2 Triage (in order)
1. **Stop the node.** `systemctl stop coc-node` or kill the docker container. Keep running = signing more = more slashes.
2. **Capture state.** Tar `/data/coc/leveldb` + `~/.coc/keys` + `journalctl -u coc-node --since '1h ago'`. Save the `EquivocationProven` log + tx hash from the explorer.
3. **Reproduce the double-sign.** The detector contract emits `(nodeId, signer, height, hashA, hashB, evidenceHash)`. `cast logs --address $DETECTOR --from-block <slash_block-1> --to-block <slash_block+1>` extracts the two conflicting block hashes.
4. **Diagnose.** Common causes:
   - **Two nodes sharing a key**: replicated VM, restored backup running in parallel. Check `journalctl` for two BFT signing events at same height/phase from different IPs.
   - **Disk corruption**: stateRoot divergence on restart, then resigning a different block at recovery. `leveldb-poke` from `tests/multinode-integration/scripts/` can read the headers.
   - **Clock drift**: BFT round windowing depends on system time. Check `chronyc tracking` / `timedatectl status`.
5. **Don't re-stake the slashed key**. It's evidence-bound; even if the cooldown expires, future BFT messages signed by it can be re-submitted as evidence. Generate a fresh key, register fresh.

### 3.3 Appeal (commit-reveal grace period)
The detector has `slashCooldownBlocks = 1000` between slashes per nodeId — same evidence won't re-slash within that window. There's no on-chain appeal flow. Off-chain: post the diagnosis + recovery plan in the operator channel; if the slash was caused by infrastructure (e.g., upstream chain corruption), governance can refund via a proposal targeting `ValidatorRegistry`'s owner-only adjustment functions.

---

## 4. Governance participation

### 4.1 Faction registration (one-time)

```bash
# HUMAN faction — any wallet
cast send --rpc-url $RPC --private-key $YOUR_KEY \
  $FACTION_REGISTRY "registerHuman()"

# CLAW faction — needs an agent attestation
# The attestation = personal_sign(keccak256(agentId, msg.sender)) by the registering wallet
cast send --rpc-url $RPC --private-key $YOUR_KEY \
  $FACTION_REGISTRY "registerClaw(bytes32,bytes)" $AGENT_ID $ATTESTATION
```

Faction is immutable — register carefully.

### 4.2 Submit a proposal

```bash
# proposalType: 0=ValidatorAdd 1=ValidatorRemove 2=ParameterChange 3=TreasurySpend 4=ContractUpgrade 5=FreeText
cast send --rpc-url $RPC --private-key $YOUR_KEY \
  $GOVERNANCE_DAO \
  "createProposal(uint8,string,bytes32,address,bytes,uint256)" \
  $TYPE "$TITLE" $DESC_HASH $TARGET 0x$CALLDATA $VALUE_WEI
```

Voting window: 7 days (default). Quorum: 40%. Approval: 60%. Bicameral mode (both factions must independently approve) is currently DISABLED — see `bicameralEnabled()` to confirm.

### 4.3 Vote

```bash
# support: 0=against, 1=for, 2=abstain
cast send --rpc-url $RPC --private-key $YOUR_KEY \
  $GOVERNANCE_DAO "vote(uint256,uint8)" $PROPOSAL_ID 1
```

### 4.4 Queue + execute

```bash
# After votingDeadline + sufficient FOR votes:
cast send --rpc-url $RPC --private-key $YOUR_KEY \
  $GOVERNANCE_DAO "queue(uint256)" $PROPOSAL_ID

# After executionDeadline (queue + timelockDelay = 2 days):
cast send --rpc-url $RPC --private-key $YOUR_KEY \
  $GOVERNANCE_DAO "execute(uint256)" $PROPOSAL_ID
```

A complete dev-cycle reference exists at `tests/integration/governance-dao-lifecycle.integration.test.ts` — runs the full `propose → vote → queue → execute` flow on a hardhat node in 4.2 s.

---

## 5. Monitoring + alerting

| Signal | RPC method / source | Alert threshold |
|---|---|---|
| Block production lag | `eth_blockNumber` cluster max - local | > 5 blocks for > 60 s |
| BFT round not advancing | `coc_getBftStatus` | round age > 600 s (NO_PROGRESS_TIMEOUT) |
| Equivocation count rising | `coc_getEquivocationsTotal` | any non-zero, immediate |
| Validator inactive | `ValidatorRegistry.getValidator(nodeId).active` | false → page operator |
| Active validator count | `ValidatorRegistry.getActiveValidators().length` | < 4 (loses 4-of-5 BFT quorum) |
| Wire peer count | `coc_getNetworkStats.wireConnected` | < 2 |
| Disk free | OS-level | < 10 GB on `/data/coc` |
| Memory | OS-level | RSS > 8 GB |

The explorer at `/validators` reads `coc_getValidators` (which sources from the same `ValidatorRegistry.getActiveValidators()` data the node uses for BFT) — bookmark it for a quick at-a-glance view.

---

## 6. Common operations

### 6.1 Restart a node cleanly
```bash
# Stop accepts SIGTERM and finishes the in-flight BFT round before exiting
systemctl stop coc-node
# Wait for the process to exit; should be < 30 s
journalctl -u coc-node -f | grep "graceful shutdown"
# Then start
systemctl start coc-node
```

### 6.2 Migrate an existing hardcoded validator to ValidatorRegistry-driven mode
See `scripts/migrate-bft-to-registry.sh` — runs the 4-step SOP (precheck, rolling restart, post-verify, rollback toggle).

### 6.3 Test fault scenarios on a local fixture
```bash
cd tests/multinode-integration
bash scripts/run-pose.sh up        # 5-validator H15 fork-off + agent + relayer
node --experimental-strip-types --test scenarios/12-pose-slash-automation.test.ts
bash scripts/run-pose.sh down
```

### 6.4 Inspect a slash on-chain
```bash
cast logs --rpc-url $RPC --address $EQUIVOCATION_DETECTOR \
  "EquivocationProven(bytes32,address,uint256,bytes32,bytes32,bytes32)" \
  --from-block $START --to-block latest
```

---

## 7. References

- ValidatorRegistry contract: `contracts/contracts-src/governance/ValidatorRegistry.sol`
- EquivocationDetector contract: `contracts/contracts-src/governance/EquivocationDetector.sol`
- GovernanceDAO contract: `contracts/contracts-src/governance/GovernanceDAO.sol`
- FactionRegistry contract: `contracts/contracts-src/governance/FactionRegistry.sol`
- Treasury contract: `contracts/contracts-src/governance/Treasury.sol`
- Production deployment addresses: `contracts/deployed-registries-newchain.json`
- Production candidate testnet 88780 SOP: `docs/r3-2-prod-candidate-testnet-88780.md`
- Multinode integration fixture: `tests/multinode-integration/README.md`
- BFT migration SOP: `scripts/migrate-bft-to-registry.sh`
- System architecture: `docs/system-architecture.en.md`
- Slash automation runtime: `runtime/lib/equivocation-detector-client.ts`
