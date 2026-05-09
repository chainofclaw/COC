# Multinode integration fixture (Phase J3 + R1/R2 PoSe E2E)

End-to-end fault-injection harness for the Phase J consensus self-recovery
deadzone fixes AND the R2.1 PoSe multinode scenarios. Reproduces today's
testnet failures as deterministic regression scenarios — the production
network's 2026-05-05 stall (chain deadlock at block 206803→206804 with
stateRoot divergence on node-1) is the canonical case.

## What it covers

### Phase J consensus recovery scenarios (3-validator fixture)

| Scenario | What's reproduced | What we assert |
|---|---|---|
| `01-stateroot-divergence` | LevelDB block-header stateRoot field corrupted on one validator (the "shadow divergence" of 2026-05-05) | J1.1 fires `onPeerQuorumDiverged` from buffered prepare votes WITHOUT waiting for round timeout; J1.3 routes to `consensus.requestSyncNow`; chain recovers in ≤30 s |
| `02-stuck-proposer` | Proposer's BFT round state internally deadlocked (prepareVotes pinned at 1, no peer votes arriving — the H15b watchdog gap) | J2.2 watchdog calls `bft.forceClearRound` on the self-stuck proposer; chain recovers in ≤2 × NO_PROGRESS_TIMEOUT_MS (≤4 min) |
| `04-h15-fallback` (R1.4) | Round-robin proposer offline; chain freezes when its rotation slot comes up | H15 fallback proposer (rotation+1) arms `noProgressProposerOverride` after NO_PROGRESS_TIMEOUT_MS=600s and produces the stuck block via `forcePropose=true`; chain advances ≥1 block within 660s; "Phase H15: …" log line present |

### R2.1 PoSe multinode scenarios (5-validator H15 fork-off fixture)

Bring up via `bash scripts/run-pose.sh up` (5 nodes + agent + relayer
sidecars + PoSe contract suite deployed on chainId 88888). Run scenarios
against the live fixture; tear down with `bash scripts/run-pose.sh down`.

| Scenario | Milestone | What's reproduced | What we assert |
|---|---|---|---|
| `05-pose-epoch-sanity` | M0 / R2.1.a | Baseline 5-node PoSe fixture healthy after deploy + agent + relayer boot | All 5 RPCs responsive; PoSeManagerV2 active node count = 5; ValidatorRegistry active = 5; agent emits "endpoint fingerprint mode" + first tick within 30 s |
| `06-pose-missing-receipts` | M2 / R2.1.b | Partition h15-node-3 from cluster network mid-epoch | Sidecars (agent + relayer) survive; chain advances when round-robin skips partitioned slot; partitioned node catches up after rejoin |
| `07-pose-bad-witness-sig` | M3 / R2.1.c | 50-request garbage POST storm against h15-node-1 RPC (malformed JSON, oversized payloads, non-existent methods) | agent + relayer survive; cluster recovers and advances ≥1 block within 90 s polling window after the storm (BFT round-robin recovery from disrupted node-1) |
| `08-pose-aggregator-crash` | M4 / R2.1.d | `docker restart` of coc-h15-agent (kills + restarts in one operation; uses restart instead of kill because some Docker daemons treat SIGKILL as user-intent and don't trigger `restart: unless-stopped`) | agent stays alive 3 consecutive 3 s polls within 120 s of restart; chain advances ≥1 block within 90 s during the restart window; relayer unaffected |
| `09-pose-concurrent-claim` | M5 / R2.1.e | 5 wallets fire `claim()` against the same reward leaf in parallel | At least 4 of 5 transactions revert (CAS atomic): `rewardClaimed[leaf]` flag prevents double-claim |
| `10-pose-slash-event` | M6 / R2.1.f | Read ValidatorRegistry state from all 5 nodes simultaneously | All 5 nodes report identical active validator set + per-validator stake/state — no fork divergence |
| `11-pose-epoch-boundary` | M7 / R2.1.g | Sample heights + timestamps across all 5 nodes | Block numbers monotonically advance; timestamps monotonically advance; no node lags by >2 blocks |

## Why a separate fixture (not `tests/integration/`)

These scenarios:
- Need real Docker networking (P2P + Wire ports) — can't be done in-process
  without rewriting the wire transport layer
- Inject filesystem-level faults (LevelDB binary edits) — incompatible with
  the in-process EVM teardown that `tests/integration/` relies on
- Run for 30+ seconds each — too slow for the per-PR `pnpm test:changed`
  loop; they belong in a manual lane (`bash tests/multinode-integration/run.sh`)
  or weekly `multinode-soak` CI lane

## Running locally

```bash
cd tests/multinode-integration
docker compose up -d --build
# Wait until all 3 validators report block height >= 5
./scripts/wait-ready.sh
# Run all scenarios sequentially
node --experimental-strip-types --test scenarios/*.test.ts
docker compose down -v
```

## Running individual scenarios

```bash
# J1 path — stateRoot divergence + auto recovery
node --experimental-strip-types --test scenarios/01-stateroot-divergence.test.ts

# J2 path — stuck proposer self-clear
node --experimental-strip-types --test scenarios/02-stuck-proposer.test.ts
```

## H15 fork-off scenario (R1.4)

`04-h15-fallback` runs against a **separate** 5-validator fixture
(chainId 88888, `docker-compose-h15.yml`) so the round-robin proposer
slot can be evacuated for ≥600 s without colliding with the 3-validator
J3 fixture.

```bash
# all-in-one (build + warmup + scenario + teardown, ~13-15 min)
bash scripts/run-h15.sh

# or step by step
bash scripts/run-h15.sh up
bash scripts/run-h15.sh test-only
bash scripts/run-h15.sh down
```

## R2.1 PoSe E2E lifecycle (M0–M7)

`run-pose.sh` orchestrates the full stack on top of the H15 5-validator
fixture: brings up nodes, deploys PoSe + ValidatorRegistry + governance
contracts via `deploy-pose-on-h15.mjs`, patches agent/relayer configs
with deployed addresses, then starts the sidecars.

```bash
# full lifecycle (~5–7 min: build cached + deploy + warmup)
bash scripts/run-pose.sh up

# run any scenario(s)
node --experimental-strip-types --test scenarios/05-pose-epoch-sanity.test.ts
node --experimental-strip-types --test scenarios/06-pose-missing-receipts.test.ts
# ... 07 / 08 / 09 / 10 / 11 ...

# tear down + remove volumes
bash scripts/run-pose.sh down
```

Validator keys: anvil 0..4 (well-known Hardhat test keys, hardcoded in
`configs-h15/node-{1..5}.json`). **Never deploy these to a real network.**

The `deploy-pose-on-h15.mjs` script is idempotent (skips if
`deployed-pose.json` already has `PoSeManagerV2.initialized: true`),
bounded (each `tx.wait()` capped at 60 s; whole script aborts after
`DEPLOY_SCRIPT_DEADLINE_MS`, default 7 min), and writes addresses to
`configs-h15/deployed-pose.json` for `run-pose.sh` to patch sidecar
configs.

Note: `08-pose-aggregator-crash` uses `docker restart` rather than
`docker kill`. On some Docker daemons, SIGKILL is treated as
user-intent and does not trigger `restart: unless-stopped` (observed
2026-05-09: RestartCount stayed 0 after kill). `docker restart` (=
stop + start) exercises the same recovery path: agent reinitializes
from disk state.

## CI integration (future)

A weekly GitHub Actions lane `multinode-soak.yml` should:
1. Cache the built node Docker image
2. Run `docker compose up -d` + scenario suite
3. Upload `docker compose logs` as build artifact on failure
4. Fail the workflow if any scenario doesn't recover within its budget

This lane is **non-blocking** for PRs (added per Phase J plan to avoid
slowing down the per-PR feedback loop).

## Fault injection scripts

- `scripts/inject-stateroot-corruption.sh <node> <height>`: stops the
  container, opens its LevelDB chain DB, mutates the stateRoot field of
  the named block to a known-bad value (`0xdead...beef`), restarts.
  Mirrors the 2026-05-05 prod symptom where node-1's leveldb had a
  stateRoot inconsistent with its actual EVM state trie.
- `scripts/freeze-bft-output.sh <node> <duration_s>`: pauses outbound BFT
  message broadcast on a node for N seconds. Achieved via Docker network
  policy (`docker network disconnect` + reconnect after sleep). Simulates
  the proposer-stuck pattern where peer votes never reach the proposer's
  BFT coordinator, leaving its round state pinned with self-vote only.

## Topology

### Phase J fixture (3 validators + 1 observer)

3 validators (node-1/2/3) + 1 observer (sync-node), all sharing the
`coc-multinode` bridge network. Identical chainId / validator set as
production testnet — only port mappings differ to avoid colliding with a
running production cluster.

| Service | Container port | Host port |
|---|---|---|
| node-1 | 18780 | 38780 |
| node-2 | 18780 | 38782 |
| node-3 | 18780 | 38784 |
| sync-node | 18780 | 38786 |

Validator keys are HARDCODED into `configs/*.json`; they're well-known
test keys (Hardhat default account 0/1/2). **Never deploy these
configurations to a real network.**

### H15 fork-off fixture (5 validators + agent + relayer)

5 validators (h15-node-1..5) on chainId 88888, optional sidecars
(coc-h15-agent + coc-h15-relayer) for PoSe lifecycle scenarios. Bridge
network `coc-h15`. Anvil 0..4 keys hardcoded in `configs-h15/node-N.json`.

| Service | Container port | Host port |
|---|---|---|
| h15-node-1 | 18780 | 38790 |
| h15-node-2 | 18780 | 38792 |
| h15-node-3 | 18780 | 38794 |
| h15-node-4 | 18780 | 38796 |
| h15-node-5 | 18780 | 38798 |
| coc-h15-agent | — (no host port) | — |
| coc-h15-relayer | — (no host port) | — |

R2.1 milestone status: M0–M7 verified PASS via scenarios 05–11.
M8 (R2.2 governance demo) and M10 (R3.1 slash automation) are
code-ready stubs — see `RALPH_PROGRESS.md` for E2E gaps.
