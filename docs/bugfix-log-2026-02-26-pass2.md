# Core Algorithm Bugfix Log (2026-02-26, Pass 2)

## Round 1: Finality metadata trust boundary hardening
- **Issue**: `finalized` / `bftFinalized` are not hash-bound fields, but inbound blocks could carry these values and influence local metadata; duplicate local finalize updates could also be dropped.
- **Risk**: remote metadata injection could poison local finality view; local BFT-finalized state could fail to persist on duplicate apply path.
- **Fix**:
  - In both chain engines, inbound blocks now recompute/overwrite metadata (`finalized=false`; `bftFinalized` only accepted from trusted local path).
  - Duplicate block apply path now allows trusted local promotion of `bftFinalized`.
  - `index.ts` BFT finalize callback now calls `applyBlock(..., true)` to mark trusted local metadata updates.
- **Tests**:
  - `node/src/chain-engine.test.ts`
  - `node/src/chain-engine-persistent.test.ts`

## Round 2: Finality update performance tightening
- **Issue**: in-memory finality update scanned backward over block list each block production (`O(n)` growth path).
- **Risk**: avoidable CPU growth on long-running nodes.
- **Fix**:
  - Switched to constant-time finality advancement: only mark the single block that just crossed depth threshold.
- **Tests**:
  - Existing finality behavior tests + chain-engine regression suite.

## Round 3: DHT iterative lookup malformed ID filtering
- **Issue**: iterative FIND_NODE accepted non-hex peer IDs from remote responses before insertion.
- **Risk**: malformed IDs could pollute lookup state and trigger distance-calculation failures (DoS surface).
- **Fix**:
  - Added strict node ID validation (`0x` + hex, bounded length) and lowercase normalization before insertion/verification.
  - Invalid peer IDs are dropped early.
- **Tests**:
  - `node/src/dht-network.test.ts`: malformed peer ID is ignored while valid peer is still discovered.
