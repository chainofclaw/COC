import test from "node:test"
import assert from "node:assert/strict"
import { BlockIndex } from "./storage/block-index.ts"
import { MemoryDatabase } from "./storage/db.ts"
import type { ChainBlock, Hex } from "./blockchain-types.ts"

/**
 * PR-1D: tip pointer atomicity invariant + auto-repair.
 *
 * 2026-05-10 N=5 attempt #2 fingerprint: server-1 RPC reported h=71448 but
 * eth_getBlockByNumber("0x116ba"=71450) returned a valid block whose
 * stateRoot matched server-2/3. "chain data 写到 disk 但 head pointer 没
 * 更新." The atomic batch in BlockIndex.buildBlockOps writes b:N AND
 * LATEST_BLOCK_KEY together, so the pointer should never lag behind the
 * highest stored block — but in practice it did. Most plausible vector:
 * snap-sync's per-block putBlock loop does not delete b:>peerTip entries
 * left over from a prior run; LATEST gets rewound, but stale b:N>tip
 * remain on disk.
 *
 * Fix: BlockIndex.repairLatestPointer() scans the `b:` prefix, finds
 * the highest block number actually stored, and promotes LATEST_BLOCK_KEY
 * to match if it lags. PersistentChainEngine.init() runs this on every
 * boot so a desync recovers automatically without manual rsync.
 */

function mkBlock(number: number): ChainBlock {
  const hash = ("0x" + number.toString(16).padStart(64, "0")) as Hex
  const parent = number > 0
    ? ("0x" + (number - 1).toString(16).padStart(64, "0"))
    : "0x" + "0".repeat(64)
  return {
    number: BigInt(number),
    hash,
    parentHash: parent as Hex,
    proposer: "0xproposer",
    timestampMs: Date.now(),
    txs: [],
    stateRoot: ("0xst" + number.toString(16).padStart(62, "0")) as Hex,
  } as unknown as ChainBlock
}

test("PR-1D: repairLatestPointer is a no-op when LATEST already matches highest stored", async () => {
  const db = new MemoryDatabase()
  const idx = new BlockIndex(db)

  await idx.putBlock(mkBlock(1))
  await idx.putBlock(mkBlock(2))
  await idx.putBlock(mkBlock(3))

  const result = await idx.repairLatestPointer()
  assert.equal(result.repaired, false)
  assert.equal(result.latestBefore, 3n)
  assert.equal(result.highestStored, 3n)
  const latest = await idx.getLatestBlock()
  assert.equal(latest?.number, 3n)
})

test("PR-1D: repairLatestPointer promotes LATEST when stale block exists above tip", async () => {
  // Reproduce the N=5 attempt #2 desync: b:71450 exists, LATEST=71448.
  const db = new MemoryDatabase()
  const idx = new BlockIndex(db)

  // Put 1..5 normally
  for (let n = 1; n <= 5; n++) await idx.putBlock(mkBlock(n))
  // Force LATEST back to b:3 via direct put (bypass putBlock's atomicity).
  // This is the symptom we're recovering from, not a normal write path.
  await idx.putBlock(mkBlock(3))
  // ... but b:4 and b:5 still exist on disk
  const stale4 = await idx.getBlockByNumber(4n)
  const stale5 = await idx.getBlockByNumber(5n)
  assert.ok(stale4 && stale5, "stale higher blocks still present on disk")
  const beforeLatest = await idx.getLatestBlock()
  assert.equal(beforeLatest?.number, 3n, "LATEST stale at 3")

  const result = await idx.repairLatestPointer()
  assert.equal(result.repaired, true)
  assert.equal(result.latestBefore, 3n)
  assert.equal(result.highestStored, 5n)
  assert.equal(result.latestAfter, 5n)

  const latest = await idx.getLatestBlock()
  assert.equal(latest?.number, 5n, "LATEST promoted to 5")
})

test("PR-1D: repairLatestPointer with empty db returns null state", async () => {
  const db = new MemoryDatabase()
  const idx = new BlockIndex(db)

  const result = await idx.repairLatestPointer()
  assert.equal(result.repaired, false)
  assert.equal(result.latestBefore, null)
  assert.equal(result.highestStored, null)
})

test("PR-1D: repairLatestPointer handles many blocks correctly (lexicographic-vs-numeric)", async () => {
  // Lexicographic key sort places "b:9" > "b:10" > "b:71450". Naive key-based
  // max would mis-rank. The repair must parse numbers and use BigInt comparison.
  const db = new MemoryDatabase()
  const idx = new BlockIndex(db)

  for (const n of [1, 9, 10, 71450, 71449, 71448]) {
    await idx.putBlock(mkBlock(n))
  }
  // After loop, LATEST = the LAST putBlock's data → b:71448 (the last call).
  const before = await idx.getLatestBlock()
  assert.equal(before?.number, 71448n, "LATEST at last-written block")

  const result = await idx.repairLatestPointer()
  assert.equal(result.repaired, true)
  assert.equal(result.highestStored, 71450n, "BigInt-correct max")

  const after = await idx.getLatestBlock()
  assert.equal(after?.number, 71450n, "LATEST promoted to numeric max")
})

test("PR-1D: repairLatestPointer is idempotent across repeated calls", async () => {
  const db = new MemoryDatabase()
  const idx = new BlockIndex(db)

  for (let n = 1; n <= 10; n++) await idx.putBlock(mkBlock(n))
  await idx.putBlock(mkBlock(5)) // rewind LATEST → 5

  const r1 = await idx.repairLatestPointer()
  assert.equal(r1.repaired, true)
  assert.equal(r1.latestAfter, 10n)

  const r2 = await idx.repairLatestPointer()
  assert.equal(r2.repaired, false, "second call no-op")
  assert.equal((await idx.getLatestBlock())?.number, 10n)
})
