# 88780 Disaster Recovery Runbook

> Six crisis scenarios with symptoms / diagnosis / recovery / rollback /
> ops-handoff for each. Each scenario references the chaos memory file
> [`coc-88780-2026-05-26-chaos-engineering-T1-T8.md`](https://github.com/chainofclaw/COC/blob/main/docs/coc-88780-2026-05-26-chaos-engineering-T1-T8.md)
> (in `~/.claude/projects/.../memory/`) for proven recovery patterns
> observed during prior chaos drills.

[中文版](./disaster-recovery-88780.zh.md)

## Before you start

**Stop. Breathe. Read.** Most chain-side "crises" look worse than they
are at first glance. Three sanity checks before any destructive action:

1. **Confirm the symptom is real, not a UI artifact**. Hit at least two
   different validator RPCs (`209.74.64.88:38780`, `159.198.36.3:28780`,
   etc. from
   [`public-endpoints-88780.md`](./public-endpoints-88780.md)) and the
   public LB. If 1 of 3 reports a bad number, that's a single-node issue,
   not a chain issue.
2. **Open a war-room channel** before issuing commands. Even 30 seconds
   of coordination prevents two operators from running conflicting
   recovery steps.
3. **Read this doc to the end of the relevant scenario** before
   executing. Each scenario has a rollback path; if you skip ahead and
   miss it you may need a worse recovery.

## Quick scenario index

| # | Scenario | Severity | Time-to-recover |
|---|----------|----------|----------------|
| 1 | Chain halt (BFT cannot finalize) | HIGH | 30 min – 4 h |
| 2 | Multisig key loss (1 of 5) | LOW (operational) | days (signer rotation) |
| 3 | Multisig key loss (2 of 5) | MEDIUM | days (signer rotation, harder coordination) |
| 4 | Multisig key loss (3+ of 5) | CRITICAL | weeks (multisig redeploy + state migration) |
| 5 | Mass node loss (all 6 down) | HIGH | 30 min – 2 h (from genesis bootstrap, ~30 min observed in chaos T8) |
| 6 | Validator-key compromise (single validator) | MEDIUM | 14 days (unstake lockup) + immediate node shutdown |
| 7 | Equivocation slash response (operator side) | MEDIUM | hours (operator coordination + post-mortem) |
| 8 | OZ-manifest corruption (contracts/.openzeppelin/) | LOW | minutes (re-export from chain) |

Scenarios 2/3/4 are the three multisig-loss flavors; scenario 7 is the
operator side of an EquivocationDetector firing; scenarios 1, 5 are
chain-state issues; 6 is a key-rotation procedure; 8 is a developer-side
artifact recovery.

## Scenario 1 — Chain halt (BFT cannot finalize)

### Symptoms

- Block height stops advancing across all reachable RPCs for > 60s
- `coc_getBftStatus` shows the same round + phase across many polls
- Most validators' logs show `Phase H15: proposer slot timeout, falling
  back` repeating

### Diagnosis (read-only)

```bash
# Step 1 — confirm height is stuck across the cluster
for RPC in "https://rpc.chainofclaw.io" \
           "http://209.74.64.88:38780" \
           "http://159.198.36.3:28780" \
           "http://199.192.16.79:28780"; do
  HEX=$(curl -s --max-time 8 $RPC \
    -H 'content-type: application/json' \
    -d '{"jsonrpc":"2.0","id":1,"method":"eth_blockNumber"}' \
    | jq -r .result)
  echo "$RPC -> $HEX  ($((HEX)))"
done

# Step 2 — see what each validator thinks the round / phase is
for RPC in <each validator>; do
  curl -s $RPC -H 'content-type: application/json' \
    -d '{"jsonrpc":"2.0","id":1,"method":"coc_getBftStatus"}' | jq .result
done

# Step 3 — identify which validator(s) are NOT participating
# (look at prepareVotes / commitVotes sets — count alive nodeIds)
```

Symptoms map to causes:

- **All 6 ALIVE, round phase stuck on `prepare`** — quorum cannot form;
  likely network partition. Run scenario from chaos memory T4 (3-3
  partition observation).
- **N validators DOWN, quorum boundary lost** — same family as chaos T2
  (2-of-6 down) or T3 (3+ down kills quorum entirely). Recovery: bring
  validators back. See scenario 5.
- **All ALIVE, round phase `proposer-skip` looping** — chaos T1/T5
  observed: dead-proposer slot triggers H15 fallback every ~60s. Wait
  it out; chain will skip to the next proposer.

### Recovery

**For BFT-timeout stall (most common)**:
- Identify the missing validator(s) via `coc_getBftStatus.validators` vs
  active vote set
- Bring missing validator(s) back online (see scenario 5 procedure)
- Within 1 round (~3s after the last missing node rejoins), chain resumes

**For network partition (chaos T4 pattern)**:
- Identify the partition halves via peer connectivity
- Heal connectivity (firewall rules, BGP, etc.)
- Within 30s of heal (T4 observation), each half's BFT round restarts and
  the longer-chain side wins fork choice. **No fork in steady-state**:
  T4 verified `stateRoot` consistency across stalled nodes + 0
  EquivocationDetector events

**For deadlock with no obvious cause** (genuinely unclear): coordinated
restart per scenario 5 (chaos T8 — 30s downtime, immediate recovery).
This is destructive to ephemeral state (pending mempool) but recovers
liveness.

### Rollback path

None — these are recovery actions, not destructive. If the recovery
itself causes problems (e.g. a node refuses to restart), fall through to
scenario 5 for full reset.

### Ops-handoff template

```
[CHAIN HALT] 88780, started ~<TIME UTC>
Last good height: <N>
Stuck phase: <prepare|commit|proposer-skip>
Missing validators: <list of nodeIds NOT in active vote set>
Suspected cause: <BFT timeout | partition | unknown>
Recovery action: <scenario 1 wait | scenario 5 full restart | other>
Next checkin: <TIME UTC + 15min>
Owner: <operator handle>
```

## Scenario 2 — Multisig key loss (1 of 5)

### Symptoms

- One of the 5 multisig signers reports their key is unrecoverable
- 3-of-5 threshold is still safely met (cushion: 1 spare)

### Diagnosis

Verify the remaining 4 signers can still individually sign a test
transaction:

```bash
# For each remaining signer, attempt a no-op multisig confirm
# (e.g. confirm a TX already at 0 confirmations that we'll cancel)
# This proves the 4 keys are reachable + functional
```

### Recovery

This is **operational, not critical**. Schedule a signer rotation:

1. War-room with remaining 4 signers — confirm rotation plan
2. New signer generates fresh keypair (offline, hardware wallet preferred)
3. From any 3 remaining signers, submit + confirm + execute multisig
   transaction calling `MultiSigWallet.replaceOwner(oldAddr, newAddr)`
4. Verify on-chain: `MultiSigWallet.getOwners()` shows new address
5. Lost-key signer destroys any backups of the compromised key

### Rollback path

Before step 3 executes: any of the 4 remaining signers refusing to
confirm aborts the rotation (3-of-5 threshold not reached). State is
unchanged.

After step 3 executes: rotation is on-chain. New signer is canonical.
"Rolling back" means another rotation in the other direction — which
costs another 3-of-5 multisig event but is otherwise no different.

### Ops-handoff template

```
[MULTISIG SIGNER ROTATION] 1 of 5
Lost signer: <signer index + previous address>
Replacement signer: <new address + key custody story>
Coordinators: <4 remaining signers>
Target multisig tx submission: <UTC date>
Target rotation complete: <UTC date + 24h cushion>
```

## Scenario 3 — Multisig key loss (2 of 5)

### Symptoms

- 2 of 5 signers report keys are unrecoverable
- 3-of-5 threshold barely met (cushion: 0)
- Next loss escalates to scenario 4 (CRITICAL)

### Diagnosis

Same as scenario 2 but for 3 remaining signers. Confirm they're each
individually functional and that all 3 are willing to coordinate signing.

### Recovery

**Higher urgency than scenario 2** because the cushion is exhausted —
losing one more signer means the multisig can never produce a new
transaction.

1. **Immediate**: 3 remaining signers must coordinate to back up their
   keys to additional secure storage (hardware wallet → separate
   hardware wallet, NOT just cloud backups)
2. **Same-day**: schedule 2 rotations (2 new signers)
3. Execute both rotations as separate multisig transactions:
   - tx 1: replace lost-signer-1 with new-signer-1
   - tx 2: replace lost-signer-2 with new-signer-2
4. Verify each rotation on-chain before submitting the next

### Rollback path

Same as scenario 2: rotation tx aborts before signing if any of the 3
remaining signers becomes unavailable mid-process. Re-attempt with a
back-up signer protocol.

### Ops-handoff template

Same template as scenario 2, but with **HIGH URGENCY** marker; target
completion within 24h, not 72h.

## Scenario 4 — Multisig key loss (3+ of 5) — CRITICAL

### Symptoms

- 3 or more of 5 signers have lost keys
- 3-of-5 threshold is **broken** — multisig can NEVER sign a new tx
- All UUPS contracts are stuck at their current implementation forever

### Diagnosis

Confirm with the remaining signers that this is truly the case (not a
temporary unreachability). Document each lost key's circumstance: hardware
failure, lost custody, etc.

### Recovery (no clean path — choose your poison)

There is no on-chain recovery. The multisig owner role is unrecoverable.
Three off-chain paths:

**Path A — Social recovery via deployer EOA**

The deployer EOA `0xB4E943F5F34b763fC78598a9e528995B4CDe786a` *originally*
deployed the contracts. If the deployer key is still accessible and the
community accepts deployer-driven recovery:

1. Deployer redeploys the gen-5 contract set under new multisig
   (`scripts/deploy-multisig-88780.js` + `scripts/deploy-all-88780.js`)
2. Off-chain coordination announces the new contract addresses
3. Community / dApps update references to the new proxies
4. **Old contracts are abandoned** — any on-chain state in them is lost
   (validator stakes, Treasury balance, etc.). This is a hard fork.

**Path B — Validator-vote fork**

Coordinate with the 6 validators to fork off a new chain where:
1. Old multisig's owner role is replaced via a custom genesis block
2. Block heights / state continue from a snapshot
3. New chain has a new chainId (e.g. 88781 = 0x15acd)
4. Old chain (88780) is abandoned

This is significantly more invasive than Path A but preserves state.

**Path C — Burn the network, restart canary**

Acknowledge the failure, post-mortem publicly, restart canary cleanly
from a new genesis with a new chainId. State loss but clean reputation.

### Rollback path

None. Multisig 3-of-5 below quorum is terminal. The chain itself keeps
running (BFT validators are separate from multisig signers) — it's just
contract upgrades that are blocked. So **the chain keeps producing
blocks** even in this scenario; only governance/upgrade actions are
paused.

### Ops-handoff template

```
[CRITICAL MULTISIG FAILURE] 88780 — multisig 3-of-5 broken
Lost signers (3+ of 5): <indexes + circumstances>
Remaining signers: <indexes>
Path under consideration: <A: deployer-recovery | B: validator-fork | C: clean-restart>
Chain liveness: <BFT still healthy / chain still producing blocks>
Upgrade authority: <BROKEN — no contract upgrades possible until path executes>
Coordinator: <ops + governance lead>
Public communication scheduled: <UTC>
```

## Scenario 5 — Mass node loss (all 6 down)

### Symptoms

- All 6 validator RPCs unresponsive
- Block production stopped
- `https://rpc.chainofclaw.io` returns 503

### Diagnosis

Confirm it's not a public-RPC-only outage:

```bash
# Try each validator's PRIVATE RPC directly (not via LB)
for HOST in 209.74.64.88:38780 159.198.44.136:28780 \
            199.192.16.79:28780 159.198.36.3:28780 \
            159.198.36.25:28780; do
  echo "=== $HOST ==="
  curl -s --max-time 8 http://$HOST \
    -H 'content-type: application/json' \
    -d '{"jsonrpc":"2.0","id":1,"method":"eth_blockNumber"}' | head -c 200
  echo ""
done

# obs-1 is gcloud; SSH through bob@ + sudo
ssh bob@34.139.57.20 'curl -s http://127.0.0.1:28780 ...'
```

If all 6 are down, this is a true mass-failure scenario.

### Recovery

Chaos test T8 (2026-05-26) validated this exact recovery: **simultaneous
parallel restart of all 6 nodes, ~30s downtime, immediate restoration of
3s/block production**. See chaos memory file.

Procedure:

```bash
# 1. SSH to each validator host + obs-1
# 2. Run the parallel restart via the proven script:
bash /tmp/coc-chaos-T8.sh   # if still present from chaos sprint
# OR reproduce inline:
SSH_KEY=$HOME/.ssh/openclaw_server_key
( ssh -i $SSH_KEY root@209.74.64.88   "systemctl restart coc-node@88" ) &
( ssh -i $SSH_KEY root@159.198.44.136 "systemctl restart coc-node@1"  ) &
( ssh -i $SSH_KEY root@199.192.16.79  "systemctl restart coc-node@88" ) &
( ssh -i $SSH_KEY root@159.198.36.3   "systemctl restart coc-node@1"  ) &
( ssh -i $SSH_KEY root@159.198.36.25  "systemctl restart coc-node@1"  ) &
( ssh             bob@34.139.57.20      "sudo systemctl restart coc-node@1" ) &
wait

# 3. Wait 30s, probe block production
sleep 30
for HOST in <each>; do
  curl -s http://$HOST -d '{"jsonrpc":"2.0","id":1,"method":"eth_blockNumber"}' \
    -H 'content-type: application/json' | jq -r .result
done
```

If parallel restart doesn't recover (chain still stuck after 5 min):

- **Genesis bootstrap recovery**: each node's data dir must be wiped +
  re-snap-sync from an external archive node. Not yet tested at 88780
  scale; would take hours.
- This level of failure suggests state corruption or a coordinated
  software bug, not just process crashes — escalate to engineering.

### Rollback path

Parallel restart is recoverable from itself: each `systemctl restart`
just re-spawns the node process from leveldb on-disk state. No data loss
unless the underlying disk failed.

### Ops-handoff template

```
[MASS NODE LOSS] 88780 — all 6 validators down
Last good height: <N>
Suspected cause: <coordinated software bug | network outage | DDoS | unknown>
Recovery path: <parallel restart | genesis bootstrap | engineering escalation>
Estimated time-to-recover: <30 min for parallel restart>
Public communication: <YES — status page update at chainofclaw.io/network>
Owner: <ops lead>
```

## Scenario 6 — Validator-key compromise (single validator)

### Symptoms

- A validator operator reports their signing key may have leaked
  (laptop theft, breached cloud, social-engineering attack)
- No equivocation has fired yet, but the operator wants to rotate
  immediately before damage occurs

### Diagnosis

Confirm the compromise scope:
- Was only the signing key accessed, or also operator funds / multisig
  shares?
- Is the validator still producing blocks legitimately, or has the
  attacker started signing?

### Recovery

**Immediate (within minutes)**:
1. **Stop the compromised validator node** (`systemctl stop coc-node@N`)
   — prevents the attacker from forcing a double-sign if they obtain the
   key copy
2. **Voluntary unstake**: from the still-controlled key (in a clean
   environment, not the compromised host), call
   `ValidatorRegistry.requestUnstake(nodeId)`. This removes you from the
   active BFT set immediately and starts the 14-day lockup. Any
   equivocation evidence appearing in the next 14d still slashes you,
   but the attack surface is closed for new blocks
3. **Generate a fresh signing key** per
   [`external-validator-onboarding.md`](./external-validator-onboarding.md)
   Step 0
4. **Wait 14 days** (`UNSTAKE_LOCKUP`). Cannot be shortened
5. **Withdraw old stake** (`withdrawStake`) — this returns stake minus
   any slashes incurred during the lockup window
6. **Re-stake with new key**: 32 COC from the fresh key, register a new
   nodeId on the registry

### Rollback path

Before step 2 executes: if compromise is unconfirmed, halting the
unstake just leaves the validator paused — no on-chain action taken. The
node can be restarted later if the alarm was false.

After step 2: rotation is on-chain. No rollback path; the 14-day clock
runs and the operator must execute steps 3-6.

### Ops-handoff template

```
[VALIDATOR KEY COMPROMISE] nodeId <ID>
Compromise detail: <laptop / cloud / social / unknown>
Funds at risk: <yes/no>
Compromise time: <UTC>
Action taken: <node stopped @ UTC | unstake requested @ UTC>
Old key withdrawal eligible: <compromise time + 14d>
New key ready: <yes/no/in-progress>
Owner: <operator>
Coordinator: <ops lead>
```

## Scenario 7 — Equivocation slash response (operator side)

### Symptoms

- `EquivocationDetector` emits a `EquivocationProven` event with your
  nodeId
- `ValidatorRegistry` emits a paired `ValidatorSlashed` event (10% of
  remaining stake burned + sent to insurance fund + reporter)
- Your validator is automatically removed from the active BFT set

### Diagnosis

You're at fault, but you need to know HOW:
1. Identify the two conflicting signed messages (`hashA`, `hashB`) from
   the `EquivocationProven` event:
   ```bash
   curl -s https://rpc.chainofclaw.io \
     -H 'content-type: application/json' \
     -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"eth_getLogs\",\"params\":[{
       \"address\":\"0xa5dcE830e917176c1091fd6112F41E47692C510e\",
       \"fromBlock\":\"0x<recent>\"
     }]}" | jq .
   ```
2. Match each signature to one of your running node instances
3. **Most common root cause**: same signing key in use on two hosts
   (primary + standby, both alive). Always run **one and only one** node
   per signing key

### Recovery

**Immediate**:
1. Stop ALL nodes using this signing key (don't risk a second
   equivocation)
2. Post a public statement (community trust requires honesty about what
   happened)
3. Treat the next step as scenario 6 — voluntary unstake the slashed
   validator, generate a fresh signing key, re-stake with new key after
   the 14-day lockup. Your old stake's remaining 90% is recoverable post-
   lockup

**Operational post-mortem**:
- Review your fail-over / standby setup. The fundamental rule: never run
  two nodes with the same signing key, even with one "standby"
- Document the failure root cause in your operator's internal SOP
- Consider HSM-backed signing keys (only one HSM, only one signing
  process)

### Rollback path

Equivocation is on-chain. No rollback. The slash has fired. Recovery is
forward-only (steps above).

### Ops-handoff template

```
[EQUIVOCATION SLASH] nodeId <ID>
Slash amount: <amount> COC (10% of <remaining stake>)
Confused signatures: hashA=<...> hashB=<...> at height=<N>
Root cause: <multi-node-same-key | software bug | unknown>
Re-stake plan: <wait 14d, new key, re-stake>
Public statement: <yes/no/draft>
Owner: <operator>
```

## Scenario 8 — OZ-manifest corruption

### Symptoms

- `contracts/.openzeppelin/unknown-88780.json` is missing or corrupted
- `upgrades.prepareUpgrade()` or `upgrades.validateUpgrade()` fails with
  "no manifest found" or "implementation address mismatch"

### Diagnosis

```bash
cd contracts
ls -la .openzeppelin/unknown-88780.json
jq . .openzeppelin/unknown-88780.json | head
```

If the file is missing entirely or doesn't parse as JSON, it's
corrupted. The on-chain state is still healthy — only the local
upgrade-safety bookkeeping is broken.

### Recovery

OZ provides a way to rebuild the manifest from on-chain state:

```bash
cd contracts
node -e '
  const { ethers, upgrades } = require("hardhat");
  const manifest = require("@openzeppelin/upgrades-core").Manifest;
  // Bootstrap from each proxy address:
  const PROXIES = require("../configs/deployed-contracts-88780.json").contracts;
  (async () => {
    for (const [name, addr] of Object.entries(PROXIES)) {
      const impl = await upgrades.erc1967.getImplementationAddress(addr);
      console.log(name, "proxy:", addr, "impl:", impl);
    }
    // Use upgrades.forceImport() to seed the manifest from these pairs.
  })();
'
```

For full automated recovery, use the OZ `forceImport` helper:

```js
await upgrades.forceImport(proxyAddress, FactoryContract, { kind: "uups" });
```

Repeat for each of the 13 gen-5 proxies. The manifest will be
reconstructed under `.openzeppelin/unknown-88780.json`. Commit the result
to git.

### Rollback path

If forceImport doesn't recover everything, the worst case is: future
upgrades will be unable to use the OZ upgrade-safety validation. They
can still be executed via low-level `proxy.upgradeTo(newImpl)` calls
from the multisig, bypassing the safety check. This is risky but works.

Long-term recovery: gradually re-build the manifest entry-by-entry from
each successful future upgrade.

### Ops-handoff template

```
[OZ MANIFEST CORRUPTION]
File: contracts/.openzeppelin/unknown-88780.json
Symptom: <missing | corrupted JSON | impl-address mismatch>
On-chain state: <healthy>
Recovery action: <forceImport per proxy | bypass with raw upgradeTo>
Owner: <developer>
```

## What's intentionally NOT here

- **State migration scripts for hard forks** — these are scenario-
  specific and authored on demand
- **Mainnet recovery** — mainnet doesn't exist yet; when it does, a
  separate runbook with mainnet-specific addresses + signers
- **Bridge incident response** — no bridge live yet; placeholder for
  future
- **PoSe v2 settlement recovery** — PoSe v2 pipeline dormant on 88780;
  add this scenario when pipeline activates

## See also

- [`public-endpoints-88780.md`](./public-endpoints-88780.md) — endpoints + contract addresses
- [`canary-launch-checklist-88780.md`](./canary-launch-checklist-88780.md) — gate 7 ties here
- [`external-validator-onboarding.md`](./external-validator-onboarding.md) — for scenarios 6, 7's recovery
- Chaos engineering memory (`~/.claude/projects/-passinger-projects-ClawdBot/memory/coc-88780-2026-05-26-chaos-engineering-T1-T8.md`) — proven recovery patterns from T2/T3/T4/T8
- [`SECURITY.md`](../SECURITY.md) — for the equivocation-detector recovery context
