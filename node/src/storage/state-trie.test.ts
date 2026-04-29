/**
 * State Trie tests
 */

import { test } from "node:test"
import assert from "node:assert"
import { InMemoryStateTrie, PersistentStateTrie } from "./state-trie.ts"
import { MemoryDatabase, LevelDatabase } from "./db.ts"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const testAccount = {
  nonce: 5n,
  balance: 1000000000000000000n, // 1 ETH in wei
  storageRoot: "0x" + "0".repeat(64),
  codeHash: "0x" + "0".repeat(64),
}

test("InMemoryStateTrie: put and get account", async () => {
  const trie = new InMemoryStateTrie()

  await trie.put("0x1234", testAccount)

  const retrieved = await trie.get("0x1234")
  assert.ok(retrieved)
  assert.strictEqual(retrieved.nonce, 5n)
  assert.strictEqual(retrieved.balance, 1000000000000000000n)
})

test("InMemoryStateTrie: get non-existent account", async () => {
  const trie = new InMemoryStateTrie()

  const account = await trie.get("0x9999")
  assert.strictEqual(account, null)
})

test("InMemoryStateTrie: storage slots", async () => {
  const trie = new InMemoryStateTrie()

  const address = "0xabcd"
  const slot = "0x0000000000000000000000000000000000000000000000000000000000000001"
  const value = "0x0000000000000000000000000000000000000000000000000000000000000042"

  // Initially empty
  const initial = await trie.getStorageAt(address, slot)
  assert.strictEqual(initial, "0x0")

  // Set value
  await trie.putStorageAt(address, slot, value)

  // Retrieve value
  const retrieved = await trie.getStorageAt(address, slot)
  assert.strictEqual(retrieved, value)
})

test("InMemoryStateTrie: contract code", async () => {
  const trie = new InMemoryStateTrie()

  const code = new Uint8Array([0x60, 0x80, 0x60, 0x40]) // Simple bytecode

  // Store code
  const codeHash = await trie.putCode(code)
  assert.ok(codeHash.startsWith("0x"))
  assert.strictEqual(codeHash.length, 66) // 0x + 64 hex chars

  // Retrieve code
  const retrieved = await trie.getCode(codeHash)
  assert.ok(retrieved)
  assert.deepStrictEqual(retrieved, code)
})

test("InMemoryStateTrie: checkpoint and revert", async () => {
  const trie = new InMemoryStateTrie()

  // Initial state
  await trie.put("0x1111", { ...testAccount, nonce: 1n })

  // Checkpoint
  await trie.checkpoint()

  // Modify state
  await trie.put("0x1111", { ...testAccount, nonce: 2n })
  await trie.put("0x2222", { ...testAccount, nonce: 3n })

  // Verify modifications
  const modified1 = await trie.get("0x1111")
  assert.strictEqual(modified1?.nonce, 2n)

  const modified2 = await trie.get("0x2222")
  assert.strictEqual(modified2?.nonce, 3n)

  // Revert
  await trie.revert()

  // State should be restored
  const reverted1 = await trie.get("0x1111")
  assert.strictEqual(reverted1?.nonce, 1n)

  const reverted2 = await trie.get("0x2222")
  assert.strictEqual(reverted2, null)
})

test("InMemoryStateTrie: commit returns state root", async () => {
  const trie = new InMemoryStateTrie()

  await trie.put("0x1111", testAccount)
  await trie.put("0x2222", testAccount)

  const root = await trie.commit()
  assert.ok(root.startsWith("0x"))
  assert.strictEqual(root.length, 66)
})

test("PersistentStateTrie: basic account operations", async () => {
  const db = new MemoryDatabase()
  const trie = new PersistentStateTrie(db)

  await trie.put("0x5678", testAccount)

  const retrieved = await trie.get("0x5678")
  assert.ok(retrieved)
  assert.strictEqual(retrieved.nonce, 5n)
  assert.strictEqual(retrieved.balance, 1000000000000000000n)
})

test("PersistentStateTrie: storage operations", async () => {
  const db = new MemoryDatabase()
  const trie = new PersistentStateTrie(db)

  const address = "0xdead"
  const slot = "0x0000000000000000000000000000000000000000000000000000000000000005"
  const value = "0x00000000000000000000000000000000000000000000000000000000000000ff"

  await trie.putStorageAt(address, slot, value)

  const retrieved = await trie.getStorageAt(address, slot)
  assert.strictEqual(retrieved, value)
})

test("PersistentStateTrie: persistence across instances", async () => {
  const tmpDir = mkdtempSync(join(tmpdir(), "coc-trie-test-"))

  try {
    let stateRoot: string

    // First instance
    {
      const db1 = new LevelDatabase(tmpDir, "state")
      await db1.open()
      const trie1 = new PersistentStateTrie(db1)

      await trie1.put("0xbeef", testAccount)
      stateRoot = await trie1.commit()

      await db1.close()
    }

    // Second instance - simulate restart
    {
      const db2 = new LevelDatabase(tmpDir, "state")
      await db2.open()
      const trie2 = new PersistentStateTrie(db2)
      await trie2.init() // Restore from persisted state root

      // Should retrieve the account
      const retrieved = await trie2.get("0xbeef")
      assert.ok(retrieved)
      assert.strictEqual(retrieved.nonce, 5n)

      // State root should match
      const root2 = await trie2.commit()
      assert.strictEqual(root2, stateRoot)

      await db2.close()
    }
  } finally {
    rmSync(tmpDir, { recursive: true, force: true })
  }
})

test("PersistentStateTrie: multiple accounts", async () => {
  const db = new MemoryDatabase()
  const trie = new PersistentStateTrie(db)

  const accounts = [
    { addr: "0xaaaa", nonce: 1n },
    { addr: "0xbbbb", nonce: 2n },
    { addr: "0xcccc", nonce: 3n },
    { addr: "0xdddd", nonce: 4n },
  ]

  // Put all accounts
  for (const acc of accounts) {
    await trie.put(acc.addr, { ...testAccount, nonce: acc.nonce })
  }

  // Verify all accounts
  for (const acc of accounts) {
    const retrieved = await trie.get(acc.addr)
    assert.ok(retrieved)
    assert.strictEqual(retrieved.nonce, acc.nonce)
  }

  // Commit and verify state root
  const root = await trie.commit()
  assert.ok(root.startsWith("0x"))
})

// --- COW (Copy-on-Write) fork/merge/discard tests ---

test("InMemoryStateTrie: fork creates independent copy", async () => {
  const trie = new InMemoryStateTrie()
  await trie.put("0xaaa1", { ...testAccount, nonce: 10n })
  const forked = await trie.fork()

  // Write to fork should not affect parent
  await forked.put("0xaaa1", { ...testAccount, nonce: 99n })
  await forked.put("0xbbb1", { ...testAccount, nonce: 20n })

  const parentAcc = await trie.get("0xaaa1")
  assert.strictEqual(parentAcc!.nonce, 10n)
  assert.strictEqual(await trie.get("0xbbb1"), null)

  const forkedAcc = await forked.get("0xaaa1")
  assert.strictEqual(forkedAcc!.nonce, 99n)
})

test("InMemoryStateTrie: merge brings fork changes into parent", async () => {
  const trie = new InMemoryStateTrie()
  await trie.put("0xaaa2", { ...testAccount, nonce: 1n })
  const forked = await trie.fork()

  await forked.put("0xbbb2", { ...testAccount, nonce: 2n })
  await forked.put("0xaaa2", { ...testAccount, nonce: 100n })

  await trie.merge(forked)

  const acc1 = await trie.get("0xaaa2")
  assert.strictEqual(acc1!.nonce, 100n) // fork wins
  const acc2 = await trie.get("0xbbb2")
  assert.strictEqual(acc2!.nonce, 2n)
})

test("InMemoryStateTrie: discard clears fork state", async () => {
  const trie = new InMemoryStateTrie()
  await trie.put("0xaaa3", { ...testAccount })
  const forked = await trie.fork()
  forked.discard()

  assert.strictEqual(await forked.get("0xaaa3"), null)
})

test("InMemoryStateTrie: fork preserves storage slots", async () => {
  const trie = new InMemoryStateTrie()
  await trie.put("0xaaa4", { ...testAccount })
  await trie.putStorageAt("0xaaa4", "0x01", "0xff")
  const forked = await trie.fork()

  const val = await forked.getStorageAt("0xaaa4", "0x01")
  assert.strictEqual(val, "0xff")

  // Modify fork storage, parent unaffected
  await forked.putStorageAt("0xaaa4", "0x01", "0xee")
  assert.strictEqual(await trie.getStorageAt("0xaaa4", "0x01"), "0xff")
})

test("PersistentStateTrie: fork creates independent branch", async () => {
  const db = new MemoryDatabase()
  const trie = new PersistentStateTrie(db)
  await trie.put("0xaaa5", { ...testAccount, nonce: 5n })
  await trie.commit()

  const forked = await trie.fork()
  await forked.put("0xaaa5", { ...testAccount, nonce: 50n })
  await forked.commit()

  // Parent unchanged
  const parentAcc = await trie.get("0xaaa5")
  assert.strictEqual(parentAcc!.nonce, 5n)

  const forkedAcc = await forked.get("0xaaa5")
  assert.strictEqual(forkedAcc!.nonce, 50n)
})

test("PersistentStateTrie: discard clears caches", async () => {
  const db = new MemoryDatabase()
  const trie = new PersistentStateTrie(db)
  await trie.put("0xaaa6", { ...testAccount })
  trie.discard()
  // After discard, cache is cleared — get should re-read from DB (which has nothing committed)
  // This tests that discard clears the in-memory caches
})

// --- GH #6 regression: v6 CheckpointDB stack must return to 0 after each
// commit or revert. If commit() doesn't pop the frame, every applyBlock
// leaks a frame and state drifts per-validator under any mid-block revert.
// See plans/coc-evm-abstract-turtle.md (Phase A4).

// Peek into the private v6 Trie instance to read its CheckpointDB stack.
function checkpointStackDepth(trie: PersistentStateTrie): number {
  const t = trie as unknown as { trie: { _db: { checkpoints: unknown[] } } }
  return t.trie._db.checkpoints.length
}

test("PersistentStateTrie: checkpoint/commit leaves stack depth 0", async () => {
  const db = new MemoryDatabase()
  const trie = new PersistentStateTrie(db)

  assert.strictEqual(checkpointStackDepth(trie), 0)

  for (let i = 0; i < 50; i++) {
    await trie.checkpoint()
    assert.strictEqual(checkpointStackDepth(trie), 1, `depth==1 during block ${i}`)
    await trie.put(`0x${(0x1000 + i).toString(16).padStart(40, "0")}`, {
      ...testAccount,
      nonce: BigInt(i),
    })
    await trie.commit()
    assert.strictEqual(checkpointStackDepth(trie), 0, `depth==0 after commit ${i}`)
  }
})

test("PersistentStateTrie: checkpoint/revert leaves stack depth 0 and no partial writes", async () => {
  const db = new MemoryDatabase()
  const trie = new PersistentStateTrie(db)

  // Establish a committed baseline so we can verify revert didn't disturb it.
  const baseAddr = "0xba5e0000000000000000000000000000000ba5e0"
  const transientAddr = "0xdeadbeef0000000000000000000000000000dead"

  await trie.checkpoint()
  await trie.put(baseAddr, { ...testAccount, nonce: 1n })
  const baselineRoot = await trie.commit()
  assert.strictEqual(checkpointStackDepth(trie), 0)

  // Attempt a "block" that checkpoints, writes a transient account, then reverts.
  await trie.checkpoint()
  assert.strictEqual(checkpointStackDepth(trie), 1)
  await trie.put(transientAddr, { ...testAccount, nonce: 99n })
  await trie.revert()
  assert.strictEqual(checkpointStackDepth(trie), 0)

  // The transient account must not be readable — its write must have stayed
  // in the CheckpointDB's keyValueMap and been discarded, never reaching LevelDB.
  assert.strictEqual(await trie.get(transientAddr), null)

  // Root must be restored to the pre-checkpoint value.
  assert.strictEqual(trie.stateRoot(), baselineRoot)

  // Re-opening from the same underlying DB must show no transient writes either.
  const reopened = new PersistentStateTrie(db)
  await reopened.init()
  assert.strictEqual(await reopened.get(transientAddr), null)
  assert.strictEqual(reopened.stateRoot(), baselineRoot)
})

test("PersistentStateTrie: alternating commit/revert cycles keep stack bounded", async () => {
  const db = new MemoryDatabase()
  const trie = new PersistentStateTrie(db)

  // 100 cycles, every third one reverts — models applyBlock's success + failure mix.
  for (let i = 0; i < 100; i++) {
    await trie.checkpoint()
    assert.strictEqual(checkpointStackDepth(trie), 1, `depth==1 mid-cycle ${i}`)
    await trie.put(`0x${(0x2000 + i).toString(16).padStart(40, "0")}`, {
      ...testAccount,
      nonce: BigInt(i),
    })
    if (i % 3 === 0) {
      await trie.revert()
    } else {
      await trie.commit()
    }
    assert.strictEqual(checkpointStackDepth(trie), 0, `depth==0 after cycle ${i}`)
  }
})

test("PersistentStateTrie: nested checkpoints (block + runTx) balance on commit", async () => {
  // Matches applyBlock's actual pattern: evm.checkpointState() stacks a frame
  // on top of the block-level checkpoint every time the EVM enters runTx.
  const db = new MemoryDatabase()
  const trie = new PersistentStateTrie(db)

  const nestedAddr = "0xdeed0000000000000000000000000000deed0001"

  await trie.checkpoint() // outer (block-level)
  assert.strictEqual(checkpointStackDepth(trie), 1)

  await trie.checkpoint() // inner (runTx)
  assert.strictEqual(checkpointStackDepth(trie), 2)

  await trie.put(nestedAddr, { ...testAccount, nonce: 7n })

  await trie.commit() // inner commit (runTx success)
  assert.strictEqual(checkpointStackDepth(trie), 1)

  await trie.commit() // outer commit (block success)
  assert.strictEqual(checkpointStackDepth(trie), 0)

  // Both frames' writes must have flushed to LevelDB on the final pop.
  const reopened = new PersistentStateTrie(db)
  await reopened.init()
  const acc = await reopened.get(nestedAddr)
  assert.ok(acc)
  assert.strictEqual(acc.nonce, 7n)
})

// --- GH #6 follow-up: mid-block storage trie orphans.
// When a new storage trie is created *after* the block-level checkpoint
// (e.g. a contract deploy with putStorageAt on a fresh address), v6 hasn't
// pushed a frame onto that trie — its writes bypass CheckpointDB and land
// directly in LevelDB via the adapter. A subsequent revert() cannot undo
// those writes, but it must not let them surface through the trie either.
// This locks down the *safe* behavior: orphan nodes may remain in LevelDB
// (harmless because MPT nodes are content-addressed and unreachable from
// the reverted account's storageRoot) but cannot influence future reads.

test("PersistentStateTrie: mid-block storage trie writes are orphaned on revert, not reachable", async () => {
  const db = new MemoryDatabase()
  const trie = new PersistentStateTrie(db)

  // Establish a committed baseline — an unrelated account so we can assert
  // revert() didn't rewind anything it shouldn't.
  const baseAddr = "0xba5e0000000000000000000000000000000ba5e1"
  await trie.put(baseAddr, { ...testAccount, nonce: 1n })
  const baselineRoot = await trie.commit()

  const contractAddr = "0xc0ffee00000000000000000000000000c0ffee01"
  const slot = "0x" + "0".repeat(63) + "1"
  const value = "0x" + "0".repeat(62) + "42"

  // "Enter a block" by checkpointing the main trie. The storage trie for
  // contractAddr doesn't exist yet, so it has no frame — this is the
  // scenario: checkpoint → first touch of a fresh storage trie → revert.
  await trie.checkpoint()
  assert.strictEqual(checkpointStackDepth(trie), 1)

  // First storage write on the fresh contract address. Internally this
  // creates a new Trie via getStorageTrie(), which goes directly through
  // the adapter because there's no checkpoint on the new trie.
  await trie.putStorageAt(contractAddr, slot, value)

  // Sanity: the in-memory view during the block sees the write.
  const midBlockRead = await trie.getStorageAt(contractAddr, slot)
  assert.notStrictEqual(midBlockRead, "0x0", "mid-block read should see the write")

  // Simulate block failure — revert the block-level checkpoint.
  await trie.revert()
  assert.strictEqual(checkpointStackDepth(trie), 0)
  assert.strictEqual(trie.stateRoot(), baselineRoot, "root must snap back to baseline")

  // Post-revert, the contract account write (which went through the
  // checkpointed main trie) must be gone — its frame was dropped.
  assert.strictEqual(await trie.get(contractAddr), null, "account must not be reachable")

  // Post-revert, the storage slot must be unreachable via the API.
  // getStorageAt() has no account → emptyRoot fallback → "0x0".
  assert.strictEqual(
    await trie.getStorageAt(contractAddr, slot),
    "0x0",
    "reverted storage must not leak into reads",
  )

  // Known limitation: the orphan nodes from the mid-block write DO remain in
  // LevelDB. They're content-addressed and unreachable from any committed
  // root, so they are dead bytes rather than a correctness issue. We assert
  // their presence here so this behavior stays deliberate — if a future
  // refactor eliminates the orphans, this test should be relaxed rather
  // than silently drift.
  const orphanKeys = await db.getKeysWithPrefix(`ss:${contractAddr}:`)
  assert.ok(orphanKeys.length > 0, "expected orphan storage nodes to be in LevelDB")

  // Re-opening must reflect only the baseline — no ghost slot, no ghost account.
  const reopened = new PersistentStateTrie(db)
  await reopened.init()
  assert.strictEqual(reopened.stateRoot(), baselineRoot)
  assert.strictEqual(await reopened.get(contractAddr), null)
  assert.strictEqual(await reopened.getStorageAt(contractAddr, slot), "0x0")

  // Baseline account must still be intact.
  const baseState = await reopened.get(baseAddr)
  assert.ok(baseState)
  assert.strictEqual(baseState.nonce, 1n)
})

test("PersistentStateTrie: committed mid-block storage writes persist and are reachable", async () => {
  // Counterpart to the orphan test: when the block commits (not reverts),
  // the same mid-block-created storage trie's writes must be part of the
  // final state. Otherwise the "direct-to-LevelDB" path is hiding broken
  // semantics rather than being a deliberate tradeoff.
  const db = new MemoryDatabase()
  const trie = new PersistentStateTrie(db)

  const contractAddr = "0xc0ffee00000000000000000000000000c0ffee02"
  const slot = "0x" + "0".repeat(63) + "1"
  const value = "0x" + "0".repeat(62) + "77"

  await trie.checkpoint()
  await trie.putStorageAt(contractAddr, slot, value)
  const committedRoot = await trie.commit()

  assert.strictEqual(checkpointStackDepth(trie), 0)

  // Immediately readable via the same trie instance.
  assert.strictEqual(await trie.getStorageAt(contractAddr, slot), value)

  // Must survive a fresh open.
  const reopened = new PersistentStateTrie(db)
  await reopened.init()
  assert.strictEqual(reopened.stateRoot(), committedRoot)
  assert.strictEqual(await reopened.getStorageAt(contractAddr, slot), value)
})

// --- Phase B contract: forkForDryRun isolation.
// See plans/coc-phase-b-stateroot-vote.md §B2.1-2.
// These tests lock in the "fork writes must never touch shared LevelDB" and
// "fork mutations don't change the parent's committed root" invariants that
// the speculative BFT stateRoot vote relies on.

// Helper: collect every prefix-tagged key in a MemoryDatabase so we can diff
// before/after snapshots. Walks the store directly via the backing Map since
// getKeysWithPrefix has a prefix filter built in.
async function snapshotAllKeys(db: MemoryDatabase): Promise<string[]> {
  // Grab every top-level prefix used by PersistentStateTrie — "s:" (state
  // trie), "ss:<addr>:" (storage tries), "c:" (code), "meta:" (root pointer).
  const prefixes = ["s:", "ss:", "c:", "meta:"]
  const all: string[] = []
  for (const p of prefixes) {
    const keys = await db.getKeysWithPrefix(p)
    all.push(...keys)
  }
  return all.sort()
}

test("PersistentStateTrie.forkForDryRun: no LevelDB pollution after fork mutations", async () => {
  const db = new MemoryDatabase()
  const trie = new PersistentStateTrie(db)

  // Seed a committed baseline.
  await trie.checkpoint()
  await trie.put("0xba5e0000000000000000000000000000000ba5e0", { ...testAccount, nonce: 1n })
  await trie.put("0xba5e0000000000000000000000000000000ba5e1", { ...testAccount, nonce: 2n })
  await trie.commit()

  const keysBefore = await snapshotAllKeys(db)
  assert.ok(keysBefore.length > 0, "baseline writes should have hit LevelDB")

  // Fork and mutate aggressively: new accounts + storage slots + contract
  // code. Every one of these would land in LevelDB on a real commit.
  const fork = await trie.forkForDryRun()
  for (let i = 0; i < 20; i++) {
    const addr = `0x${(0x4000 + i).toString(16).padStart(40, "0")}`
    await fork.put(addr, { ...testAccount, nonce: BigInt(i + 100) })
    for (let s = 0; s < 5; s++) {
      await fork.putStorageAt(
        addr,
        `0x${s.toString(16).padStart(64, "0")}`,
        `0x${(0xff00 + s).toString(16).padStart(64, "0")}`,
      )
    }
  }
  await fork.putCode(new Uint8Array([0x60, 0x80, 0x60, 0x40, 0x52]))

  // Discard fork by letting it go out of scope — explicit nulling for clarity.
  // Do NOT call fork.commit(); that's the contract the API docstring forbids.

  const keysAfter = await snapshotAllKeys(db)
  assert.deepStrictEqual(
    keysAfter,
    keysBefore,
    "forkForDryRun writes must not reach the shared LevelDB",
  )
})

test("PersistentStateTrie.forkForDryRun: parent root unchanged by fork mutations", async () => {
  const db = new MemoryDatabase()
  const trie = new PersistentStateTrie(db)

  await trie.checkpoint()
  await trie.put("0xcafe000000000000000000000000000000cafe00", { ...testAccount, nonce: 7n })
  await trie.commit()
  const parentRootBefore = trie.computeStateRoot()

  const fork = await trie.forkForDryRun()
  const forkRootBefore = fork.computeStateRoot()
  assert.strictEqual(forkRootBefore, parentRootBefore, "fork starts at parent's committed root")

  // Diverge the fork.
  await fork.put("0xcafe000000000000000000000000000000cafe01", { ...testAccount, nonce: 99n })
  const forkRootAfter = fork.computeStateRoot()
  assert.notStrictEqual(forkRootAfter, parentRootBefore, "fork root advanced after fork put")

  const parentRootAfter = trie.computeStateRoot()
  assert.strictEqual(
    parentRootAfter,
    parentRootBefore,
    "parent root must be unchanged by fork mutations",
  )

  // And a fresh reopen from the same LevelDB sees only the baseline account.
  const reopened = new PersistentStateTrie(db)
  await reopened.init()
  assert.ok(await reopened.get("0xcafe000000000000000000000000000000cafe00"))
  assert.strictEqual(await reopened.get("0xcafe000000000000000000000000000000cafe01"), null)
})

test("PersistentStateTrie.forkForDryRun: parent checkpoint stack unaffected", async () => {
  // Extra safety: forking must not manipulate the parent's v6 CheckpointDB
  // stack. The parent may be in the middle of an applyBlock (one frame
  // from evm.checkpointState, another from stateTrie.checkpoint) when a
  // follower speculatively runs a concurrent dry-run — we can't disturb
  // that stack or Phase A's invariants get broken.
  const db = new MemoryDatabase()
  const trie = new PersistentStateTrie(db)

  await trie.checkpoint()
  await trie.checkpoint() // simulate applyBlock's double checkpoint
  assert.strictEqual(checkpointStackDepth(trie), 2)

  const fork = await trie.forkForDryRun()
  // Fork has its own stack (one frame — the isolation checkpoint).
  assert.strictEqual(checkpointStackDepth(fork as PersistentStateTrie), 1, "fork frame = 1")
  // Parent stack unchanged by fork creation.
  assert.strictEqual(checkpointStackDepth(trie), 2, "parent stack unchanged")

  await fork.put("0xdead0000000000000000000000000000dead0001", { ...testAccount, nonce: 5n })
  assert.strictEqual(checkpointStackDepth(fork as PersistentStateTrie), 1, "fork frame still 1 after put")
  assert.strictEqual(checkpointStackDepth(trie), 2, "parent still 2 after fork put")

  // Drain the parent's stack to prove it's still functional.
  await trie.commit()
  await trie.commit()
  assert.strictEqual(checkpointStackDepth(trie), 0)
})

// stateRoot() committedStateRoot fallback — covers the 2026-04-29 testnet
// recurring corruption where lastStateRoot went null mid-run while disk
// STATE_ROOT_KEY was intact, causing the p2p state-snapshot endpoint to
// fail and BFT to stall for 2 hours.

test("PersistentStateTrie: stateRoot() falls back to committedStateRoot when lastStateRoot is nullified", async () => {
  const db = new MemoryDatabase()
  const trie = new PersistentStateTrie(db)
  await trie.init()

  // Bring the trie to a committed state root.
  await trie.put("0xdead0000000000000000000000000000dead0001", testAccount)
  const committed = await trie.commit()
  assert.strictEqual(trie.stateRoot(), committed, "committed root visible immediately")

  // Simulate the GH#3 incident: a put() invalidates lastStateRoot, but no
  // subsequent commit() refreshes it. Without the fallback, exportStateSnapshot
  // would throw "no committed root" even though disk holds `committed`.
  await trie.put("0xdead0000000000000000000000000000dead0002", { ...testAccount, nonce: 9n })

  // Without commit, lastStateRoot is null — but stateRoot() must still
  // return the last persisted root for snapshot consumers.
  const fallback = trie.stateRoot()
  assert.strictEqual(
    fallback,
    committed,
    "stateRoot() returns committedStateRoot when lastStateRoot is nullified",
  )
})

test("PersistentStateTrie: stateRoot() returns null on a fresh trie before any commit", async () => {
  const db = new MemoryDatabase()
  const trie = new PersistentStateTrie(db)
  await trie.init()
  // Never written, never committed — must still return null (genesis case).
  assert.strictEqual(trie.stateRoot(), null)
})

test("PersistentStateTrie: stateRoot() restored after init() loads STATE_ROOT_KEY", async () => {
  const tmpDir = mkdtempSync(join(tmpdir(), "coc-trie-fallback-"))
  try {
    let committed: string

    // First instance: write + commit, then close.
    {
      const db1 = new LevelDatabase(tmpDir, "state")
      await db1.open()
      const trie1 = new PersistentStateTrie(db1)
      await trie1.init()
      await trie1.put("0xdead0000000000000000000000000000dead0001", testAccount)
      committed = await trie1.commit()
      await db1.close()
    }

    // Second instance: load committedStateRoot from disk via init().
    const db2 = new LevelDatabase(tmpDir, "state")
    await db2.open()
    const trie2 = new PersistentStateTrie(db2)
    await trie2.init()

    // Now simulate a put without commit — lastStateRoot becomes null,
    // but committedStateRoot was just loaded from disk in init().
    await trie2.put("0xdead0000000000000000000000000000dead0002", { ...testAccount, nonce: 7n })
    assert.strictEqual(
      trie2.stateRoot(),
      committed,
      "stateRoot() falls back to disk-loaded committedStateRoot after init()",
    )

    await db2.close()
  } finally {
    rmSync(tmpDir, { recursive: true, force: true })
  }
})

test("PersistentStateTrie: revert restores lastStateRoot from live trie root, not cached checkpoint slot", async () => {
  // Replaces the previous "routes through invalidator" test, which pinned
  // the old buggy behavior where revert() left lastStateRoot null when
  // checkpointStateRoot was null. The fix in this commit reads
  // `trie.root()` after revert — the v6 CheckpointDB has already rolled
  // the underlying root back to the pre-frame state, so we just trust it.
  const db = new MemoryDatabase()
  const trie = new PersistentStateTrie(db)
  await trie.init()
  await trie.put("0xdead0000000000000000000000000000dead0001", testAccount)
  const committed = await trie.commit()

  // A put OUTSIDE any checkpoint changes the root permanently (writes
  // flush through the v6 CheckpointDB adapter to LevelDB). The next
  // checkpoint+revert sequence pops only the empty frame; trie root
  // reflects the put.
  await trie.put("0xdead0000000000000000000000000000dead0002", { ...testAccount, nonce: 9n })
  await trie.checkpoint()
  await trie.revert()

  // After revert, stateRoot() returns the live trie root which reflects
  // both committed account #1 and the post-commit put for #2.
  // Critically, it must NOT be null — that was the bug.
  assert.notStrictEqual(trie.stateRoot(), null, "lastStateRoot must not be null after revert")
  assert.notStrictEqual(trie.stateRoot(), committed, "lastStateRoot must reflect post-commit put #2")
})

test("PersistentStateTrie: nested checkpoint+revert restores correct lastStateRoot", async () => {
  // Reproduces the 2026-04-29 testnet stack trace: eth_call's runCall does
  // checkpoint+simulate+revert. The EVM internally opens nested checkpoints
  // (one per call frame), and the original single-slot checkpointStateRoot
  // cache lost the outer frame's saved root when an inner checkpoint
  // overwrote it with null (because `lastStateRoot` had been invalidated
  // by an intervening put). Outer revert then restored null instead of
  // the original root, leaving the trie permanently broken until the next
  // applyBlock commit.
  //
  // Fix: revert() reads `trie.root()` directly, side-stepping the cached
  // checkpointStateRoot entirely. This test pins the regression.
  const db = new MemoryDatabase()
  const trie = new PersistentStateTrie(db)
  await trie.init()
  await trie.put("0xdead0000000000000000000000000000dead0001", testAccount)
  const committed = await trie.commit()
  assert.strictEqual(trie.stateRoot(), committed)

  // Outer checkpoint (frame A)
  await trie.checkpoint()
  await trie.put("0xdead0000000000000000000000000000dead0002", { ...testAccount, nonce: 2n })
  // Inner checkpoint (frame B) opened while lastStateRoot is null —
  // the previous code captured `checkpointStateRoot = null` here and
  // OVERWROTE the outer frame's saved value of `committed`.
  await trie.checkpoint()
  await trie.put("0xdead0000000000000000000000000000dead0003", { ...testAccount, nonce: 3n })
  // Inner revert (frame B) — should pop frame B; trie root should now
  // reflect just frame A's writes.
  await trie.revert()
  // Outer revert (frame A) — should pop frame A; trie root should now
  // be back to `committed`.
  await trie.revert()

  // The bug manifested as stateRoot() returning null/fallback here
  // instead of the actual restored root.
  assert.strictEqual(
    trie.stateRoot(),
    committed,
    "lastStateRoot must restore to pre-outer-checkpoint root after nested revert",
  )
})

test("PersistentStateTrie: forkForDryRun inherits committedStateRoot for fallback semantics", async () => {
  const db = new MemoryDatabase()
  const parent = new PersistentStateTrie(db)
  await parent.init()
  await parent.put("0xdead0000000000000000000000000000dead0001", testAccount)
  const committed = await parent.commit()

  const fork = await parent.forkForDryRun()
  // Inherits both lastStateRoot and committedStateRoot.
  assert.strictEqual(fork.stateRoot(), committed, "fork starts with parent's committed root")

  // After a put on the fork, fork.lastStateRoot is null but
  // committedStateRoot is still inherited — stateRoot() falls back.
  await fork.put("0xdead0000000000000000000000000000dead0002", { ...testAccount, nonce: 11n })
  assert.strictEqual(
    fork.stateRoot(),
    committed,
    "fork stateRoot() also falls back when its lastStateRoot is nullified",
  )
})
