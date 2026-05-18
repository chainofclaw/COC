# R3.2 — 准生产 testnet chainId 88780 准备 (M11)

## Status
Pre-deploy SOP. Actual chain bring-up deferred until R1-R3 milestones land
in upstream COC repo.

## Goal
Stand up a "production candidate" testnet at chainId **88780** with all 10
governance contracts deployed (R1.1 + ValidatorRegistry + PoSeManagerV2 +
SoulRegistry + CidRegistry + DIDRegistry + InsuranceFund + EquivocationDetector
+ Treasury + GovernanceDAO + FactionRegistry), at least 7 validators across
4 continents, running for 30 days with weekly churn + slash drills. This
is the rehearsal for mainnet bring-up.

## Topology

| Role | Region | Spec | Identity |
|---|---|---|---|
| validator-1 | us-central1-a (GCP) | e2-standard-2 | unique key |
| validator-2 | asia-east1-a (GCP) | e2-standard-2 | unique key |
| validator-3 | europe-west1-b (GCP) | e2-medium | unique key |
| validator-4 | us-west1-a (GCP) | e2-medium | unique key |
| validator-5 | asia-southeast1-c (GCP) | e2-medium | unique key |
| validator-6 | lab-1 (operator workstation, US) | bare-metal | unique key |
| validator-7 | lab-2 (operator workstation, EU) | bare-metal | unique key |

All 7 keys must be **distinct** (no shared anvil keys like in current 18780).

## Pre-deploy Checklist

- [ ] Reserve chainId 88780 in genesis config
- [ ] Generate 7 fresh BIP-39 seeds; store in `~/.coc/keys/prod-candidate/`
  (chmod 600, never commit)
- [ ] Update `scripts/gcloud/config.env` to add `COC_PROD_CANDIDATE_CHAIN_ID=88780`
- [ ] Provision 5 GCP VMs reusing R1 fixture template
- [ ] Bring up validators 6+7 on lab hardware
- [x] Deploy contracts via `contracts/scripts/deploy-governance.js` then
  `contracts/scripts/deploy-all-88780.js` (`COC_RPC_URL` / `COC_CHAIN_ID=88780`).
  All 13 deployed addresses are recorded in `configs/deployed-contracts-88780.json`
  — the canonical manifest. Last redeploy 2026-05-18 carried the #645–#670
  security-audit contract fixes.
- [ ] All 7 validators stake 32 ETH into ValidatorRegistry
- [ ] All 7 register in PoSeManagerV2 with serviceFlags=7
- [ ] enableEmission with COC token (real ERC20, not deployer-as-stub)
- [ ] Setup Prometheus + Grafana for the cluster

## 30-day SLA Targets

| Metric | Target |
|---|---|
| uptime (cluster majority alive) | ≥ 99.5% |
| BFT block production | ≥ 90% of expected (3 s blocks) |
| at least 1 real equivocation slash drill | yes |
| at least 1 governance proposal lifecycle | yes |
| weekly churn drill (run-churn-sequence.sh on subset) | each Monday |
| explorer Validator page reflecting on-chain state | yes |

## Risk Register

| Risk | Mitigation |
|---|---|
| Chain stalls due to validator outage | H15 fallback proposer (R1.4 verified) |
| Equivocation by colluding validators | EquivocationDetector + slash automation (R3.1) |
| Governance proposal exploitation | Treasury 3-of-5 multisig + DAO timelock |
| GCP resource exhaustion | Reserved capacity + lab fallback validators |

## Roll-out Plan

1. **Week -1**: deploy + warmup (1 day chain stability)
2. **Week 0-1**: invite outside operators to spin up validators on COC SDK
3. **Week 1-2**: run weekly churn drill; observe metrics
4. **Week 2-3**: governance proposal demonstrating Treasury budget cap change
5. **Week 3-4**: equivocation drill (controlled double-sign by trusted operator)
   verifying EquivocationDetector → slash automation
6. **Week 4**: post-mortem + hand-off to mainnet planning

## Code-ready Status

Per RALPH_PROGRESS.md M11: this document is the SOP. Implementation
involves environmental orchestration (gcloud, lab hardware) outside the
scope of an in-session ralph iteration. Next ralph cycle would consume
this SOP to actually start spinning up the testnet.
