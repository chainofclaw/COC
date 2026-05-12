# COC Production Synthetic Check Loop

Continuous end-to-end probe of the public clawchain.io surface. Complements
`scripts/chaos/rpc-drill.ts` (which fuzzes *code-level* RPC input handling)
by checking **deployment-side invariants** — chainId consistency between
client bundle and RPC, faucet balance, WebSocket proxy reachability, block
freshness, etc.

Catches the class of issues a code-level drill cannot, e.g.:
- explorer client bundle compiled with `chainId: 18780` while RPC reports `88780`
- faucet hot-wallet has 0 COC and silently fails every drip request
- nginx proxy points `/api/testnet/ws` at a port nothing listens on
- chain head timestamp drifting past the freshness budget (validator quorum lost)

## One-shot check

```bash
node scripts/synthetic/check-prod.mjs            # exit 0 ok, 1 if any critical fails
node scripts/synthetic/check-prod.mjs --json /tmp/r.json
```

## Continuous loop

```bash
node scripts/synthetic/check-prod.mjs --watch
```

## PM2 deploy on prod-2 (159.198.44.136)

```bash
# from local repo
rsync -avz -e "ssh -i ~/.ssh/openclaw_server_key" \
  scripts/synthetic/ root@159.198.44.136:/root/clawd/COC/scripts/synthetic/

ssh -i ~/.ssh/openclaw_server_key root@159.198.44.136 '
  mkdir -p /var/log/coc-synthetic &&
  pm2 startOrReload /root/clawd/COC/scripts/synthetic/ecosystem.config.cjs &&
  pm2 save
'
```

Then `pm2 logs coc-synthetic` for live view, `cat /var/log/coc-synthetic/last.json`
for the latest report.

## Checks (13 total)

| Check                  | Critical | What it asserts                                                  |
|------------------------|----------|------------------------------------------------------------------|
| `rpc.chainId`          | ✓        | `eth_chainId` == expected (default 88780)                        |
| `rpc.blockNumber`      | ✓        | Chain advanced past genesis                                      |
| `rpc.blockFreshness`   | ✓        | Latest block timestamp within `COC_BLOCK_FRESHNESS_SEC` (60s)    |
| `rpc.peerCount`        |          | `net_peerCount` > 0                                              |
| `ws.handshake`         | ✓        | `wss://…/api/testnet/ws` returns HTTP 101 in <2s (TLS + Upgrade) |
| `website.root`         | ✓        | `/zh` returns 200 with COC branding                              |
| `website.services`     |          | `/zh/services` has all 3 openclaw skill cards                    |
| `explorer.root`        | ✓        | `/` 200, no Server-Components error, footer carries chainId      |
| `explorer.validators`  | ✓        | `/validators` 200, no error fallback                             |
| `faucet.health`        | ✓        | `/health` returns expected faucet address                        |
| `faucet.balance`       | ✓        | Hot-wallet balance > `COC_FAUCET_MIN_BALANCE` (100 COC)          |
| `faucet.status`        |          | `/faucet/status` parseable                                       |
| `ipfs.root`            |          | `https://ipfs.clawchain.io/` 200                                 |

Critical failures cause non-zero exit (one-shot) or DEGRADED line + restart loop (watch).

## Tuning

All thresholds are env vars — see top of `check-prod.mjs`. Most useful:

- `COC_BLOCK_FRESHNESS_SEC` — bump to 180s if you tolerate occasional proposer slot skips
- `COC_FAUCET_MIN_BALANCE` — raise to fire earlier alerts before drip pool runs dry
- `CHECK_INTERVAL_SEC` — default 60s; lower to 15 if you want faster MTTD at higher infra cost

## Out of scope (by design)

- **Alert delivery**: emits to stdout / pm2 logs + structured JSON; pair with a
  log shipper or webhook of your choice (this script intentionally has zero
  dependencies beyond Node 22 stdlib)
- **Per-validator health**: covered by Prometheus on each node, not this probe
- **Contract address verification**: handled by the post-deploy smoke test in
  `contracts/scripts/test-deployed-88780.js`
