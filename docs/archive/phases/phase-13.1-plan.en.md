# Phase 13.1: Persistent Storage Layer

**Version**: 1.0
**Date**: 2026-02-15
**Status**: In Progress
**Priority**: CRITICAL

---

## 1. Overview

Phase 13.1 implements production-grade persistent storage for COC blockchain, replacing the current in-memory/snapshot-only approach with a robust LevelDB-backed storage system.

### 1.1 Goals

- **EVM State Persistence**: Store account state, contract storage, and code in a Merkle Patricia Trie backed by LevelDB
- **Nonce Registry Persistence**: Prevent replay attacks across node restarts
- **Block/Transaction Indexing**: Enable efficient queries by hash, number, and address
- **Snapshot Optimization**: Support incremental snapshots and faster recovery

### 1.2 Success Criteria

- ✅ EVM state survives node restart
- ✅ Nonce registry prevents replays after restart
- ✅ Block/tx queries complete in < 10ms
- ✅ State sync/snapshot time reduced by 50%+
- ✅ All existing tests pass with persistent backend
- ✅ Storage overhead < 2x in-memory footprint

---

## 2. Architecture

### 2.1 Storage Layers

```
┌─────────────────────────────────────────────┐
│         Application Layer (EVM/RPC)         │
└─────────────────┬───────────────────────────┘
                  │
┌─────────────────▼───────────────────────────┐
│         Storage Abstraction Layer           │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  │
│  │State Trie│  │Block Index│ │Nonce Store│ │
│  └─────┬────┘  └─────┬─────┘ └─────┬──────┘ │
└────────┼─────────────┼─────────────┼────────┘
         │             │             │
┌────────▼─────────────▼─────────────▼────────┐
│           LevelDB Key-Value Store            │
│     (Persistent, ACID, Snapshot support)     │
└──────────────────────────────────────────────┘
```

### 2.2 Key-Value Namespace Design

| Prefix | Purpose | Key Format | Value Format |
|--------|---------|------------|--------------|
| `s:` | State Trie Nodes | `s:<nodeHash>` | RLP-encoded trie node |
| `a:` | Account State | `a:<address>` | `{nonce, balance, storageRoot, codeHash}` |
| `c:` | Contract Code | `c:<codeHash>` | Bytecode |
| `b:` | Block by Number | `b:<number>` | Block JSON |
| `h:` | Block by Hash | `h:<hash>` | Block number |
| `t:` | Transaction by Hash | `t:<txHash>` | Transaction + receipt |
| `n:` | Nonce Registry | `n:<nonce>` | Timestamp |
| `m:` | Metadata | `m:<key>` | Chain metadata |

### 2.3 Component Design

#### 2.3.1 Storage Abstraction (`node/src/storage/db.ts`)

```typescript
interface IDatabase {
  get(key: string): Promise<Uint8Array | null>
  put(key: string, value: Uint8Array): Promise<void>
  del(key: string): Promise<void>
  batch(ops: BatchOp[]): Promise<void>
  close(): Promise<void>
}

class LevelDatabase implements IDatabase {
  // LevelDB wrapper with error handling
}
```

#### 2.3.2 State Trie (`node/src/storage/state-trie.ts`)

```typescript
interface IStateTrie {
  get(address: string): Promise<AccountState | null>
  put(address: string, state: AccountState): Promise<void>
  getStorageAt(address: string, slot: string): Promise<string>
  putStorageAt(address: string, slot: string, value: string): Promise<void>
  commit(): Promise<string> // Returns state root
  checkpoint(): Promise<void>
  revert(): Promise<void>
}

class MerklePatriciaTrie implements IStateTrie {
  // @ethereumjs/trie integration with LevelDB backend
}
```

#### 2.3.3 Block Index (`node/src/storage/block-index.ts`)

```typescript
interface IBlockIndex {
  putBlock(block: Block): Promise<void>
  getBlockByNumber(num: number): Promise<Block | null>
  getBlockByHash(hash: string): Promise<Block | null>
  getLatestBlock(): Promise<Block | null>
  getTransactionByHash(hash: string): Promise<TxWithReceipt | null>
}
```

#### 2.3.4 Nonce Store (`node/src/storage/nonce-store.ts`)

```typescript
interface INonceStore {
  markUsed(nonce: string): Promise<void>
  isUsed(nonce: string): Promise<boolean>
  cleanup(olderThan: number): Promise<void> // Prune old nonces
}
```

---

## 3. Implementation Plan

### 3.1 Task Breakdown

| Task | Files | Estimate | Priority |
|------|-------|----------|----------|
| LevelDB abstraction | `storage/db.ts` | 2h | P0 |
| State Trie integration | `storage/state-trie.ts` | 4h | P0 |
| Block indexing | `storage/block-index.ts` | 3h | P0 |
| Nonce persistence | `storage/nonce-store.ts` | 2h | P0 |
| EVM integration | `evm.ts`, `chain-engine.ts` | 4h | P0 |
| Migration script | `scripts/migrate-storage.ts` | 2h | P1 |
| Tests | `storage/*.test.ts` | 6h | P0 |
| Documentation | `docs/*` | 2h | P1 |

**Total Estimate**: 25 hours (~3 days)

### 3.2 Dependencies

```bash
npm install --save level @ethereumjs/trie @ethereumjs/util
```

- **level**: LevelDB bindings for Node.js
- **@ethereumjs/trie**: Merkle Patricia Trie implementation
- **@ethereumjs/util**: Utility functions for RLP encoding

---

## 4. Testing Strategy

### 4.1 Unit Tests

- ✅ Database CRUD operations
- ✅ Batch operations and atomicity
- ✅ State trie get/put/commit
- ✅ Block index queries (by number, by hash)
- ✅ Nonce store mark/check operations

### 4.2 Integration Tests

- ✅ EVM state persistence across restarts
- ✅ Block production with persistent storage
- ✅ Nonce replay prevention after restart
- ✅ State sync and recovery

### 4.3 Performance Benchmarks

- ✅ State read/write throughput (target: 10k ops/sec)
- ✅ Block query latency (target: < 10ms)
- ✅ Snapshot creation time (target: < 5 seconds for 100k accounts)
- ✅ Disk usage efficiency (target: < 2x in-memory)

### 4.4 Crash Recovery Tests

- ✅ Kill node mid-block and verify recovery
- ✅ Corrupted database detection and repair
- ✅ Checkpoint/revert correctness

---

## 5. Migration Strategy

### 5.1 Backward Compatibility

- Existing JSON snapshots remain supported for migration
- Migration script: `scripts/migrate-storage.ts`
- Automatic detection and migration on first run with `--migrate` flag

### 5.2 Migration Steps

```bash
# Backup existing data
cp -r data/ data.backup/

# Run migration
node --experimental-strip-types scripts/migrate-storage.ts \
  --from data/chain-snapshot.json \
  --to data/leveldb

# Start node with new storage
cd node
npm start
```

---

## 6. Performance Optimizations

### 6.1 Caching Strategy

- In-memory LRU cache for hot state (size: 1000 accounts)
- Block header cache for recent blocks (size: 100)
- Code cache for frequently called contracts

### 6.2 Batch Operations

- Group state updates within a block into single LevelDB batch
- Async write-behind for non-critical indexes

### 6.3 Pruning

- Automatic nonce cleanup (older than 7 days)
- Optional state pruning for archive vs full node modes

---

## 7. Risks and Mitigations

| Risk | Impact | Mitigation |
|------|--------|------------|
| Data corruption | HIGH | ACID guarantees via LevelDB, checksums, regular backups |
| Performance regression | MEDIUM | Benchmarking, caching, batch writes |
| Migration failures | MEDIUM | Comprehensive migration tests, rollback plan |
| Disk space exhaustion | LOW | Pruning, monitoring, alerts |

---

## 8. Acceptance Criteria

- [ ] All existing 127 tests pass with persistent storage
- [ ] State survives node restart (verified by integration test)
- [ ] Nonce registry prevents replay after restart
- [ ] Block/tx queries < 10ms (p95)
- [ ] Snapshot time reduced by 50%+
- [ ] Storage overhead < 2x in-memory
- [ ] Documentation updated (implementation-status.md, architecture docs)
- [ ] Migration script tested with sample data

---

## 9. Rollout Plan

### Phase A: Development (Days 1-2)
- Implement storage components
- Write unit tests
- Local integration testing

### Phase B: Testing (Day 3)
- Run full test suite
- Performance benchmarking
- Crash recovery testing

### Phase C: Documentation (Day 3)
- Update technical docs
- Write migration guide
- Code review

### Phase D: Deployment (Day 4)
- Merge to main branch
- Update devnet scripts
- Monitor metrics

---

## 10. References

- [LevelDB Documentation](https://github.com/Level/level)
- [EthereumJS Trie](https://github.com/ethereumjs/ethereumjs-monorepo/tree/master/packages/trie)
- [Merkle Patricia Trie Spec](https://ethereum.org/en/developers/docs/data-structures-and-encoding/patricia-merkle-trie/)
- [COC Architecture Docs](./architecture-en.md)

---

**Document Owner**: COC Core Team
**Last Updated**: 2026-02-15
