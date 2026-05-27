# 88780 Canary Faucet Operations

> SOP for running the public canary faucet at `https://faucet.chainofclaw.io`.
> Covers: refill flow, balance monitoring, wallet rotation, abuse response,
> and capacity model.

[中文版](./faucet-operations-88780.zh.md)

## Overview

| Field | Value |
|---|---|
| Public URL | `https://faucet.chainofclaw.io` |
| Service | `faucet/` workspace (Node.js HTTP server on port 3003) |
| Process manager | PM2 (`coc-faucet`) |
| Default drip | 10 COC per request |
| Default cooldown | 24 h per address |
| Daily global limit | 10 000 COC |
| Per-IP rate limit | 10 req/min |
| Faucet wallet | dedicated EOA (never reuse multisig signer keys) |
| Funding source | 3-of-5 multisig (`0x3c055D83a9aA12Bba4a2ed53F8970DF4081eBC7E`) |

## Capacity model

At default settings:
- 10 COC/drip × max ~1 drip/hour/address ≈ stable rate
- Real bottleneck: **daily global limit (10 000 COC = 1000 drips/day max)**
- Healthy headroom: hold ≥ 30 days of drips × daily limit = 300 000 COC

Tiered balance thresholds (alerts wired to these):

| Balance | State | Alert | Action |
|---|---|---|---|
| ≥ 1 000 COC | Healthy | none | refill cron handles routine top-ups |
| < 500 COC | Low | `FaucetBalanceLow` (warning) | refill within 24h |
| < 100 COC | Critical | `FaucetBalanceCritical` (critical) | refill IMMEDIATELY — drips will start failing |

## Balance monitoring

The faucet exposes balance at `https://faucet.chainofclaw.io/faucet/status`
(JSON `{address, balance, totalDrips, …}`). Prometheus polls this via a
textfile-collector cron:

```bash
# Install
sudo cp scripts/faucet-balance-check.sh /usr/local/bin/
sudo chmod +x /usr/local/bin/faucet-balance-check.sh

# Cron (root, every 5 min)
sudo tee /etc/cron.d/coc-faucet-balance-check <<'EOF'
*/5 * * * * root /usr/local/bin/faucet-balance-check.sh
EOF
```

The script writes `coc_faucet_balance_eth` + `coc_faucet_balance_check_timestamp_seconds`
to `/var/lib/node_exporter/textfile_collector/coc_faucet_balance.prom`.
node_exporter must be running with
`--collector.textfile.directory=/var/lib/node_exporter/textfile_collector`.

A separate `FaucetProbeStale` alert fires if the metric isn't refreshed
for 30 min — so a dead cron doesn't silently mask a draining faucet.

Manual check:
```bash
curl -s https://faucet.chainofclaw.io/faucet/status | jq .balance
```

## Refill procedure

**Trigger**: `FaucetBalanceLow` page OR scheduled top-up below the
30-day-headroom threshold.

**Source**: 3-of-5 multisig wallet (Treasury contract balance, with
governance approval for amounts > 10 000 COC; below that the multisig
signers can approve directly).

### Standard refill (≤ 10 000 COC, multisig-direct)

1. Confirm faucet address (`COC_FAUCET_PRIVATE_KEY` derives it on
   process start; logged at startup, also visible via
   `/faucet/status.address`). The deployed canary address is recorded
   in `configs/deployed-contracts-88780.json` (TBD field once added) or
   the ops vault.
2. Open the multisig tx UI (or use `multisig-tx submit` CLI):
   ```bash
   # Use 2 multisig owner keys to submit + confirm a plain ETH transfer.
   # Replace FAUCET_ADDRESS and AMOUNT_ETH.
   node contracts/scripts/multisig-submit-eth-transfer.js \
     --signers ~/.coc/keys/88780-multisig/owner-1.json,~/.coc/keys/88780-multisig/owner-2.json \
     --to $FAUCET_ADDRESS \
     --amount-eth $AMOUNT_ETH
   ```
3. Wait for the 3rd signer to confirm (Telegram / ops channel ping).
4. Verify `curl -s https://faucet.chainofclaw.io/faucet/status | jq .balance`
   reflects the new balance within 1 block (~3 s).
5. Log the refill in `docs/faucet-refill-log.md` (date, amount, tx hash,
   approver list).

### Large refill (> 10 000 COC, governance)

Anything ≥ 10 000 COC at a time goes through a governance proposal
(prevents a single compromised signer triple from draining the treasury):

1. Open a `TreasurySpend` proposal targeting the faucet address.
2. Standard governance flow: 7-day voting window, 40% quorum, 60% approval.
3. Multisig executes the queued proposal after the 2-day timelock.
4. Same verification + logging as standard refill.

## Wallet rotation

Rotate the faucet wallet on a calendar trigger (every 90 days) or
on any suspected compromise.

**Procedure** (drains and reissues the faucet wallet):

1. Generate a new EOA (`coc-wallet generate`) and store the key in the
   ops vault. **Do not** reuse any multisig signer key, deployer key,
   or validator key.
2. Update `COC_FAUCET_PRIVATE_KEY` in the faucet host's `.env.local`
   (and any backup deployment).
3. Drain the OLD faucet wallet to the multisig:
   ```bash
   # Use the OLD key — last operation it should ever sign.
   COC_OLD_FAUCET_KEY=… node contracts/scripts/drain-eoa-to-multisig.js
   ```
4. `pm2 restart coc-faucet` — process picks up the new key.
5. Refill the new wallet via the standard refill procedure above.
6. Update the recorded faucet address in the deployment manifest and
   announce to ops channel.

## Abuse response

The faucet has two abuse guards baked in:
- Per-IP rate limit (10 req/min, hardcoded in `faucet/src/faucet-server.ts`)
- Per-address cooldown (24h default, env `COC_FAUCET_COOLDOWN_MS`)

But coordinated multi-IP / multi-address sybil drains can still chew
through the daily limit. Detection signals + response:

| Signal | Detection | Response |
|---|---|---|
| Spike in distinct requester IPs | Nginx/Cloudflare access log analytics | Tighten Cloudflare WAF (rate limit per ASN, country block if attack origin is regional) |
| Spike in faucet drips per hour | `/faucet/status.totalDrips` delta | Temporarily lower `COC_FAUCET_DRIP_AMOUNT` to 1 COC and restart; investigate before reverting |
| All drips coming from clearly-related addresses | Manual on-chain analysis | Block at network level + open security issue |
| Daily global limit hit early in the day | `FaucetBalanceCritical` (no drips below threshold) | Investigate before refilling |

**Emergency stop**: `pm2 stop coc-faucet` makes the faucet unreachable
publicly without draining or rotating keys. Use during active attack
while you decide on remediation.

## Health check + smoke test

```bash
# Liveness
curl -fI https://faucet.chainofclaw.io/health
# {status: ok, faucetAddress: 0x…}

# Status (balance + drip counters)
curl -s https://faucet.chainofclaw.io/faucet/status | jq

# Smoke test a drip (one-shot — burns 10 COC):
curl -X POST https://faucet.chainofclaw.io/faucet/request \
  -H 'Content-Type: application/json' \
  -d '{"address":"0x<your-test-address>"}'
```

Expected response on success: `{"txHash":"0x…","amount":"10","unit":"COC"}`.

## Notes for future hardening

- **Tracked**: expose `/metrics` directly from the faucet (eliminates
  the textfile-collector indirection). Out of scope for canary launch
  — the cron-script path is sufficient and unblocks Gate 9.
- **Tracked**: per-AS abuse signals (Cloudflare WAF rules). Bundled into
  Gate 8 (Cloudflare proxy) work.
- **Tracked**: refill-bot automation — a small daemon that submits the
  multisig tx automatically when balance < 1000 COC, with manual override.
  Defer to post-launch (canary phase prefers a human-in-the-loop refill).

## See also

- [`observability-runbook-88780.md`](./observability-runbook-88780.md#faucetbalancelow--warning) — `FaucetBalanceLow` / `FaucetBalanceCritical` / `FaucetProbeStale` alert SOPs
- [`disaster-recovery-88780.md`](./disaster-recovery-88780.md) — multisig key loss scenarios (affects refill capacity)
- [`public-endpoints-88780.md`](./public-endpoints-88780.md) — canonical faucet URL
- [`canary-launch-checklist-88780.md`](./canary-launch-checklist-88780.md) — Gate 9 evidence
