# Multinode integration fixture (Phase J3)

End-to-end fault-injection harness for the Phase J consensus self-recovery
deadzone fixes. Reproduces today's testnet failures as deterministic
regression scenarios — the production network's 2026-05-05 stall (chain
deadlock at block 206803→206804 with stateRoot divergence on node-1) is
the canonical case.

## What it covers

| Scenario | What's reproduced | What we assert |
|---|---|---|
| `01-stateroot-divergence` | LevelDB block-header stateRoot field corrupted on one validator (the "shadow divergence" of 2026-05-05) | J1.1 fires `onPeerQuorumDiverged` from buffered prepare votes WITHOUT waiting for round timeout; J1.3 routes to `consensus.requestSyncNow`; chain recovers in ≤30 s |
| `02-stuck-proposer` | Proposer's BFT round state internally deadlocked (prepareVotes pinned at 1, no peer votes arriving — the H15b watchdog gap) | J2.2 watchdog calls `bft.forceClearRound` on the self-stuck proposer; chain recovers in ≤2 × NO_PROGRESS_TIMEOUT_MS (≤4 min) |

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
