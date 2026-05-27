# 88780 Canary Launch — Go-Live Checklist

> The eleven gates that must turn green before the team publicly announces
> 88780 as a canary network open for external validator onboarding. This
> doc is the single source of truth for "are we ready?" — each line links
> to the SOP / PR / dashboard that proves the gate.

[中文版](./canary-launch-checklist-88780.zh.md)

## How to read this

- **☑ closed** — done, with evidence
- **☐ open** — not done; owner shown
- **🟡 in progress** — work has started, partial evidence available

The launch announcement is gated on **all 11** items being ☑. Each gate
has explicit evidence linked — no "trust me, it's done" entries.

## The 11 gates

### Architecture & Code

1. **☐ All HIGH-severity items from the canary readiness plan closed**
   *Evidence*: see parent plan
   `/home/bob/.claude/plans/applyblock-delightful-hennessy.md` § A.1 (this
   includes ValidatorRegistryReader operational enablement and Disaster
   Recovery Runbook).
   *Owner*: core team
   *Current*: ValidatorRegistryReader code + test coverage shipped (PR #756);
   88780 operational enablement is pending — the 6 current validators must
   each `stake(nodeId, pubkeyNode)` 32 COC on-chain so the reader sees a
   non-empty active set before flipping the `COC_VALIDATOR_REGISTRY_ADDRESS`
   env on each node.

2. **☐ Last 30 days continuous block production without manual intervention**
   *Evidence*: Grafana dashboard `coc-overview` panel "Block height per
   node, 30d retrospective" — must show no flat lines > 60s except during
   scheduled rolling upgrade windows (which must themselves be logged).
   *Owner*: ops
   *Current*: 88780 has been producing continuously since
   gen-5 redeploy 2026-05-20 (commit `e5e6022`). Track via 30-day moving
   window starting at the day before announcement.

3. **☐ Last 30 days no equivocation slash fired (clean record)**
   *Evidence*: `eth_getLogs` on `EquivocationDetector` proxy
   `0xa5dcE830e917176c1091fd6112F41E47692C510e` over the announcement-window
   blocks returns 0 events.
   *Owner*: ops
   *Current*: 0 events as of 2026-05-26 chaos-test cleanup. Restart 30d
   clock if a slash fires; investigate root cause; re-do gate.

### Security

4. **☑ Bug bounty program live (SECURITY.md)**
   *Evidence*: `SECURITY.md` at repo root (PR #757 Stage 1). Public
   disclosure policy + severity tiers ($100–$50k canary) + 90d disclosure
   window + safe-harbor language all present.
   *Owner*: security team
   *Current*: Shipped. Future: Immunefi integration optional but not blocking.

5. **☐ At least 1 valid external security report received + triaged**
   *Evidence*: link to the closed GitHub Security advisory or a public
   credit page acknowledging the reporter.
   *Owner*: security team
   *Current*: Open. Proves the disclosure channel works end-to-end. Until
   one report comes in we cannot prove the email + advisory channels are
   live + monitored.

### Validator decentralization

6. **☐ At least 1 external operator successfully staked + BFT-included**
   *Evidence*: a `ValidatorRegistered` event from a non-core-team-address
   on `ValidatorRegistry`, followed within the same hour by a
   `BftMessage` whose `senderId` matches that operator's nodeId.
   *Owner*: ecosystem
   *Current*: Open. SOP at
   [`external-validator-onboarding.md`](./external-validator-onboarding.md).
   The full dry-run loop validates A.1.1 of the parent plan end-to-end.

### Operational readiness

7. **☐ Disaster Recovery Runbook reviewed + dry-run-tested**
   *Evidence*: each of the 6 scenarios in
   [`disaster-recovery-88780.md`](./disaster-recovery-88780.md) executed
   once on a devnet that mirrors 88780 config; each scenario's recovery
   procedure produces the expected post-state.
   *Owner*: ops
   *Current*: Doc shipped (Stage 2). Dry-runs pending. The 6 scenarios
   cover: chain halt, multisig key loss (1/2/3+ of 5), mass node loss,
   validator-key compromise, equivocation slash response, OZ-manifest
   corruption.

8. **☐ Public RPC endpoint hardened**
   *Evidence*: `https://rpc.chainofclaw.io` survives 10K req/min DDoS test
   (k6 / Artillery) without degrading validator-internal RPCs. Cloudflare
   or equivalent CDN/WAF in front.
   *Owner*: ops
   *Current*: Open. Per parent plan A.2.4; separate from this docs sprint.
   Validator-internal RPCs (`209.74.64.88:38780` etc.) stay private; only
   the LB front-end exposes traffic.

9. **☐ Faucet sustainable model**
   *Evidence*: faucet survives 100 drip requests/hour over 24h continuous,
   maintains balance ≥ 1000 COC (refill automation in place).
   *Owner*: ops
   *Current*: Open. Current faucet code at `faucet/` is testnet-tuned
   (10 COC drip, 24h cooldown). Refill cron job for canary phase is
   missing; needs SOP + alert if balance drops below 500 COC.

10. **🟡 Grafana dashboards committed + Prometheus alerts wired**
    *Evidence*: 4 dashboards (`docker/grafana/dashboards/coc-{overview,consensus,network,resources}.json`)
    + 11 alerts in `ops/alerts/prometheus-rules.yml` (4 groups: availability,
    security, performance, network), each mapped to a section in
    [`observability-runbook-88780.md`](./observability-runbook-88780.md)
    (Stage 6). SLO encoding: `SlowBlockProduction` (block p99 proxy),
    `EquivocationDetected` (clean-record gate), `LowPeerCount` /
    `coc_validators_active` panel (BFT quorum), `HighMempoolBacklog`
    (mempool ack proxy).
    *Owner*: ops
    *Current*: Assets + per-alert SOP shipped. Outstanding sub-tasks
    (tracked, non-blocking for Gate 10):
    - Verify dashboards import cleanly into a fresh Grafana (manual
      dry-run before launch);
    - Wire Alertmanager `runbook_url` annotations to point at the new
      runbook URL once docs are public-served;
    - Optional: add `ValidatorQuorumAtRisk` alert
      (`coc_validators_active < 5`) to preempt chaos-T2-style 2-down
      restart races.
    - Reconcile dev-stack `docker/prometheus/alerts.yml` against the
      canonical `ops/alerts/prometheus-rules.yml` (or deprecate it).

### Discoverability

11. **☐ Public docs site published**
    *Evidence*: `https://chainofclaw.io/en/docs` is reachable, renders the
    new 88780-canary doc tree (whitepaper, architecture, operations, canary
    launch, security categories), and locale switch (zh / en) works.
    *Owner*: web/frontend
    *Current*: Open. Per parent plan A.2.3 + this sprint Stage 5. The
    underlying docs are this repo's `docs/` directory; the website's docs
    page wires up the static link tree.

## Burn-down

To go live, all 11 gates must be ☑. Current count: 1 ☑ / 1 🟡 / 9 ☐.

Suggested order (fastest path to launch):
1. Gates 4 + 7 + 11 are docs-shippable inside this sprint
2. Gate 1 needs the operational enablement PR (no code, just config + env on each node)
3. Gates 8 + 9 + 10 are the ops infra sprint (Cloudflare in front of public RPC, faucet refill cron, Grafana JSON + alert SOP)
4. Gate 6 (external operator) is the validation milestone — depends on gates 1, 7, 11 being green
5. Gates 2, 3 are time-gated (30-day clean record) — start the clock the day after gates 1, 8, 10 close
6. Gate 5 needs a real report — usually closes naturally during the 30-day window if bounty is live + indexed

Estimated calendar minimum: **6-8 weeks** from sprint start, dominated by
the 30-day clean record gate + ops infra build-out.

## Don't ship if any of these are red on launch-eve

A list of conditions that revert the launch even if all 11 gates are ☑:

- Any open `priority:critical` issue in
  [chainofclaw/COC issues](https://github.com/chainofclaw/COC/issues)
- Chain block production has stalled in the last 7 days
- A multisig signer is unreachable (3-of-5 still safe but cushion eroded)
- Any of the 6 current validators is offline > 1 hour at the time of launch

## Post-launch monitoring (first 30 days)

After launch announcement, the 30-day window is high-touch:

| Day | Watch |
|-----|-------|
| D+0 | Block production rate, validator participation rate, RPC error rate |
| D+1 | First wave of external traffic — faucet drip rate, mempool depth, gas usage |
| D+3 | First external operator stake attempts (proactively invite if none happen) |
| D+7 | First weekly community update, bounty submission count |
| D+14 | First operator exit (`requestUnstake`) test if it happens organically |
| D+30 | Stage-2 mainnet prep starts (per parent plan Phase B); canary continues running |

## See also

- Parent plan: `/home/bob/.claude/plans/applyblock-delightful-hennessy.md` (the gap analysis that justifies these 11 gates)
- [`public-endpoints-88780.md`](./public-endpoints-88780.md) — canonical network params
- [`SECURITY.md`](../SECURITY.md) — gate 4 evidence
- [`disaster-recovery-88780.md`](./disaster-recovery-88780.md) — gate 7 evidence
- [`external-validator-onboarding.md`](./external-validator-onboarding.md) — gate 6 procedure
