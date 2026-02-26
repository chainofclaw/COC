# Core Algorithm Bugfix Log (2026-02-26, Pass 3)

## Round 1: SnapSync overlap write protection
- **Issue**: `importSnapSyncBlocks()` accepted ranges overlapping existing local heights.
- **Risk**: partial overwrite can leave stale hash-index/auxiliary data semantics and degrade chain consistency guarantees.
- **Fix**:
  - Enforced append-only import rule: reject SnapSync block ranges when `snapshotStartHeight <= currentHeight`.
- **Files**:
  - `node/src/chain-engine-persistent.ts`
  - `node/src/chain-engine-persistent.test.ts`

## Round 2: Consensus sync fallback on SnapSync failure
- **Issue**: for large gaps, `trySync()` attempted SnapSync and `continue`d even when SnapSync failed and block continuity was available.
- **Risk**: unnecessary sync stalls and repeated failed rounds (availability/performance regression).
- **Fix**:
  - Added fallback to block-level replay when SnapSync fails but local continuity window exists.
  - Keep fail-closed behavior when continuity is absent.
- **Files**:
  - `node/src/consensus.ts`
  - `node/src/consensus.test.ts`

## Round 3: DHT iterative lookup candidate hardening
- **Issue**: newly discovered peers were inserted into iterative candidate set before reachability verification.
- **Risk**: malicious/unreachable peer lists could inflate lookup work and waste query budget.
- **Fix**:
  - Only add peers to candidate/routing sets after ID validation and successful verification.
  - Invalid/unreachable peers are dropped early.
- **Files**:
  - `node/src/dht-network.ts`
  - `node/src/dht-network.test.ts`
