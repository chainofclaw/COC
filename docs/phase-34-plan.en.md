# Phase 34: Public Testnet Go/No-Go Checklist (with Validation Commands, Thresholds, and Owners)

## 1. Goal and Scope

This checklist is for public testnet launch decisions and covers four gate categories:
- Delivery quality gates (buildable, testable, bootable)
- Protocol and network gates (consensus, P2P, PoSe, RPC)
- Security gates (closure of known high-priority risks)
- Operations gates (monitoring, alerting, on-call, drills)

> Decision rule: if any `P0/P1` gate fails, the result is `No-Go`.

---

## 2. Decision Rules

### 2.1 Go Conditions (all must be satisfied)
1. All `P0` items pass.
2. All `P1` items pass.
3. `P2` pass rate is >= 90% (and no unclosed security red lines).
4. Joint sign-off by Release Manager and Security Lead is completed.

### 2.2 No-Go Triggers (any one triggers No-Go)
1. Nodes cannot start stably, or a 5-node network cannot run continuously for 24h.
2. Unclosed high-priority security risks exist (relay witness forgery, missing BFT malicious-behavior penalty, no mitigation for cross-address Sybil).
3. Monitoring and alerts do not cover key security and availability indicators.
4. Disaster recovery drill and rollback drill cannot be completed.

---

## 3. Validation Prerequisites

1. Run final validation in real environments with port-listen permission (bare metal/VM/K8s), not in restricted sandboxes.  
2. Standard test variables:

```bash
export COC_TESTNET_CONFIG_GLOB="./ops/testnet/*.json"
export COC_TESTNET_RPC="http://127.0.0.1:28780"
```

3. Owner role definitions:
- Release Manager
- Core Node Lead
- Consensus Lead
- PoSe Lead
- Contracts Lead
- Security Lead
- SRE Lead
- QA Lead
- DevOps Lead

---

## 4. Go/No-Go Checklist

| Priority | Domain | Check Item | Validation Command | Pass Threshold | Owner |
|---|---|---|---|---|---|
| P0 | Quality | Full quality gate | `bash "scripts/quality-gate.sh"` | Exit code `0`, no test failures | QA Lead |
| P0 | Startup | Single-node cold start | `COC_DATA_DIR="./.run/go-no-go/node-1" node --experimental-strip-types "node/src/index.ts"` | Node starts and RPC is reachable (see next item) | Core Node Lead |
| P0 | Availability | Basic RPC availability | `curl -fsS -X POST "$COC_TESTNET_RPC" -H "content-type: application/json" -d '{"jsonrpc":"2.0","id":1,"method":"eth_blockNumber","params":[]}'` | `result` returned and height keeps increasing within 10 minutes | SRE Lead |
| P0 | Network | 3-node integration smoke test | `bash "scripts/verify-devnet.sh" 3` | Exit code `0` | Core Node Lead |
| P0 | Network | 5-node integration smoke test | `bash "scripts/verify-devnet.sh" 5` | Exit code `0`, and inter-node height gap <= 2 (manual review) | Core Node Lead |
| P0 | Security Config | Enforce P2P inbound auth | `rg -n '"p2pInboundAuthMode":\\s*"enforce"' $COC_TESTNET_CONFIG_GLOB` | All node configs set to `enforce` | Security Lead |
| P0 | Security Config | Enforce PoSe inbound auth | `rg -n '"poseInboundAuthMode":\\s*"enforce"' $COC_TESTNET_CONFIG_GLOB` | All node configs set to `enforce` | Security Lead |
| P0 | Security Config | Disable DHT anonymous fallback | `rg -n '"dhtRequireAuthenticatedVerify":\\s*true' $COC_TESTNET_CONFIG_GLOB` | All node configs set to `true` | Security Lead |
| P0 | Security Config | Enable on-chain challenger authorization and fail-closed | `rg -n '"poseUseOnchainChallengerAuth":\\s*true|"poseOnchainAuthFailOpen":\\s*false' $COC_TESTNET_CONFIG_GLOB` | All nodes satisfy `onchain=true` and `failOpen=false` | PoSe Lead |
| P0 | Security Capability | Relay witness strict verification closure | `node --experimental-strip-types --test "services/verifier/relay-witness-security.test.ts"` | Test file exists and all tests pass | Security Lead + PoSe Lead |
| P0 | Security Capability | BFT malicious-behavior penalty closure | `node --experimental-strip-types --test "node/src/bft-slashing.integration.test.ts"` | Test file exists and all tests pass | Consensus Lead + Contracts Lead |
| P0 | Observability | Network security metrics observable | `curl -fsS -X POST "$COC_TESTNET_RPC" -H "content-type: application/json" -d '{"jsonrpc":"2.0","id":1,"method":"coc_getNetworkStats","params":[]}'` | Response includes `authRejected`, `discoveryIdentityFailures`, and DHT verify stats | SRE Lead |
| P0 | Metrics | Prometheus metrics scrapeable | `curl -fsS "http://127.0.0.1:9100/metrics" \| rg "coc_block_height|coc_peers_connected|coc_p2p_auth_rejected_total"` | At least the 3 metrics above are present | SRE Lead |
| P1 | Stability | 24h stability run | `bash "scripts/start-devnet.sh" 5` (sample for 24h) | No crashes; total block stall < 5 minutes; reorg anomalies = 0 | SRE Lead + QA Lead |
| P1 | Performance | Block production stability | periodic `curl` on `eth_blockNumber` (every 5s) | Avg block interval 3s±1s, P95 < 6s | Core Node Lead |
| P1 | Operations | Alert rule coverage | `rg -n "authRejected|discoveryIdentityFailures|dht.verifyFailures|consensus_state" "./ops/alerts"` | All key metrics have alert rules | DevOps Lead + SRE Lead |
| P1 | Operations | On-call and upgrade/rollback runbooks | `test -f "./ops/runbooks/testnet-oncall.md" && test -f "./ops/runbooks/testnet-rollback.md"` | Both runbooks exist and drill records are completed | SRE Lead |
| P1 | Data | Snapshot recovery drill | `curl -fsS "http://127.0.0.1:29780/p2p/state-snapshot" > "/tmp/coc-state-snapshot.json"` | Snapshot can be exported and imported to a new node that catches up | Core Node Lead |
| P1 | Keys | Production key custody | `rg -n "KMS|Vault|HSM" "./ops" "./runtime" "./node"` | Private keys are not stored long-term in plaintext config | Security Lead + DevOps Lead |
| P2 | Contract Quality | Contract tests and coverage | `cd "contracts" && npm run test && npm run coverage:check` | Tests pass; coverage meets repository thresholds | Contracts Lead |
| P2 | Ops Automation | Release pipeline | `test -d ".github/workflows"` | Includes at least test/build/release workflows | DevOps Lead |

---

## 5. Staged Validation Timeline

| Timepoint | Objective | Required Work | Owner |
|---|---|---|---|
| T-14 days | Freeze scope and risk convergence | Complete all P0 implementation and missing test cases | Core Node Lead / Security Lead |
| T-7 days | Pre-release integration | Pass 3/5-node smoke tests and 24h stability validation | QA Lead / SRE Lead |
| T-3 days | Release candidate confirmation | All P0/P1 pass; rollback drill completed | Release Manager |
| T-0 | Launch decision meeting | Joint sign-off (release + security + SRE) | Release Manager |

---

## 6. Current Baseline Decision for Public Testnet (2026-02-22)

Current recommendation: `Conditional Go` (pending real-environment validation).

### Resolved blocking items (2026-02-22):
1. **Relay witness strict verification**: `services/verifier/relay-witness-security.test.ts` — 17 tests covering forged witnesses, timestamp manipulation, replay protection, cross-node reuse.
2. **BFT malicious-behavior penalty**: `node/src/bft-slashing.ts` + `node/src/bft-slashing.integration.test.ts` — 9 tests covering equivocation detection → stake slash → treasury deposit → validator removal.
3. **Operations infrastructure**: `ops/alerts/prometheus-rules.yml` (12 alert rules), `ops/runbooks/testnet-oncall.md`, `ops/runbooks/testnet-rollback.md`.
4. **Testnet security configs**: `ops/testnet/node-config-{1,2,3}.json` and `docker/testnet-configs/node-{1,2,3}.json` updated with all required security fields (`dhtRequireAuthenticatedVerify`, `p2pInboundAuthMode: enforce`, `poseInboundAuthMode: enforce`, `poseUseOnchainChallengerAuth: true`, `poseOnchainAuthFailOpen: false`).
5. **Prometheus metrics**: `node/src/metrics.ts` + `node/src/metrics-server.ts` integrated in `index.ts`, 7 tests passing.
6. **CI workflows**: `.github/workflows/test.yml`, `build-images.yml`, `testnet-deploy.yml` present.

7. **Algorithm safety audit** (commit `5c8befb`): 9 fixes — BFT commit blockHash binding, snap sync target validation, full state snapshot trie traversal, EIP-1559 baseFee integration into block production, persistent engine timestamp validation, DHT iterative lookup distance sorting, K-bucket ping-evict, configurable signature enforcement, handshake doc alignment. 905 tests passing.

### Remaining pre-launch items (non-blocking for Go decision):
1. Real L1/L2 integration and production key custody (P1 — operational concern).
2. 24h stability run in real environment (P1 — requires port-listen permission).
3. Drill records for rollback procedures (P1 — requires real environment).

---

## 7. Decision Sign-off

| Role | Name | Decision (Go/No-Go) | Date | Notes |
|---|---|---|---|---|
| Release Manager |  |  |  |  |
| Security Lead |  |  |  |  |
| SRE Lead |  |  |  |  |
| Core Node Lead |  |  |  |  |
