# Core Algorithm Bugfix Log (2026-02-26)

## Round 1: Fork-choice weight forgery hardening
- **Issue**: `cumulativeWeight` was hash-bound but not semantically validated during block application/snapshot verification, allowing forged weight values to pass structural checks.
- **Risk**: attacker-crafted blocks could bias chain selection and force expensive sync attempts.
- **Fix**:
  - Enforced `cumulativeWeight` validation in `ChainEngine.applyBlock()` and `PersistentChainEngine.applyBlock()`.
  - Added snapshot/import-time weight validation in `verifyBlockChain()` for both engines.
  - Refactored persistent engine stake lookup via `getValidatorStake()` to keep weight checks consistent.
- **Tests**:
  - `node/src/chain-engine.test.ts`: rejects forged `cumulativeWeight`.
  - `node/src/chain-engine-persistent.test.ts`: rejects forged `cumulativeWeight` in direct apply and `importSnapSyncBlocks`.

## Round 2: Mempool base-fee admissibility
- **Issue**: `pickForBlock()` could include txs whose `maxFeePerGas` was below current `baseFee`.
- **Risk**: invalid txs consumed block assembly budget and increased empty-block fallback probability.
- **Fix**:
  - Added base-fee cap check before tx sorting/selection in `node/src/mempool.ts`.
- **Tests**:
  - `node/src/mempool.test.ts`: verifies under-baseFee txs are excluded from block selection.

## Round 3: DHT per-IP Sybil guard bypass
- **Issue**: per-IP bucket limits compared raw host strings and could be bypassed using address aliases (for example IPv4 vs `::ffff:` mapped IPv6).
- **Risk**: peers could exceed intended per-IP quota in a bucket and skew routing table composition.
- **Fix**:
  - Added host canonicalization (lowercase, trim, IPv4-mapped IPv6 normalization).
  - Applied canonical host matching in per-IP bucket counting and loopback detection.
- **Tests**:
  - `node/src/dht.test.ts`: verifies alias forms of the same IP are counted together against the per-IP limit.
