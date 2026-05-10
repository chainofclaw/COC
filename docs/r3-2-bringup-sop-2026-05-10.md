# R3.2 chainId 88780 bring-up SOP — 2026-05-10

Concrete walkthrough for spinning up the prod-candidate testnet from the
Phase 3 prep artifacts. Pre-requisites: PR #86 (`fix/bft-n5-fault-tolerance`,
5-bug series resolving #85) merged to `chainofclaw/COC` main — the chain
needs PR-1A's fast-path proposer skip and PR-1B's set-change cache invalidation
for N=5 to be operationally viable.

## Phase 3 prep status

- [x] **3.1** — 5 independent validator keys generated at
  `~/.coc/keys/88780-prod-candidate/` (chmod 600). Public addresses kept
  alongside at `validators.json` (also copied to `configs/r3-2-candidate/`).
- [x] **3.2** — `configs/r3-2-candidate/genesis.json` written (chainId 88780,
  5 validators × 32 ETH stake, prefund deployer + per-validator gas).
- [x] **3.3** — `configs/r3-2-candidate/node-config-template.json` +
  `scripts/render-r3-2-configs.sh` ready. Renderer tested with placeholder
  hostnames; produces valid JSON.
- [x] **3.3a (dry-run)** — `scripts/start-r3-2-devnet.sh` brings up the 5
  validators against local `127.0.0.1` ports using the generated keys. Run
  on 2026-05-10:
  - All 5 nodes ready in 2s after spawn.
  - All 5 reached h=8 within 12s (`eth_chainId` returns 0x15ac4 = 88780).
  - 7 BFT rounds finalized 5/5 before localhost peer-scoring throttling
    (the documented `127.0.0.1` shared-IP issue, not a code bug) caused
    the cluster to stall waiting for chain-snapshot polls. PR-1E's
    structured warn log immediately surfaced the cause via per-peer
    `HTTP 429: peer temporarily banned` attribution.
  - **Conclusion**: 88780 genesis + per-validator wire-up is correct.
    Real validation of PR-1A's 15s fast-path requires the cross-IP gcloud
    cluster (different IPs per validator → no shared scoring quota).
- [ ] **3.4** — GCP VMs provisioned with reserved static IPs (5 regions).
- [ ] **3.5** — coc-node services running on all 5 hosts at h≈10.
- [ ] **3.6** — 10 governance contracts deployed via
  `contracts/deploy-all-registries-newchain.mjs` with `RPC=http://<v1>:28780`.
- [ ] **3.7** — Each validator stakes 32 ETH into ValidatorRegistry.
- [ ] **3.8** — `validatorRegistryAddress` wired into per-host configs;
  rolling restart with reader enabled.

## Cluster topology (target)

| Validator | Region | Spec | Static IP | Genesis address |
|---|---|---|---|---|
| validator-1 | us-central1-a (GCP) | e2-standard-2 | TBD | `0xde4e7889aa9007318ff261b1ee675f1305153590` |
| validator-2 | asia-east1-a (GCP) | e2-standard-2 | TBD | `0xb939e5a68abd2e000e78876bd86edd1cbba49eb9` |
| validator-3 | europe-west1-b (GCP) | e2-medium | TBD | `0xdefc8430388093fdfacb0a929fedc14d2e631d19` |
| validator-4 | us-west1-a (GCP) | e2-medium | TBD | `0xcc64096600c1759d7aaea91166837a5873175867` |
| validator-5 | asia-southeast1-c (GCP) | e2-medium | TBD | `0x5e773c9359a6bb416bdfffe0c9aac9f568bd11ae` |

Reserved static IPs are required — gcloud ephemeral IPs change on stop+start
(observed in the 2026-05-08 multinode validation; manual peer config patch was
needed every time a node was restarted).

Firewall ingress (per host):
- 28780/tcp (RPC), 28790/tcp (WS), 28800/tcp (IPFS HTTP)
- 29780/tcp (P2P gossip), 29781/tcp (Wire — TCP framed)
- 28786/tcp (PoSe HTTP)
- 28810/tcp (Prometheus, optional)

SSH (22/tcp) only from operator workstation IPs.

## Step-by-step

### 3.4 Provision GCP VMs

```bash
# On operator workstation (chainofclaw account)
for region in us-central1-a asia-east1-a europe-west1-b us-west1-a asia-southeast1-c; do
  gcloud compute addresses create "coc-r3-2-$(echo $region | sed 's|/.*||')" \
    --region "${region%-*}" --network-tier=PREMIUM
done

# Spin up the 5 VMs (parameterized — adjust spec per validator-3..5 to e2-medium)
for i in 1 2 3 4 5; do
  REGION=...                                    # pick by index
  IP=$(gcloud compute addresses describe "coc-r3-2-${REGION%-*}" \
        --region "${REGION%-*}" --format='value(address)')
  gcloud compute instances create "coc-r3-2-validator-${i}" \
    --zone="$REGION" \
    --machine-type=e2-standard-2 \
    --address="$IP" \
    --image-family=debian-12 --image-project=debian-cloud \
    --boot-disk-size=50GB --boot-disk-type=pd-ssd \
    --tags=coc-validator
done

# One-time firewall rule
gcloud compute firewall-rules create coc-r3-2 \
  --network=default \
  --action=ALLOW \
  --rules=tcp:28780,tcp:28786,tcp:28790,tcp:28800,tcp:28810,tcp:29780,tcp:29781 \
  --source-ranges=0.0.0.0/0 \
  --target-tags=coc-validator
```

Record the 5 reserved IPs in a local file for the next step.

### 3.5 Render and deploy per-host configs

```bash
# Replace IPs with the actual reserved values from 3.4
bash scripts/render-r3-2-configs.sh \
  IP_FOR_VALIDATOR_1 IP_FOR_VALIDATOR_2 \
  IP_FOR_VALIDATOR_3 IP_FOR_VALIDATOR_4 IP_FOR_VALIDATOR_5
# → /tmp/r3-2-configs/node-{1..5}.json

# Per host: install Node 22, copy repo + config + private key
for i in 1 2 3 4 5; do
  IP="..."  # validator-${i}'s public IP
  scp -i ~/.ssh/coc_deploy "/tmp/r3-2-configs/node-${i}.json" \
      "root@${IP}:/etc/coc/node-1.json"
  scp -i ~/.ssh/coc_deploy \
      "${HOME}/.coc/keys/88780-prod-candidate/validator-${i}.env" \
      "root@${IP}:/etc/coc/node-1.env"
  ssh -i ~/.ssh/coc_deploy "root@${IP}" \
      'chmod 644 /etc/coc/node-1.json; chmod 600 /etc/coc/node-1.env'
done
```

Bring up the systemd unit per host (template lives in
`scripts/gcloud/systemd/coc-node@.service` — adjust `ExecStart` to point at the
checked-in repo if not using `npm install -g`).

Start order: validator-1 first (it produces the genesis block), then validator-2..5
once validator-1's RPC is up. Validate with:

```bash
for IP in IP1 IP2 IP3 IP4 IP5; do
  H=$(curl -sS -X POST http://$IP:28780 -H 'content-type: application/json' \
        -d '{"jsonrpc":"2.0","id":1,"method":"eth_blockNumber","params":[]}' | jq -r .result)
  echo "$IP: $((16#${H#0x}))"
done
```

All 5 should be within ±5 blocks of each other within 30 seconds of full
cluster up. Cross-check stateRoot at h=100 — must be identical 5/5.

### 3.6 Deploy 10 governance contracts

The existing `contracts/deploy-all-registries-newchain.mjs` deploys 5 of the 10
(SoulRegistry, CidRegistry, ValidatorRegistry, PoSeManagerV2, DIDRegistry).
The remaining 5 (InsuranceFund, EquivocationDetector, Treasury, GovernanceDAO,
FactionRegistry) need a follow-up — out of scope of this SOP, tracked
in `docs/r3-2-prod-candidate-testnet-88780.md`.

Run from operator workstation pointed at validator-1's RPC:

```bash
cd contracts
COC_CHAIN_ID=88780 \
RPC=http://IP_FOR_VALIDATOR_1:28780 \
node --experimental-strip-types deploy-all-registries-newchain.mjs
```

Output writes `deployed-registries-newchain.json` with addresses + deploy
blocks. **Save this file** — needed for ValidatorRegistry reader wiring in 3.8.

### 3.7 Validators stake into ValidatorRegistry

Each validator self-registers via a stake tx. Operator can run from any host
with each validator's private key:

```bash
for i in 1 2 3 4 5; do
  KEY=$(grep COC_NODE_KEY ~/.coc/keys/88780-prod-candidate/validator-${i}.env \
         | cut -d= -f2)
  REG=$(jq -r .ValidatorRegistry.address contracts/deployed-registries-newchain.json)
  cast send --rpc-url http://IP_FOR_VALIDATOR_1:28780 \
    --private-key "$KEY" \
    --value 32ether \
    "$REG" "stake()"
done
```

Verify all 5 are active:

```bash
cast call --rpc-url http://IP_FOR_VALIDATOR_1:28780 \
  $REG 'getActiveValidators() returns (bytes32[])' | jq
```

Should return 5 entries.

### 3.8 Switch BFT to read from ValidatorRegistry

Add the registry address to each per-host `node-1.json` (the renderer doesn't
template this since the address only exists post-deploy):

```bash
REG=$(jq -r .ValidatorRegistry.address contracts/deployed-registries-newchain.json)
DEPLOY_BLOCK=$(jq -r .ValidatorRegistry.block contracts/deployed-registries-newchain.json)

for i in 1 2 3 4 5; do
  IP=...
  ssh root@$IP "
    jq --arg addr '$REG' --arg blk '$DEPLOY_BLOCK' \
      '. + { validatorRegistryAddress: \$addr,
             validatorRegistryFromBlock: (\$blk | tonumber),
             validatorRegistryPollMs: 60000 }' \
      /etc/coc/node-1.json > /etc/coc/node-1.json.next \
    && mv /etc/coc/node-1.json.next /etc/coc/node-1.json \
    && systemctl restart coc-node@1
  "
done
```

Rolling restart, one at a time, watching logs — PR-1B (`onValidatorSetChange`)
should fire on each reader-driven set update without disturbing live BFT
rounds. After all 5 restarted, confirm the chain still produces blocks at
~3s/block.

## Acceptance criteria for Phase 3

- [ ] 5 validators all reachable on `:28780/eth_blockNumber`
- [ ] heights within ±5 blocks across all 5 hosts
- [ ] stateRoot at h=200 identical 5/5
- [ ] BFT round logs visible on each host (`BFT round finalized`)
- [ ] 5 governance contracts deployed; addresses recorded
- [ ] 5/5 validators staked 32 ETH; `getActiveValidators()` returns 5 ids
- [ ] ValidatorRegistry reader wired; rolling restart succeeded; chain still
  producing
- [ ] No `equivocation evidence cap reached` warns (PR-1C metric)
- [ ] `getSnapshotFetchStats()` shows successes >> errors (PR-1E)

## Phase 4 readiness

When Phase 3 acceptance is green:
- [ ] Day-1 chaos drill: T2 (single-validator stop) — verify PR-1A's 15s
  fast-path actually kicks in (not 600s). Run `scripts/stop-devnet-node.sh`
  equivalent against the gcloud cluster (`gcloud compute instances stop ...`).
  Expected: chain pauses ≤15s before the next-in-rotation validator force-
  proposes h+1.
- [ ] Run weekly chaos drills via `scripts/gcloud/chaos/run-churn-sequence.sh`
  (parameterize for chainId 88780).
- [ ] Stand up Prometheus + Grafana per `scripts/gcloud/40-prometheus-setup.sh`
  with alerts on `bft_evidence_cache_size > 80` and `coc_chain_height` stagnation.
- [ ] 30-day soak window starts from full cluster ack.

## Rollback / abort

Phase 3 is fully reversible until 3.6 (contract deploys are immutable but
recover-via-redeploy is fine since this is a test chain). To abort:
1. `systemctl stop coc-node@1` on all 5 hosts
2. `gcloud compute instances delete coc-r3-2-validator-{1..5}`
3. Release reserved IPs
4. Optionally delete `~/.coc/keys/88780-prod-candidate/` and `configs/r3-2-candidate/`

The 5 BFT bug fixes from #86 stay merged — they apply to chainId 18780 too,
so prod testnet still benefits from them regardless of R3.2 outcome.
