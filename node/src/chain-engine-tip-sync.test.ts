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

// PR-1G test fixtures: construct a block with a SPECIFIC hash so tests can
// simulate the phantom case (local has hash X at height H, peers have Y).
function mkBlockWithHash(number: number, hash: string): ChainBlock {
  const parent = number > 0
    ? ("0x" + (number - 1).toString(16).padStart(64, "0"))
    : "0x" + "0".repeat(64)
  return {
    number: BigInt(number),
    hash: hash as Hex,
    parentHash: parent as Hex,
    proposer: "0xproposer",
    timestampMs: Date.now(),
    txs: [],
    stateRoot: ("0xst" + number.toString(16).padStart(62, "0")) as Hex,
  } as unknown as ChainBlock
}

test("PR-1G: demoteLatestTo rewrites LATEST to specified height", async () => {
  const db = new MemoryDatabase()
  const idx = new BlockIndex(db)
  for (let n = 1; n <= 5; n++) await idx.putBlock(mkBlock(n))

  const result = await idx.demoteLatestTo(3n)
  assert.equal(result, 3n)
  const latest = await idx.getLatestBlock()
  assert.equal(latest?.number, 3n)
})

test("PR-1G: demoteLatestTo returns null when target height missing", async () => {
  const db = new MemoryDatabase()
  const idx = new BlockIndex(db)
  for (let n = 1; n <= 3; n++) await idx.putBlock(mkBlock(n))

  const result = await idx.demoteLatestTo(99n)
  assert.equal(result, null)
  // LATEST unchanged
  const latest = await idx.getLatestBlock()
  assert.equal(latest?.number, 3n)
})

test("PR-1G: pruneStaleBlocksAfterTip removes b:N and h:hash for N > keepHeight", async () => {
  const db = new MemoryDatabase()
  const idx = new BlockIndex(db)
  for (let n = 1; n <= 5; n++) await idx.putBlock(mkBlock(n))

  const result = await idx.pruneStaleBlocksAfterTip(3n)
  assert.equal(result.pruned, 2, "blocks 4 and 5 pruned")

  assert.equal(await idx.getBlockByNumber(4n), null)
  assert.equal(await idx.getBlockByNumber(5n), null)
  assert.ok(await idx.getBlockByNumber(3n), "blocks <= keepHeight kept")

  // h:hash lookups for pruned blocks should fail too
  const hash4 = "0x" + (4).toString(16).padStart(64, "0")
  assert.equal(await idx.getBlockByHash(hash4 as Hex), null)
})

test("PR-1G: pruneStaleBlocksAfterTip is a no-op when keepHeight >= max", async () => {
  const db = new MemoryDatabase()
  const idx = new BlockIndex(db)
  for (let n = 1; n <= 5; n++) await idx.putBlock(mkBlock(n))

  const result = await idx.pruneStaleBlocksAfterTip(10n)
  assert.equal(result.pruned, 0)
  for (let n = 1; n <= 5; n++) {
    assert.ok(await idx.getBlockByNumber(BigInt(n)))
  }
})

test("PR-1G: verifyAndPromoteTipWithPeers — peer-quorum agrees, no demotion", async () => {
  const { PersistentChainEngine } = await import("./chain-engine-persistent.ts")
  const { EvmChain } = await import("./evm.ts")

  const dataDir = "/tmp/coc-test-pr1g-" + Math.random().toString(36).slice(2)
  const evm = new EvmChain({ chainId: 18780 })
  const engine = new PersistentChainEngine(
    {
      dataDir,
      nodeId: "0xtest",
      chainId: 18780,
      validators: ["0xa", "0xb"],
      finalityDepth: 3,
      maxTxPerBlock: 100,
      minGasPriceWei: 0n,
    },
    evm,
  )
  await engine.init()

  const h1 = "0x" + "1".repeat(64)
  const h2 = "0x" + "2".repeat(64)
  const h3 = "0x" + "3".repeat(64)
  await engine.blockIndex.putBlock(mkBlockWithHash(1, h1))
  await engine.blockIndex.putBlock(mkBlockWithHash(2, h2))
  await engine.blockIndex.putBlock(mkBlockWithHash(3, h3))

  // Peers report the same blocks. Provide blocks with matching number+hash.
  const peerSnapshot = {
    blocks: [
      mkBlockWithHash(1, h1),
      mkBlockWithHash(2, h2),
      mkBlockWithHash(3, h3),
    ],
  }
  const fakeP2P = { async fetchSnapshots() { return [peerSnapshot, peerSnapshot] } }

  const result = await engine.verifyAndPromoteTipWithPeers(fakeP2P)
  assert.equal(result.verified, true)
  assert.equal(result.demoted, false)
  assert.equal(result.reason, "agreed")
  assert.equal(result.peerCount, 2)
  assert.equal((await engine.getTip())?.number, 3n)

  await engine.close()
})

test("PR-1G: verifyAndPromoteTipWithPeers — phantom mismatch demotes to backward-scan match", async () => {
  const { PersistentChainEngine } = await import("./chain-engine-persistent.ts")
  const { EvmChain } = await import("./evm.ts")

  const dataDir = "/tmp/coc-test-pr1g-" + Math.random().toString(36).slice(2)
  const evm = new EvmChain({ chainId: 18780 })
  const engine = new PersistentChainEngine(
    {
      dataDir,
      nodeId: "0xtest",
      chainId: 18780,
      validators: ["0xa", "0xb"],
      finalityDepth: 3,
      maxTxPerBlock: 100,
      minGasPriceWei: 0n,
    },
    evm,
  )
  await engine.init()

  // Local has up to height 5 with phantom hash at 5
  const localH3 = "0x" + "3".repeat(64)
  const localH4 = "0x" + "4".repeat(64)
  const localPhantom5 = "0x" + "5".repeat(64) // <- phantom, peers will disagree
  await engine.blockIndex.putBlock(mkBlockWithHash(3, localH3))
  await engine.blockIndex.putBlock(mkBlockWithHash(4, localH4))
  await engine.blockIndex.putBlock(mkBlockWithHash(5, localPhantom5))

  // Peers have height 4 with the same hash, but no height 5 (or different hash)
  const peerSnapshot = {
    blocks: [
      mkBlockWithHash(3, localH3),
      mkBlockWithHash(4, localH4),
      // peers don't have 5, simulating phantom case
    ],
  }
  const fakeP2P = { async fetchSnapshots() { return [peerSnapshot, peerSnapshot, peerSnapshot] } }

  const result = await engine.verifyAndPromoteTipWithPeers(fakeP2P, { prune: true })
  assert.equal(result.demoted, true)
  assert.equal(result.demotedFrom, 5n)
  assert.equal(result.demotedTo, 4n)
  assert.equal(result.reason, "phantom-mismatch")
  assert.equal(result.peerCount, 3)
  assert.equal(result.prunedCount, 1, "phantom b:5 pruned")
  assert.equal((await engine.getTip())?.number, 4n, "LATEST demoted to 4")
  assert.equal(await engine.getBlockByNumber(5n), null, "phantom block 5 pruned")

  await engine.close()
})

test("PR-1G: verifyAndPromoteTipWithPeers — no peers responding keeps LATEST", async () => {
  const { PersistentChainEngine } = await import("./chain-engine-persistent.ts")
  const { EvmChain } = await import("./evm.ts")

  const dataDir = "/tmp/coc-test-pr1g-" + Math.random().toString(36).slice(2)
  const evm = new EvmChain({ chainId: 18780 })
  const engine = new PersistentChainEngine(
    {
      dataDir,
      nodeId: "0xtest",
      chainId: 18780,
      validators: ["0xa", "0xb"],
      finalityDepth: 3,
      maxTxPerBlock: 100,
      minGasPriceWei: 0n,
    },
    evm,
  )
  await engine.init()

  const h7 = "0x" + "7".repeat(64)
  await engine.blockIndex.putBlock(mkBlockWithHash(7, h7))

  const fakeP2P = { async fetchSnapshots() { return [] } }
  const result = await engine.verifyAndPromoteTipWithPeers(fakeP2P)
  assert.equal(result.verified, false)
  assert.equal(result.demoted, false)
  assert.equal(result.reason, "peers-unreachable")
  assert.equal(result.peerCount, 0)
  assert.equal((await engine.getTip())?.number, 7n, "LATEST kept unchanged")

  await engine.close()
})

test("PR-1G: verifyAndPromoteTipWithPeers — fetchSnapshots throws falls back to no-op", async () => {
  const { PersistentChainEngine } = await import("./chain-engine-persistent.ts")
  const { EvmChain } = await import("./evm.ts")

  const dataDir = "/tmp/coc-test-pr1g-" + Math.random().toString(36).slice(2)
  const evm = new EvmChain({ chainId: 18780 })
  const engine = new PersistentChainEngine(
    {
      dataDir,
      nodeId: "0xtest",
      chainId: 18780,
      validators: ["0xa", "0xb"],
      finalityDepth: 3,
      maxTxPerBlock: 100,
      minGasPriceWei: 0n,
    },
    evm,
  )
  await engine.init()

  const h9 = "0x" + "9".repeat(64)
  await engine.blockIndex.putBlock(mkBlockWithHash(9, h9))

  const fakeP2P = { async fetchSnapshots() { throw new Error("network down") } }
  const result = await engine.verifyAndPromoteTipWithPeers(fakeP2P)
  assert.equal(result.verified, false)
  assert.equal(result.demoted, false)
  assert.equal(result.peerCount, 0)
  assert.equal((await engine.getTip())?.number, 9n)

  await engine.close()
})

test("PR-1G: verifyAndPromoteTipWithPeers — no local tip is a no-op", async () => {
  const { PersistentChainEngine } = await import("./chain-engine-persistent.ts")
  const { EvmChain } = await import("./evm.ts")

  const dataDir = "/tmp/coc-test-pr1g-" + Math.random().toString(36).slice(2)
  const evm = new EvmChain({ chainId: 18780 })
  const engine = new PersistentChainEngine(
    {
      dataDir,
      nodeId: "0xtest",
      chainId: 18780,
      validators: ["0xa"], // single validator skips genesis creation
      finalityDepth: 3,
      maxTxPerBlock: 100,
      minGasPriceWei: 0n,
    },
    evm,
  )
  await engine.init()

  const fakeP2P = { async fetchSnapshots() { return [{ blocks: [] }] } }
  const result = await engine.verifyAndPromoteTipWithPeers(fakeP2P)
  assert.equal(result.verified, false)
  assert.equal(result.demoted, false)
  assert.equal(result.reason, "no-local-tip")

  await engine.close()
})
