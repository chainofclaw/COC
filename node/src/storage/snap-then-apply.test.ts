/**
 * Regression for the 2026-04-25 testnet symptom: after a peer-bootstrapped
 * node finishes snap-sync at root R, applying the next block on top of R
 * produces a stateRoot that drops accounts. The chain is fine on long-running
 * peers (node-2/3) but the snap-bootstrapped peer (node-1) ends up alone.
 *
 * Pin: snap-sync import → close → re-init from disk → dual-checkpoint /
 * dual-commit (matching chain-engine-persistent's applyBlock pattern) →
 * accounts must still be readable.
 */

import { describe, it, beforeEach, afterEach } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { LevelDatabase } from "./db.ts"
import { PersistentStateTrie } from "./state-trie.ts"
import { importStateSnapshot } from "../state-snapshot.ts"

let dbDir: string
let db: LevelDatabase

beforeEach(async () => {
  dbDir = mkdtempSync(join(tmpdir(), "coc-snap-apply-"))
  db = new LevelDatabase(dbDir)
  await db.open()
})

afterEach(async () => {
  await db.close()
  rmSync(dbDir, { recursive: true, force: true })
})

const ZERO_HASH = "0x" + "00".repeat(32)
const KECCAK256_RLP_S =
  "0x56e81f171bcc55a6ff8345e692c0f86e5b48e01b996cadc001622fb5e363b421"

async function collect(trie: PersistentStateTrie) {
  const out: Array<{ address: string }> = []
  for await (const a of trie.iterateAccounts()) out.push(a)
  return out
}

function makeSnapshot() {
  // Mix the realistic peer shapes: some accounts with KECCAK256_RLP_S empty
  // root, some with COC sentinel, one contract with storage + code.
  return {
    version: 1 as const,
    stateRoot: "0x" + "ab".repeat(32),  // bogus — we won't pass expectedStateRoot
    blockHeight: "100",
    blockHash: ZERO_HASH,
    createdAtMs: Date.now(),
    accounts: [
      {
        address: "0x" + "11".repeat(20),
        nonce: "1",
        balance: "1000000000000000000",
        storageRoot: ZERO_HASH,
        codeHash: ZERO_HASH,
        storage: [],
      },
      {
        address: "0x" + "22".repeat(20),
        nonce: "5",
        balance: "5000000000000000000",
        storageRoot: KECCAK256_RLP_S,
        codeHash: ZERO_HASH,
        storage: [],
      },
      {
        address: "0x" + "33".repeat(20),
        nonce: "0",
        balance: "0",
        storageRoot: "0x" + "ee".repeat(32), // peer's contract storage root
        codeHash: "0x" + "cd".repeat(32),
        storage: [
          { slot: "0x" + "00".repeat(32), value: "0x" + "11".repeat(32) },
          { slot: "0x" + "01" + "00".repeat(31), value: "0x" + "22".repeat(32) },
        ],
        code: "0x6080604052",
      },
    ],
  }
}

describe("snap-sync import + applyBlock dual-checkpoint pattern", () => {
  it("STATE_ROOT_KEY must NOT be persisted while outer checkpoints remain on stack", async () => {
    // Direct pin for the 2026-04-25 node-1 corruption: when applyBlock takes
    // two checkpoints and calls commit twice, the inner commit must NOT
    // persist STATE_ROOT_KEY — its trie.commit() only merges into the outer
    // frame, the root node is still in CheckpointDB memory. Persisting
    // STATE_ROOT_KEY at that moment names a hash whose node will not reach
    // LevelDB if the process is interrupted before the outer commit runs.
    //
    // Verify by simulating crash between inner and outer commit: inner
    // commit, *no* outer commit, close db, reopen — STATE_ROOT_KEY should
    // still point at the pre-block root (rolled back by virtue of never
    // being persisted), not at an orphan root.
    {
      const trie = new PersistentStateTrie(db)
      await trie.init()
      await importStateSnapshot(trie, makeSnapshot())
    }
    await db.close()
    db = new LevelDatabase(dbDir)
    await db.open()

    const preApplyRoot = await (async () => {
      const trie = new PersistentStateTrie(db)
      await trie.init()
      return trie.stateRoot()
    })()
    assert.ok(preApplyRoot, "snap-sync must persist a root for the test baseline")

    // Simulate crash mid-applyBlock: dual checkpoint + put + INNER commit
    // only (skip the outer commit), then close.
    {
      const trie = new PersistentStateTrie(db)
      await trie.init()
      await trie.checkpoint()
      await trie.checkpoint()
      const target = "0x" + "11".repeat(20)
      const cur = await trie.get(target)
      assert.ok(cur)
      await trie.put(target, { ...cur, nonce: cur.nonce + 1n })
      await trie.commit() // inner commit only — outer remains on stack
      // intentionally NOT calling outer trie.commit()
    }
    await db.close()
    db = new LevelDatabase(dbDir)
    await db.open()

    // After "crash + restart", STATE_ROOT_KEY must still point at preApplyRoot
    // (because the inner commit's persist was suppressed). If it points at
    // some new root whose node isn't in db, init() loads a dangling root
    // and accounts vanish.
    const trie = new PersistentStateTrie(db)
    await trie.init()
    assert.equal(
      trie.stateRoot(),
      preApplyRoot,
      "STATE_ROOT_KEY must NOT have advanced past the pre-checkpoint root when only the inner commit ran",
    )
    const acc = await collect(trie)
    assert.equal(acc.length, 3, "accounts must remain visible after simulated crash")
  })


  it("STATE_ROOT_KEY after dual-commit must point at a root whose nodes are persisted (with db close/reopen)", async () => {
    // Tighter pin for the GH#3 block-apply symptom: after the dual-checkpoint
    // / dual-commit sequence completes, the database is *closed and
    // reopened* — mirroring container restart on testnet. If dual-commit
    // failed to actually flush all trie nodes to LevelDB, reopen sees a
    // STATE_ROOT_KEY pointing at an orphaned root → 0 accounts iterate.
    //
    // Phase 1: import snapshot.
    {
      const trie = new PersistentStateTrie(db)
      await trie.init()
      await importStateSnapshot(trie, makeSnapshot())
    }
    await db.close()
    db = new LevelDatabase(dbDir)
    await db.open()

    // Phase 2: reopen, dual-checkpoint + put + dual-commit.
    let postCommitRoot: string | null
    {
      const trie = new PersistentStateTrie(db)
      await trie.init()
      const beforeCount = (await collect(trie)).length
      assert.equal(beforeCount, 3, "phase 2: post-reopen must hold 3 accounts")

      await trie.checkpoint()
      await trie.checkpoint()
      const target = "0x" + "11".repeat(20)
      const cur = await trie.get(target)
      assert.ok(cur)
      await trie.put(target, { ...cur, nonce: cur.nonce + 1n })
      await trie.commit()
      await trie.commit()
      postCommitRoot = trie.stateRoot()
      assert.ok(postCommitRoot)
    }
    await db.close()
    db = new LevelDatabase(dbDir)
    await db.open()

    // Phase 3: re-init from disk only. If dual-commit didn't actually flush
    // to LevelDB, init() finds STATE_ROOT_KEY but the trie at that root has
    // no nodes → 0 iteration.
    {
      const trie = new PersistentStateTrie(db)
      await trie.init()
      const after = await collect(trie)
      assert.equal(
        after.length,
        3,
        `phase 3 post-reopen: must still iterate 3 accounts (got ${after.length}). ` +
        `If 0, STATE_ROOT_KEY persisted a root whose nodes never reached LevelDB.`,
      )
      assert.equal(trie.stateRoot(), postCommitRoot, "stateRoot must persist across reopen")
    }
  })

  it("long-running mixed-mutation applies (storage + new accounts + deletes) → close/reopen", async () => {
    // More aggressive repro: each block performs storage writes on the
    // contract from snap-sync, plus alternates new-account creation and
    // account deletion. This exercises the full account+storage trie
    // checkpoint/commit interaction over many cycles.
    {
      const trie = new PersistentStateTrie(db)
      await trie.init()
      await importStateSnapshot(trie, makeSnapshot())
    }
    await db.close()
    db = new LevelDatabase(dbDir)
    await db.open()

    let postCommitRoot: string | null = null
    {
      const trie = new PersistentStateTrie(db)
      await trie.init()
      const contract = "0x" + "33".repeat(20)

      for (let i = 0; i < 50; i++) {
        await trie.checkpoint()
        await trie.checkpoint()

        // Storage write on the snap'd contract (mid-checkpoint storage trie).
        const slot = "0x" + i.toString(16).padStart(64, "0")
        await trie.putStorageAt(contract, slot, "0x" + (i + 1).toString(16).padStart(64, "0"))

        // Alternate: even blocks create a new account, odd delete it.
        const ephemeral = "0x" + i.toString(16).padStart(40, "0")
        if (i % 2 === 0) {
          await trie.put(ephemeral, {
            nonce: BigInt(i),
            balance: BigInt(i * 100),
            storageRoot: ZERO_HASH,
            codeHash: ZERO_HASH,
          })
        } else {
          await trie.delete(ephemeral)
        }

        // Modify the well-known validator account each block.
        const target = "0x" + "11".repeat(20)
        const cur = await trie.get(target)
        assert.ok(cur, `block ${i}: target must persist`)
        await trie.put(target, { ...cur, nonce: cur.nonce + 1n, balance: cur.balance + 1n })

        await trie.commit()
        await trie.commit()
      }
      postCommitRoot = trie.stateRoot()
    }
    await db.close()
    db = new LevelDatabase(dbDir)
    await db.open()

    const trie = new PersistentStateTrie(db)
    await trie.init()
    const acc = await collect(trie)
    assert.ok(
      acc.length >= 3,
      `after 50 mixed applies + reopen: must iterate ≥3 accounts (got ${acc.length})`,
    )
    assert.equal(trie.stateRoot(), postCommitRoot)
    // Spot-check: validator account survived all bumps.
    const target = await trie.get("0x" + "11".repeat(20))
    assert.ok(target, "validator account must survive 50 applies")
    assert.equal(target.nonce, 1n + 50n)
  })

  it("long-running same-process applies then SINGLE close/reopen — accounts must persist", async () => {
    // testnet symptom on bisect: multiple block applies happened in the same
    // process (no close between blocks), and only AFTER the eventual restart
    // did the failure surface. Mimic that: snap-sync, run 50 dual-commit
    // applies on the same trie object, *then* close+reopen, then verify.
    let postCommitRoot: string | null = null
    {
      const trie = new PersistentStateTrie(db)
      await trie.init()
      await importStateSnapshot(trie, makeSnapshot())

      const target = "0x" + "11".repeat(20)
      for (let i = 0; i < 50; i++) {
        await trie.checkpoint()
        await trie.checkpoint()
        const cur = await trie.get(target)
        assert.ok(cur, `apply ${i}: target account must remain present`)
        await trie.put(target, { ...cur, nonce: cur.nonce + 1n })
        await trie.commit()
        await trie.commit()
      }
      postCommitRoot = trie.stateRoot()
    }
    await db.close()
    db = new LevelDatabase(dbDir)
    await db.open()

    const trie = new PersistentStateTrie(db)
    await trie.init()
    const acc = await collect(trie)
    assert.equal(
      acc.length,
      3,
      `after 50 same-process applies + restart: must iterate 3 accounts (got ${acc.length}). ` +
      `If 0, on-disk state silently corrupted across applies.`,
    )
    assert.equal(trie.stateRoot(), postCommitRoot)
  })

  it("sequential dual-commit applies then close/reopen — accounts must persist", async () => {
    // The testnet manifestation needed multiple applyBlock cycles before the
    // failure surfaced on restart. Simulate: snap-sync, then many dual-commit
    // mutations (each modeling one block), then close/reopen, then verify.
    {
      const trie = new PersistentStateTrie(db)
      await trie.init()
      await importStateSnapshot(trie, makeSnapshot())
    }
    await db.close()
    db = new LevelDatabase(dbDir)
    await db.open()

    // Run 30 "blocks" — each is dual-checkpoint + put + dual-commit, like
    // chain-engine-persistent.applyBlock minus tx execution.
    const target = "0x" + "11".repeat(20)
    for (let i = 0; i < 30; i++) {
      const trie = new PersistentStateTrie(db)
      await trie.init()
      await trie.checkpoint()
      await trie.checkpoint()
      const cur = await trie.get(target)
      assert.ok(cur, `block ${i}: target account must be present`)
      await trie.put(target, { ...cur, nonce: cur.nonce + 1n })
      await trie.commit()
      await trie.commit()
      await db.close()
      db = new LevelDatabase(dbDir)
      await db.open()
    }

    // After 30 blocks of close/reopen, verify final state.
    const trie = new PersistentStateTrie(db)
    await trie.init()
    const acc = await collect(trie)
    assert.equal(acc.length, 3, `after 30 blocks: must still iterate 3 accounts (got ${acc.length})`)
    const final = await trie.get(target)
    assert.ok(final)
    assert.equal(final.nonce, 1n + 30n, "30 nonce bumps must accumulate")
  })

  it("preserves accounts across snap-sync → close → reopen → dual-checkpoint commit cycle", async () => {
    // ── Phase 1: snap-sync into a fresh trie, commit, close.
    {
      const trie = new PersistentStateTrie(db)
      await trie.init()
      await importStateSnapshot(trie, makeSnapshot())
      const accounts = []
      for await (const a of trie.iterateAccounts()) accounts.push(a)
      assert.equal(accounts.length, 3, "phase 1: snap-sync must import 3 accounts")
      // intentionally do NOT close; LevelDatabase shared across phases via beforeEach db
    }

    // ── Phase 2: simulate process restart by re-init'ing from the same db
    //    and exercising chain-engine-persistent's dual-checkpoint pattern.
    const trie = new PersistentStateTrie(db)
    await trie.init()

    const before = []
    for await (const a of trie.iterateAccounts()) before.push(a)
    assert.equal(before.length, 3, "phase 2: post-reopen trie must still hold 3 accounts")

    // chain-engine-persistent.applyBlock pushes TWO checkpoints (one via the
    // EVM stateManager wrapper, one directly on stateTrie). We simulate with
    // explicit double-checkpoint and double-commit on the same trie object
    // (in production they go through PersistentStateManager, which delegates
    // to stateTrie verbatim).
    await trie.checkpoint()
    await trie.checkpoint()

    // Apply a "block" — bump nonce + balance on one of the snap'd accounts.
    const target = "0x" + "11".repeat(20)
    const cur = await trie.get(target)
    assert.ok(cur, "applied-block target account must be in trie")
    await trie.put(target, {
      nonce: cur.nonce + 1n,
      balance: cur.balance + 100n,
      storageRoot: cur.storageRoot,
      codeHash: cur.codeHash,
    })

    // Commit twice — matches evm.commitState() then stateTrie.commit() in
    // chain-engine-persistent.
    await trie.commit()
    await trie.commit()

    const after = []
    for await (const a of trie.iterateAccounts()) after.push(a)
    assert.equal(
      after.length,
      3,
      `phase 2 post-apply: accounts must remain 3 (got ${after.length}). ` +
      `If this drops to 0 the GH#3 block-apply trie corruption is reproduced.`,
    )

    // Verify the bumped account picked up the new nonce+balance.
    const bumped = await trie.get(target)
    assert.ok(bumped)
    assert.equal(bumped.nonce, 2n, "bump must persist")
    assert.equal(bumped.balance, 1000000000000000100n, "bump balance must persist")
  })
})
