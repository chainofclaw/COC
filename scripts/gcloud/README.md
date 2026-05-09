# COC GCloud 5-Fullnode Testbed

Bring up 5 fullnodes on gcloud that join the existing COC testnet (chainId 18780)
to validate BFT consensus, p2p storage (IPFS + erasure coding), and recent
fixes (#70-#73, Phase H/J/Q) under realistic cross-region network conditions.

```
                         existing testnet (3 systemd validators)
                                        │
                                ┌───────┴────────┐
                                │  upstream chain │
                                │   chainId 18780 │
                                └───────┬────────┘
                                        │
                  ┌─────────────────────┼─────────────────────┐
                  │                     │                     │
        anchor-1 (us-central1)   anchor-2 (asia-east1)        │
        e2-standard-2 24/7       e2-standard-2 24/7           │
                  │                     │                     │
                  └─────────────────────┼─────────────────────┘
                                        │
              ┌──────────────────┬──────┴──────┬──────────────────┐
              │                  │             │                  │
       burst-1 (eur)     burst-2 (us-w)   burst-3 (asia-se)
       e2-medium dyn      e2-medium dyn   e2-medium dyn
```

## Roles

| Node | Type | Region | Lifecycle | Role |
|---|---|---|---|---|
| anchor-1 | e2-standard-2 | us-central1-a | 24/7 | observer fullnode → optional BFT validator |
| anchor-2 | e2-standard-2 | asia-east1-a | 24/7 | observer fullnode → optional BFT validator |
| burst-1 | e2-medium | europe-west1-b | dynamic | observer fullnode |
| burst-2 | e2-medium | us-west1-a | dynamic | observer fullnode |
| burst-3 | e2-medium | asia-southeast1-a | dynamic | observer fullnode |

All 5 start as **observers** that sync the chain, relay BFT messages, and
participate in p2p storage. Anchors can later be promoted to BFT validators via
`scripts/anchor-stake-register.sh` — that increases the upstream BFT validator
set from 3 to 5 (quorum 2→4, fault tolerance f=0→f=1).

## One-time setup

```bash
cd /passinger/projects/ClawdBot/COC

# 1) Configure
cp scripts/gcloud/config.env.example scripts/gcloud/config.env
$EDITOR scripts/gcloud/config.env   # fill in COC_GCP_PROJECT, upstream IPs, etc.

# 2) gcloud auth
gcloud auth login
gcloud auth application-default login   # for ADC if you use Cloud Logging

# 3) VPC + firewall
bash scripts/gcloud/00-bootstrap-project.sh
```

## Bring up the cluster

```bash
# Create VMs (parallelism is fine — different zones)
bash scripts/gcloud/10-create-anchor.sh anchor-1
bash scripts/gcloud/10-create-anchor.sh anchor-2
bash scripts/gcloud/20-create-burst.sh  burst-1
bash scripts/gcloud/20-create-burst.sh  burst-2
bash scripts/gcloud/20-create-burst.sh  burst-3

# Generate per-host bundles (writes /tmp/coc-5-fullnode/)
# Replace IPs with the actual external IPs from `gcloud compute instances list`.
bash scripts/bootstrap-5-fullnode-deploy.sh \
  --chain-id 18780 \
  --upstream-validator 0xf39Fd6...:209.74.64.88:29780:29781 \
  --upstream-validator 0x709979...:159.198.44.136:29780:29781 \
  --upstream-validator 0x3C44Cd...:199.192.16.79:49780:49781 \
  --gcloud-host-1 <anchor-1 external IP> \
  --gcloud-host-2 <anchor-2 external IP> \
  --gcloud-host-3 <burst-1 external IP> \
  --gcloud-host-4 <burst-2 external IP> \
  --gcloud-host-5 <burst-3 external IP>

# Deploy COC fullnode onto each VM (~3-5 min per VM on first run)
bash scripts/gcloud/50-deploy-node.sh all
```

## Verify health

```bash
# Operator workstation: poll all 5 RPCs
for ip in <anchor-1 ip> <anchor-2 ip> <burst-1 ip> <burst-2 ip> <burst-3 ip>; do
  height=$(curl -sS http://$ip:28780 -H 'Content-Type: application/json' \
    -d '{"jsonrpc":"2.0","method":"eth_blockNumber","params":[],"id":1}' | jq -r .result)
  printf "%-20s height=%s\n" "$ip" "$height"
done
# All 5 should converge to within ±1 of upstream height after ~2 min.
```

## Promote anchors to BFT validators (Phase B)

After both anchors have caught up to the chain head:

```bash
# Read the per-anchor private key from /tmp/coc-5-fullnode/keys.txt
ANCHOR1_PRIV=$(grep -m1 node_1_priv /tmp/coc-5-fullnode/keys.txt | cut -d= -f2)

# Use a funder key with prefunded balance on the upstream chain
# (e.g. anvil idx 0 if the testnet was prefunded with that account).
bash scripts/anchor-stake-register.sh \
  --upstream-rpc http://<anchor-1 ip>:28780 \
  --registry-address 0x<ValidatorRegistry on chain> \
  --funder-key 0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80 \
  --anchor-priv "$ANCHOR1_PRIV" \
  --stake-eth 100

# Repeat for anchor-2.
```

## Test matrix

Run scenarios from `/home/bob/.claude/plans/coc-gcloud-3-5-bft-p2p-sleepy-wall.md`.
Quick reference:

| ID | Command |
|---|---|
| **B2** kill burst, observe liveness | `bash scripts/gcloud/30-stop-burst.sh burst-1` |
| **B3/B4** stop 2 bursts, restart | `bash scripts/gcloud/30-stop-burst.sh burst-1; bash 30-stop-burst.sh burst-2; sleep 60; bash 31-start-burst.sh burst-1` |
| **B7** network partition | `bash scripts/gcloud/chaos/partition.sh apply burst-1,burst-2 vs anchor-1,anchor-2,burst-3` |
| **C2** stateRoot corrupt → forceSnapSync | `bash scripts/gcloud/chaos/corrupt-stateroot.sh burst-1` |
| **P1** large IPFS file roundtrip | upload via `/api/v0/add` to one node, GET from each peer |
| **P2** kill shard → repair tick | `bash scripts/gcloud/chaos/kill-shard.sh burst-1 <CID>` |

## Stop / restart bursts (cost optimization)

```bash
# Between validation runs, stop bursts to save ~$0.10/hr
bash scripts/gcloud/30-stop-burst.sh all-bursts

# Resume — systemd auto-restarts coc-node@1 on boot, snap-sync resumes
bash scripts/gcloud/31-start-burst.sh all-bursts
```

## Tear down

```bash
# Just delete VMs (keeps VPC/firewall for reuse)
bash scripts/gcloud/40-destroy-all.sh vms-only

# Full clean (deletes VPC + subnets + firewall + VMs)
bash scripts/gcloud/40-destroy-all.sh full
```

## Troubleshooting

**Node won't sync past height N**
- Check upstream validator IPs are reachable: `curl http://<upstream-ip>:28780 ...`
- Inspect logs: `gcloud compute ssh <node> --command 'sudo journalctl -u coc-node@1 -n 200'`
- Strict mode (`p2pInboundAuthMode=enforce`) may reject upstream nodes still
  using `observe`. If upstream rejects our handshake, temporarily set
  `p2pInboundAuthMode=observe` in the rendered config (re-render via bootstrap
  with a patched template).

**Wire handshake failures across regions**
- Check each VM's `gcloud compute firewall-rules list` allows tcp:29781
- Verify `advertisedP2pUrl` in `/etc/coc/node-1.json` uses the **external** IP
  (not the GCE internal IP) — bootstrap script uses what you passed to
  `--gcloud-host-N`.

**`50-deploy-node.sh` SSH timeout**
- First boot can take 60s; the script retries 12×5s.
- Fall back to manual: `gcloud compute scp` + `gcloud compute ssh` interactively.

**Cost / billing**
- Anchors at e2-standard-2: ~$0.067/hr each = ~$96/month for 2 anchors 24/7
- Bursts at e2-medium: ~$0.034/hr each = ~$0.10/hr for all 3 active
- Keep bursts stopped between runs; their persistent disks cost ~$0.01/hr/30GB.

## Files in this directory

```
scripts/gcloud/
├── README.md                    # this file
├── config.env.example           # operator config template (gitignored when copied)
├── _lib.sh                      # shared helpers (sourced)
├── 00-bootstrap-project.sh      # VPC + subnets + firewall
├── 10-create-anchor.sh          # e2-standard-2 anchor (24/7)
├── 20-create-burst.sh           # e2-medium burst (dynamic)
├── 30-stop-burst.sh             # stop burst (preserve disk)
├── 31-start-burst.sh            # restart burst
├── 40-destroy-all.sh            # destructive cleanup
├── 50-deploy-node.sh            # push deploy-vars + run deploy-fullnode.sh
└── chaos/
    ├── partition.sh             # iptables partition between groups
    ├── corrupt-stateroot.sh     # leveldb stateRoot corruption
    └── kill-shard.sh            # delete IPFS block on one node
```

Companion files at `scripts/`:
- `bootstrap-5-fullnode-deploy.sh` — generate per-host deploy bundles
- `deploy-fullnode.sh` — installed on each VM, decodes embedded JSON, starts systemd
- `anchor-stake-register.sh` — Phase B: promote anchor to BFT validator
