/**
 * Persistent Chain Engine tests
 */

import { test } from "node:test"
import assert from "node:assert"
import { PersistentChainEngine } from "./chain-engine-persistent.ts"
import { EvmChain } from "./evm.ts"
import { hashBlockPayload, zeroHash } from "./hash.ts"
import type { ChainBlock, Hex } from "./blockchain-types.ts"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Wallet, parseEther, Transaction } from "ethers"

test("PersistentChainEngine: init and close", async () => {
  const tmpDir = mkdtempSync(join(tmpdir(), "coc-engine-test-"))

  try {
    const evm = await EvmChain.create(2077)
    const engine = new PersistentChainEngine(
      {
        dataDir: tmpDir,
        nodeId: "node1",
        chainId: 2077,
        validators: [],
        finalityDepth: 3,
        maxTxPerBlock: 100,
        minGasPriceWei: 1n,
      },
      evm
    )

    await engine.init()

    const height = await engine.getHeight()
    assert.strictEqual(height, 0n)

    await engine.close()
  } finally {
    rmSync(tmpDir, { recursive: true, force: true })
  }
})

test("PersistentChainEngine: propose and apply block", async () => {
  const tmpDir = mkdtempSync(join(tmpdir(), "coc-engine-test-"))

  try {
    const evm = await EvmChain.create(2077)

    // Prefund an account
    const wallet = Wallet.createRandom()
    await evm.prefund([
      {
        address: wallet.address,
        balanceWei: parseEther("10").toString(),
      },
    ])

    const engine = new PersistentChainEngine(
      {
        dataDir: tmpDir,
        nodeId: "node1",
        chainId: 2077,
        validators: [],
        finalityDepth: 3,
        maxTxPerBlock: 100,
        minGasPriceWei: 1n,
      },
      evm
    )

    await engine.init()

    // Add a transaction to mempool
    const tx = await wallet.signTransaction({
      to: Wallet.createRandom().address,
      value: parseEther("1"),
      gasLimit: 21000,
      gasPrice: 1000000000,
      nonce: 0,
      chainId: 2077,
    })

    await engine.addRawTx(tx as `0x${string}`)

    // Propose block
    const block = await engine.proposeNextBlock()
    assert.ok(block)
    assert.strictEqual(block.number, 1n)
    assert.strictEqual(block.txs.length, 1)

    // Verify block is stored
    const retrieved = await engine.getBlockByNumber(1n)
    assert.ok(retrieved)
    assert.strictEqual(retrieved.hash, block.hash)

    // Verify height
    const height = await engine.getHeight()
    assert.strictEqual(height, 1n)

    await engine.close()
  } finally {
    rmSync(tmpDir, { recursive: true, force: true })
  }
})

test("PersistentChainEngine: persistence across restarts", async () => {
  const tmpDir = mkdtempSync(join(tmpdir(), "coc-engine-test-"))
  const wallet = Wallet.createRandom()

  const prefundAccounts = [
    {
      address: wallet.address,
      balanceWei: parseEther("10").toString(),
    },
  ]

  try {
    let blockHash: string

    // First session: create blocks
    {
      const evm = await EvmChain.create(2077)

      const engine = new PersistentChainEngine(
        {
          dataDir: tmpDir,
          nodeId: "node1",
          chainId: 2077,
          validators: [],
          finalityDepth: 3,
          maxTxPerBlock: 100,
          minGasPriceWei: 1n,
          prefundAccounts,
        },
        evm
      )

      await engine.init()

      // Create 3 blocks
      for (let i = 0; i < 3; i++) {
        const tx = await wallet.signTransaction({
          to: Wallet.createRandom().address,
          value: parseEther("0.1"),
          gasLimit: 21000,
          gasPrice: 1000000000,
          nonce: i,
          chainId: 2077,
        })

        await engine.addRawTx(tx as `0x${string}`)
        const block = await engine.proposeNextBlock()
        assert.ok(block)
      }

      const tip = await engine.getTip()
      blockHash = tip!.hash

      await engine.close()
    }

    // Second session: verify persistence
    {
      const evm = await EvmChain.create(2077)
      const engine = new PersistentChainEngine(
        {
          dataDir: tmpDir,
          nodeId: "node1",
          chainId: 2077,
          validators: [],
          finalityDepth: 3,
          maxTxPerBlock: 100,
          minGasPriceWei: 1n,
          prefundAccounts,
        },
        evm
      )

      await engine.init()

      const height = await engine.getHeight()
      assert.strictEqual(height, 3n)

      const tip = await engine.getTip()
      assert.ok(tip)
      assert.strictEqual(tip.hash, blockHash)

      // Verify all blocks exist
      for (let i = 1n; i <= 3n; i++) {
        const block = await engine.getBlockByNumber(i)
        assert.ok(block)
        assert.strictEqual(block.number, i)
      }

      await engine.close()
    }
  } finally {
    rmSync(tmpDir, { recursive: true, force: true })
  }
})

test("PersistentChainEngine: transaction deduplication", async () => {
  const tmpDir = mkdtempSync(join(tmpdir(), "coc-engine-test-"))

  try {
    const evm = await EvmChain.create(2077)
    const wallet = Wallet.createRandom()
    await evm.prefund([
      {
        address: wallet.address,
        balanceWei: parseEther("10").toString(),
      },
    ])

    const engine = new PersistentChainEngine(
      {
        dataDir: tmpDir,
        nodeId: "node1",
        chainId: 2077,
        validators: [],
        finalityDepth: 3,
        maxTxPerBlock: 100,
        minGasPriceWei: 1n,
      },
      evm
    )

    await engine.init()

    const tx = await wallet.signTransaction({
      to: Wallet.createRandom().address,
      value: parseEther("1"),
      gasLimit: 21000,
      gasPrice: 1000000000,
      nonce: 0,
      chainId: 2077,
    })

    // Add transaction
    await engine.addRawTx(tx as `0x${string}`)

    // Propose block
    await engine.proposeNextBlock()

    // Try to add same transaction again
    await assert.rejects(
      async () => await engine.addRawTx(tx as `0x${string}`),
      /tx already confirmed/
    )

    await engine.close()
  } finally {
    rmSync(tmpDir, { recursive: true, force: true })
  }
})

test("PersistentChainEngine: get transaction by hash", async () => {
  const tmpDir = mkdtempSync(join(tmpdir(), "coc-engine-test-"))

  try {
    const evm = await EvmChain.create(2077)
    const wallet = Wallet.createRandom()
    await evm.prefund([
      {
        address: wallet.address,
        balanceWei: parseEther("10").toString(),
      },
    ])

    const engine = new PersistentChainEngine(
      {
        dataDir: tmpDir,
        nodeId: "node1",
        chainId: 2077,
        validators: [],
        finalityDepth: 3,
        maxTxPerBlock: 100,
        minGasPriceWei: 1n,
      },
      evm
    )

    await engine.init()

    const signedTx = await wallet.signTransaction({
      to: Wallet.createRandom().address,
      value: parseEther("1"),
      gasLimit: 21000,
      gasPrice: 1000000000,
      nonce: 0,
      chainId: 2077,
    })

    await engine.addRawTx(signedTx as `0x${string}`)
    const block = await engine.proposeNextBlock()

    assert.ok(block)
    assert.strictEqual(block.txs.length, 1)

    // Parse raw tx to get the actual hash
    const parsed = Transaction.from(block.txs[0])
    const txHash = parsed.hash as `0x${string}`
    const tx = await engine.getTransactionByHash(txHash)

    assert.ok(tx)
    assert.ok(tx.receipt)
    assert.strictEqual(tx.receipt.blockNumber, 1n)
    assert.strictEqual(tx.receipt.status, 1n)

    await engine.close()
  } finally {
    rmSync(tmpDir, { recursive: true, force: true })
  }
})

test("PersistentChainEngine: rejects block with timestamp before parent", async () => {
  const tmpDir = mkdtempSync(join(tmpdir(), "coc-engine-test-"))

  try {
    const evm = await EvmChain.create(2077)
    const engine = new PersistentChainEngine(
      {
        dataDir: tmpDir,
        nodeId: "node1",
        chainId: 2077,
        validators: [],
        finalityDepth: 3,
        maxTxPerBlock: 100,
        minGasPriceWei: 1n,
      },
      evm,
    )
    await engine.init()

    // Propose first block (locally proposed, bypasses timestamp check)
    const block1 = await engine.proposeNextBlock()
    assert.ok(block1)

    // Build a block with timestamp <= parent
    const parentTimestamp = block1.timestampMs
    const backwardTimestamp = parentTimestamp - 1000
    const blockPayload = {
      number: 2n,
      parentHash: block1.hash,
      proposer: "node1",
      timestampMs: backwardTimestamp,
      txs: [] as string[],
    }
    const hash = hashBlockPayload(blockPayload)
    const badBlock: ChainBlock = { ...blockPayload, hash, finalized: false }

    await assert.rejects(
      () => engine.applyBlock(badBlock, false),
      /block timestamp must be after parent timestamp/,
    )

    await engine.close()
  } finally {
    rmSync(tmpDir, { recursive: true, force: true })
  }
})

test("PersistentChainEngine: rejects block with future timestamp", async () => {
  const tmpDir = mkdtempSync(join(tmpdir(), "coc-engine-test-"))

  try {
    const evm = await EvmChain.create(2077)
    const engine = new PersistentChainEngine(
      {
        dataDir: tmpDir,
        nodeId: "node1",
        chainId: 2077,
        validators: [],
        finalityDepth: 3,
        maxTxPerBlock: 100,
        minGasPriceWei: 1n,
      },
      evm,
    )
    await engine.init()

    // Propose first block
    const block1 = await engine.proposeNextBlock()
    assert.ok(block1)

    // Build a block with timestamp too far in the future
    const futureTimestamp = Date.now() + 120_000 // 2 minutes in future
    const blockPayload = {
      number: 2n,
      parentHash: block1.hash,
      proposer: "node1",
      timestampMs: futureTimestamp,
      txs: [] as string[],
    }
    const hash = hashBlockPayload(blockPayload)
    const badBlock: ChainBlock = { ...blockPayload, hash, finalized: false }

    await assert.rejects(
      () => engine.applyBlock(badBlock, false),
      /block timestamp too far in the future/,
    )

    await engine.close()
  } finally {
    rmSync(tmpDir, { recursive: true, force: true })
  }
})

test("PersistentChainEngine: rejects block with forged cumulativeWeight", async () => {
  const tmpDir = mkdtempSync(join(tmpdir(), "coc-engine-test-"))

  try {
    const evm = await EvmChain.create(2077)
    const engine = new PersistentChainEngine(
      {
        dataDir: tmpDir,
        nodeId: "node1",
        chainId: 2077,
        validators: [],
        finalityDepth: 3,
        maxTxPerBlock: 100,
        minGasPriceWei: 1n,
      },
      evm,
    )
    await engine.init()

    const block1 = await engine.proposeNextBlock()
    assert.ok(block1)

    const payload = {
      number: 2n,
      parentHash: block1.hash,
      proposer: "node1",
      timestampMs: block1.timestampMs + 1,
      txs: [] as string[],
      cumulativeWeight: 999n,
    }
    const badBlock: ChainBlock = {
      ...payload,
      hash: hashBlockPayload(payload),
      finalized: false,
    }

    await assert.rejects(
      () => engine.applyBlock(badBlock, false),
      /invalid cumulativeWeight/,
    )

    await engine.close()
  } finally {
    rmSync(tmpDir, { recursive: true, force: true })
  }
})

test("PersistentChainEngine: importSnapSyncBlocks rejects forged cumulativeWeight", async () => {
  const tmpDir = mkdtempSync(join(tmpdir(), "coc-engine-test-"))

  try {
    const evm = await EvmChain.create(2077)
    const engine = new PersistentChainEngine(
      {
        dataDir: tmpDir,
        nodeId: "node1",
        chainId: 2077,
        validators: [],
        finalityDepth: 3,
        maxTxPerBlock: 100,
        minGasPriceWei: 1n,
      },
      evm,
    )
    await engine.init()

    const payload = {
      number: 1n,
      parentHash: zeroHash(),
      proposer: "node1",
      timestampMs: 1,
      txs: [] as string[],
      cumulativeWeight: 999n,
    }
    const snapshotBlock: ChainBlock = {
      ...payload,
      hash: hashBlockPayload(payload),
      finalized: false,
    }

    const imported = await engine.importSnapSyncBlocks([snapshotBlock])
    assert.strictEqual(imported, false)

    await engine.close()
  } finally {
    rmSync(tmpDir, { recursive: true, force: true })
  }
})

test("PersistentChainEngine: ignores untrusted bftFinalized flag from remote block", async () => {
  const tmpDir = mkdtempSync(join(tmpdir(), "coc-engine-test-"))

  try {
    const evm = await EvmChain.create(2077)
    const engine = new PersistentChainEngine(
      {
        dataDir: tmpDir,
        nodeId: "node1",
        chainId: 2077,
        validators: [],
        finalityDepth: 3,
        maxTxPerBlock: 100,
        minGasPriceWei: 1n,
      },
      evm,
    )
    await engine.init()

    const payload = {
      number: 1n,
      parentHash: zeroHash(),
      proposer: "node1",
      timestampMs: Date.now(),
      txs: [] as string[],
      cumulativeWeight: 1n,
    }
    const block: ChainBlock = {
      ...payload,
      hash: hashBlockPayload(payload),
      finalized: false,
      bftFinalized: true,
    }

    await engine.applyBlock(block, false)
    const tip = await engine.getTip()
    assert.ok(tip)
    assert.strictEqual(tip.bftFinalized, false)

    await engine.close()
  } finally {
    rmSync(tmpDir, { recursive: true, force: true })
  }
})

test("PersistentChainEngine: promotes existing block to bftFinalized on trusted local update", async () => {
  const tmpDir = mkdtempSync(join(tmpdir(), "coc-engine-test-"))

  try {
    const evm = await EvmChain.create(2077)
    const engine = new PersistentChainEngine(
      {
        dataDir: tmpDir,
        nodeId: "node1",
        chainId: 2077,
        validators: [],
        finalityDepth: 3,
        maxTxPerBlock: 100,
        minGasPriceWei: 1n,
      },
      evm,
    )
    await engine.init()

    const block = await engine.proposeNextBlock()
    assert.ok(block)

    await engine.applyBlock({ ...block, bftFinalized: true }, true)
    const tip = await engine.getTip()
    assert.ok(tip)
    assert.strictEqual(tip.bftFinalized, true)

    await engine.close()
  } finally {
    rmSync(tmpDir, { recursive: true, force: true })
  }
})

test("PersistentChainEngine: importSnapSyncBlocks recomputes finality and clears bftFinalized", async () => {
  const tmpDir = mkdtempSync(join(tmpdir(), "coc-engine-test-"))

  try {
    const evm = await EvmChain.create(2077)
    const engine = new PersistentChainEngine(
      {
        dataDir: tmpDir,
        nodeId: "node1",
        chainId: 2077,
        validators: [],
        finalityDepth: 3,
        maxTxPerBlock: 100,
        minGasPriceWei: 1n,
      },
      evm,
    )
    await engine.init()

    const blocks: ChainBlock[] = []
    let parentHash = zeroHash()
    let timestampMs = 1
    for (let n = 1n; n <= 5n; n++) {
      const payload = {
        number: n,
        parentHash,
        proposer: "node1",
        timestampMs,
        txs: [] as string[],
        cumulativeWeight: n,
      }
      const block: ChainBlock = {
        ...payload,
        hash: hashBlockPayload(payload),
        finalized: true,
        bftFinalized: true,
      }
      blocks.push(block)
      parentHash = block.hash
      timestampMs += 1
    }

    const imported = await engine.importSnapSyncBlocks(blocks)
    assert.strictEqual(imported, true)

    const b2 = await engine.getBlockByNumber(2n)
    const b5 = await engine.getBlockByNumber(5n)
    assert.ok(b2)
    assert.ok(b5)
    assert.strictEqual(b2.finalized, true, "height 2 should be finalized at tip 5 depth 3")
    assert.strictEqual(b5.finalized, false, "tip block should not be depth-finalized")
    assert.strictEqual(b2.bftFinalized, false)
    assert.strictEqual(b5.bftFinalized, false)

    await engine.close()
  } finally {
    rmSync(tmpDir, { recursive: true, force: true })
  }
})

test("PersistentChainEngine: importSnapSyncBlocks rejects overlapping ranges", async () => {
  const tmpDirA = mkdtempSync(join(tmpdir(), "coc-engine-test-"))
  const tmpDirB = mkdtempSync(join(tmpdir(), "coc-engine-test-"))

  try {
    const evmA = await EvmChain.create(2077)
    const evmB = await EvmChain.create(2077)
    const local = new PersistentChainEngine(
      {
        dataDir: tmpDirA,
        nodeId: "node1",
        chainId: 2077,
        validators: [],
        finalityDepth: 3,
        maxTxPerBlock: 100,
        minGasPriceWei: 1n,
      },
      evmA,
    )
    const remote = new PersistentChainEngine(
      {
        dataDir: tmpDirB,
        nodeId: "node1",
        chainId: 2077,
        validators: [],
        finalityDepth: 3,
        maxTxPerBlock: 100,
        minGasPriceWei: 1n,
      },
      evmB,
    )
    await local.init()
    await remote.init()

    for (let i = 0; i < 3; i++) {
      await local.proposeNextBlock()
    }
    for (let i = 0; i < 5; i++) {
      await remote.proposeNextBlock()
    }

    const remoteBlocks: ChainBlock[] = []
    for (let n = 2n; n <= 5n; n++) {
      const block = await remote.getBlockByNumber(n)
      assert.ok(block)
      remoteBlocks.push(block)
    }

    const ok = await local.importSnapSyncBlocks(remoteBlocks)
    assert.strictEqual(ok, false, "overlapping snap-sync range should be rejected")

    await local.close()
    await remote.close()
  } finally {
    rmSync(tmpDirA, { recursive: true, force: true })
    rmSync(tmpDirB, { recursive: true, force: true })
  }
})

// --- Phase B contract: speculativelyComputeStateRoot behavior.
// See plans/coc-phase-b-stateroot-vote.md §B2.3-6.
// These tests lock in the "spec root matches apply", "zero side effects",
// "throws → undefined", and "concurrent-safe" invariants that the BFT
// (blockHash, stateRoot) pair quorum relies on.

import { PersistentStateTrie } from "./storage/state-trie.ts"
import { PersistentStateManager } from "./storage/persistent-state-manager.ts"
import { LevelDatabase } from "./storage/db.ts"
import type { IDatabase } from "./storage/db.ts"

interface SpecTestCtx {
  tmpDir: string
  db: IDatabase
  trie: PersistentStateTrie
  evm: EvmChain
  engine: PersistentChainEngine
  wallet: Wallet
  close(): Promise<void>
}

const SPEC_CHAIN_ID = 18780
const SPEC_PK = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"

async function buildSpecCtx(): Promise<SpecTestCtx> {
  const tmpDir = mkdtempSync(join(tmpdir(), "coc-spec-"))
  const db = new LevelDatabase(join(tmpDir, "state"))
  await db.open()
  const trie = new PersistentStateTrie(db)
  await trie.init()
  const sm = new PersistentStateManager(trie)
  const evm = await EvmChain.create(SPEC_CHAIN_ID, sm)
  const wallet = new Wallet(SPEC_PK)
  const engine = new PersistentChainEngine(
    {
      dataDir: tmpDir,
      nodeId: "node-1",
      chainId: SPEC_CHAIN_ID,
      validators: ["node-1"],
      finalityDepth: 3,
      maxTxPerBlock: 50,
      minGasPriceWei: 1n,
      stateTrie: trie,
      prefundAccounts: [{ address: wallet.address, balanceWei: parseEther("100").toString() }],
    },
    evm,
  )
  await engine.init()
  // Produce an empty block 1 so the engine has a tip and prefund is committed.
  await engine.proposeNextBlock()
  return {
    tmpDir,
    db,
    trie,
    evm,
    engine,
    wallet,
    close: async () => {
      await engine.close()
      rmSync(tmpDir, { recursive: true, force: true })
    },
  }
}

async function signTx(wallet: Wallet, nonce: number, to = `0x${"11".repeat(20)}`, value = "0.01"): Promise<Hex> {
  return (await wallet.signTransaction({
    to, value: parseEther(value), gasLimit: 21000, gasPrice: 1_000_000_000,
    nonce, chainId: SPEC_CHAIN_ID,
  })) as Hex
}

test("speculativelyComputeStateRoot: spec root matches post-apply root", async () => {
  const ctx = await buildSpecCtx()
  try {
    await ctx.engine.addRawTx(await signTx(ctx.wallet, 0))
    const candidate = await ctx.engine.proposeNextBlock(true)
    assert.ok(candidate, "deferred-apply proposal must return a block")

    const spec = await ctx.engine.speculativelyComputeStateRoot(candidate!)
    assert.ok(spec, "speculative root must be defined for a well-formed block")

    await ctx.engine.applyBlock(candidate!, true)
    const applied = await ctx.trie.computeStateRoot()
    assert.strictEqual(spec, applied, "spec root must equal apply root")
  } finally {
    await ctx.close()
  }
})

test("speculativelyComputeStateRoot: zero side effects on main trie and LevelDB", async () => {
  const ctx = await buildSpecCtx()
  try {
    await ctx.engine.addRawTx(await signTx(ctx.wallet, 0))
    const candidate = await ctx.engine.proposeNextBlock(true)
    assert.ok(candidate)

    const rootBefore = await ctx.trie.computeStateRoot()
    const stackBefore = (ctx.trie as unknown as { trie: { _db: { checkpoints: unknown[] } } }).trie._db.checkpoints.length

    // Snapshot all state-related LevelDB keys.
    const prefixes = ["s:", "ss:", "c:", "meta:"]
    const keysBefore: string[] = []
    for (const p of prefixes) {
      keysBefore.push(...(await ctx.db.getKeysWithPrefix(p)))
    }
    keysBefore.sort()

    await ctx.engine.speculativelyComputeStateRoot(candidate!)

    const rootAfter = await ctx.trie.computeStateRoot()
    const stackAfter = (ctx.trie as unknown as { trie: { _db: { checkpoints: unknown[] } } }).trie._db.checkpoints.length
    const keysAfter: string[] = []
    for (const p of prefixes) {
      keysAfter.push(...(await ctx.db.getKeysWithPrefix(p)))
    }
    keysAfter.sort()

    assert.strictEqual(rootAfter, rootBefore, "main trie root must not change")
    assert.strictEqual(stackAfter, stackBefore, "main trie checkpoint stack must not change")
    assert.deepStrictEqual(keysAfter, keysBefore, "LevelDB key set must not change")
  } finally {
    await ctx.close()
  }
})

test("speculativelyComputeStateRoot: returns undefined on malformed tx, main unchanged", async () => {
  const ctx = await buildSpecCtx()
  try {
    // Construct a block with a raw tx bytestring that's structurally invalid
    // — the EVM's internal tx decode will throw, the engine catches, we get
    // undefined, and main state stays pristine.
    const good = await signTx(ctx.wallet, 0)
    await ctx.engine.addRawTx(good)
    const base = await ctx.engine.proposeNextBlock(true)
    assert.ok(base)

    // Clone the block and swap its single tx for garbage.
    const malformed: ChainBlock = { ...base!, txs: ["0xdeadbeef"] as Hex[] }
    // Re-hash since txs changed — otherwise the engine's own applyBlock would
    // throw before executeRawTx, but speculative just feeds txs into the EVM
    // so the interior decode throw is what we want to exercise.
    malformed.hash = hashBlockPayload({
      number: malformed.number, parentHash: malformed.parentHash,
      proposer: malformed.proposer, timestampMs: malformed.timestampMs,
      txs: malformed.txs, baseFee: malformed.baseFee,
      cumulativeWeight: malformed.cumulativeWeight,
      blobGasUsed: malformed.blobGasUsed, excessBlobGas: malformed.excessBlobGas,
      parentBeaconBlockRoot: malformed.parentBeaconBlockRoot,
    })

    const rootBefore = await ctx.trie.computeStateRoot()
    const spec = await ctx.engine.speculativelyComputeStateRoot(malformed)
    const rootAfter = await ctx.trie.computeStateRoot()

    assert.strictEqual(spec, undefined, "spec must return undefined on EVM throw")
    assert.strictEqual(rootAfter, rootBefore, "main root unchanged despite spec failure")
  } finally {
    await ctx.close()
  }
})

test("speculativelyComputeStateRoot: concurrent dry-runs don't cross-pollute", async () => {
  const ctx = await buildSpecCtx()
  try {
    // Pin one candidate block and speculate on it twice in parallel. Each
    // call forks its own isolated trie, so the two runs must agree on the
    // post-exec root and never touch the main trie. This covers the
    // "follower processes two back-to-back BFT rounds overlapping" scenario.
    await ctx.engine.addRawTx(await signTx(ctx.wallet, 0))
    const candidate = await ctx.engine.proposeNextBlock(true)
    assert.ok(candidate)

    const rootBefore = await ctx.trie.computeStateRoot()
    const [rootA, rootB] = await Promise.all([
      ctx.engine.speculativelyComputeStateRoot(candidate!),
      ctx.engine.speculativelyComputeStateRoot(candidate!),
    ])
    const rootAfter = await ctx.trie.computeStateRoot()

    assert.ok(rootA, "concurrent call A should return a root")
    assert.ok(rootB, "concurrent call B should return a root")
    assert.strictEqual(rootA, rootB, "two speculative runs of the same block must produce the same root")
    assert.strictEqual(rootAfter, rootBefore, "main root unchanged after concurrent speculations")
  } finally {
    await ctx.close()
  }
})

test("speculativelyComputeStateRoot: empty-block spec root is byte-identical across consecutive empty heights (Phase H1 regression)", async () => {
  // Pins the recurring testnet symptom from 2026-04-30 where proposer's
  // speculative compute on an EMPTY block diverged from non-proposers'
  // identical compute on the same block. Even with no txs, the dry-run
  // mutates BEACON_ROOTS storage via prepareVmForExecution → if the
  // post-apply parent-trie sync is missing, fork inherits a stale
  // account.storageRoot pointer and the resulting root drifts.
  //
  // This test runs two consecutive empty blocks N and N+1 and asserts the
  // speculative root for an EMPTY block at height N+2 is the same value
  // when computed (a) right after applyBlock for N+1, and (b) after
  // applyBlock + an explicit second computeStateRoot pass on the main
  // trie. With H1b's post-apply sync, both paths yield the same root.
  const ctx = await buildSpecCtx()
  try {
    // Two empty blocks to advance state past the one buildSpecCtx already
    // produced (height 1). After this, tip = height 3 with three empty
    // blocks committed, BEACON_ROOTS storage written 3 times.
    const block2 = await ctx.engine.proposeNextBlock(true)
    assert.ok(block2)
    await ctx.engine.applyBlock(block2!, true)
    const block3 = await ctx.engine.proposeNextBlock(true)
    assert.ok(block3)
    await ctx.engine.applyBlock(block3!, true)

    // Build a 4th empty block (deferred apply) and dry-run its
    // speculative compute — this is the path that diverges in production
    // when the parent trie has stale BEACON_ROOTS account pointer.
    const block4 = await ctx.engine.proposeNextBlock(true)
    assert.ok(block4)

    const specA = await ctx.engine.speculativelyComputeStateRoot(block4!)
    assert.ok(specA, "first speculative compute must return a root")

    // Force another sync pass on main trie (idempotent under H1b).
    await ctx.trie.computeStateRoot()

    const specB = await ctx.engine.speculativelyComputeStateRoot(block4!)
    assert.ok(specB, "second speculative compute must return a root")

    assert.strictEqual(
      specA,
      specB,
      "speculative root must be byte-identical across two calls with the same pre-state — proves H1b post-apply sync makes parent trie canonical",
    )

    // And both must equal the actual post-apply root.
    await ctx.engine.applyBlock(block4!, true)
    const applied = await ctx.trie.computeStateRoot()
    assert.strictEqual(specA, applied, "spec root must equal apply root for empty block")
  } finally {
    await ctx.close()
  }
})
