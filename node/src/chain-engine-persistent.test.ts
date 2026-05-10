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
import { createNodeSigner } from "./crypto/signer.ts"

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

test("PersistentChainEngine: importSnapSyncBlocks trims overlapping ranges (Phase H14)", async () => {
  // Pre-H14 this rejected the entire import when the snapshot window
  // overlapped local chain. That blocked divergence-recovery snap-sync
  // (where the chain-snapshot RPC always returns ~last 100 blocks
  // overlapping a healthy local chain). Post-H14 we trim to blocks
  // strictly above currentHeight and import the remainder.
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

    // Local height = 3. Snapshot window = [2..5]. Pre-H14 → rejected.
    // Post-H14 → trimmed to [4..5] and imported.
    const ok = await local.importSnapSyncBlocks(remoteBlocks)
    assert.strictEqual(ok, true, "overlapping snap-sync range should be trimmed and imported")

    // Sub-window check: blocks 4 and 5 should now exist on local
    const block4 = await local.getBlockByNumber(4n)
    const block5 = await local.getBlockByNumber(5n)
    assert.ok(block4, "trimmed block 4 should be imported")
    assert.ok(block5, "trimmed block 5 should be imported")
    // Their hashes should match remote's
    assert.strictEqual(block4!.hash, remoteBlocks[2].hash)
    assert.strictEqual(block5!.hash, remoteBlocks[3].hash)

    // Edge case: snapshot fully behind local rejects (no blocks left
    // after trim → false return)
    const fullyBehind: ChainBlock[] = []
    for (let n = 1n; n <= 2n; n++) {
      const block = await remote.getBlockByNumber(n)
      assert.ok(block)
      fullyBehind.push(block)
    }
    const okBehind = await local.importSnapSyncBlocks(fullyBehind)
    assert.strictEqual(okBehind, false, "snapshot fully behind local should reject")

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

test("Phase I1: block reward credits proposer balance after each block", async () => {
  // Sprint I1 acceptance test. With enableBlockReward=true and a fixed reward
  // per block, the proposer's balance must equal N * reward after N blocks
  // (genesis excluded — height 0 mints nothing). Halving doesn't trigger on
  // these test heights because halvingInterval is set astronomically high.
  const tmpDir = mkdtempSync(join(tmpdir(), "coc-i1-"))
  const db = new LevelDatabase(join(tmpDir, "state"))
  await db.open()
  const trie = new PersistentStateTrie(db)
  await trie.init()
  const sm = new PersistentStateManager(trie)
  const evm = await EvmChain.create(SPEC_CHAIN_ID, sm)
  const proposerWallet = Wallet.createRandom()
  const REWARD = 500_000_000_000_000_000n // 0.5 ETH per block

  const engine = new PersistentChainEngine(
    {
      dataDir: tmpDir,
      nodeId: proposerWallet.address,
      chainId: SPEC_CHAIN_ID,
      validators: [proposerWallet.address],
      finalityDepth: 3,
      maxTxPerBlock: 50,
      minGasPriceWei: 1n,
      stateTrie: trie,
      enableBlockReward: true,
      blockRewardWei: REWARD,
      blockRewardHalvingInterval: 1_000_000_000n,
    },
    evm,
  )
  await engine.init()

  try {
    // Read initial balance — should be 0 since no prefund.
    const balanceBefore = await evm.getBalance(proposerWallet.address)
    assert.strictEqual(balanceBefore, 0n, "proposer starts with zero balance")

    // Propose 5 empty blocks.
    const N = 5
    for (let i = 0; i < N; i++) {
      const block = await engine.proposeNextBlock()
      assert.ok(block, `block ${i + 1} should be proposed`)
    }

    // After N blocks, proposer balance == N * reward.
    const balanceAfter = await evm.getBalance(proposerWallet.address)
    assert.strictEqual(
      balanceAfter,
      BigInt(N) * REWARD,
      `proposer balance after ${N} blocks must equal ${N}*reward`,
    )
  } finally {
    await engine.close()
    rmSync(tmpDir, { recursive: true, force: true })
  }
})

test("Phase I1: block reward disabled by default leaves proposer balance unchanged", async () => {
  // Regression: enableBlockReward defaults to false; flipping to true is the
  // only path to mint. Confirms a missing-or-undefined flag is a hard no-op.
  const tmpDir = mkdtempSync(join(tmpdir(), "coc-i1off-"))
  const db = new LevelDatabase(join(tmpDir, "state"))
  await db.open()
  const trie = new PersistentStateTrie(db)
  await trie.init()
  const sm = new PersistentStateManager(trie)
  const evm = await EvmChain.create(SPEC_CHAIN_ID, sm)
  const proposerWallet = Wallet.createRandom()

  const engine = new PersistentChainEngine(
    {
      dataDir: tmpDir,
      nodeId: proposerWallet.address,
      chainId: SPEC_CHAIN_ID,
      validators: [proposerWallet.address],
      finalityDepth: 3,
      maxTxPerBlock: 50,
      minGasPriceWei: 1n,
      stateTrie: trie,
      // enableBlockReward not set → falsy → reward path skipped
      blockRewardWei: 500_000_000_000_000_000n,
    },
    evm,
  )
  await engine.init()

  try {
    for (let i = 0; i < 3; i++) {
      const block = await engine.proposeNextBlock()
      assert.ok(block)
    }
    const balance = await evm.getBalance(proposerWallet.address)
    assert.strictEqual(balance, 0n, "no reward when flag is false")
  } finally {
    await engine.close()
    rmSync(tmpDir, { recursive: true, force: true })
  }
})

test("Phase I1: speculative compute matches post-apply root with rewards enabled", async () => {
  // Critical consensus invariant: when block rewards are on, the speculative
  // compute path must mirror the apply path's reward credit. Otherwise the
  // BFT (hash, stateRoot) joint quorum would always fail because proposer's
  // declared root (with reward credit) != non-proposer's spec root (without).
  const tmpDir = mkdtempSync(join(tmpdir(), "coc-i1-spec-"))
  const db = new LevelDatabase(join(tmpDir, "state"))
  await db.open()
  const trie = new PersistentStateTrie(db)
  await trie.init()
  const sm = new PersistentStateManager(trie)
  const evm = await EvmChain.create(SPEC_CHAIN_ID, sm)
  const proposerWallet = Wallet.createRandom()

  const engine = new PersistentChainEngine(
    {
      dataDir: tmpDir,
      nodeId: proposerWallet.address,
      chainId: SPEC_CHAIN_ID,
      validators: [proposerWallet.address],
      finalityDepth: 3,
      maxTxPerBlock: 50,
      minGasPriceWei: 1n,
      stateTrie: trie,
      enableBlockReward: true,
      blockRewardWei: 1_000_000_000_000_000_000n,
      blockRewardHalvingInterval: 1_000_000_000n,
    },
    evm,
  )
  await engine.init()

  try {
    // Build block 1 in deferred-apply mode (proposeNextBlock(true)) so we can
    // dry-run the spec root before applyBlock commits, then assert equality.
    const block1 = await engine.proposeNextBlock(true)
    assert.ok(block1)

    const specRoot = await engine.speculativelyComputeStateRoot(block1!)
    assert.ok(specRoot, "spec compute must return a root")

    await engine.applyBlock(block1!, true)
    const appliedRoot = await trie.computeStateRoot()

    assert.strictEqual(
      specRoot,
      appliedRoot,
      "speculative root must equal apply root when both paths credit the proposer reward",
    )
  } finally {
    await engine.close()
    rmSync(tmpDir, { recursive: true, force: true })
  }
})

test("Phase I2: tx priority fee credits proposer, base fee implicitly burned", async () => {
  // Sprint I2 acceptance: a single tx with non-zero maxPriorityFeePerGas must
  // credit `gasUsed * priorityFee` to the block proposer. Sender pays full
  // `gasUsed * effectivePrice + value`. Base fee component disappears from
  // supply (sender lost it; coinbase only got priority).
  const tmpDir = mkdtempSync(join(tmpdir(), "coc-i2-"))
  const db = new LevelDatabase(join(tmpDir, "state"))
  await db.open()
  const trie = new PersistentStateTrie(db)
  await trie.init()
  const sm = new PersistentStateManager(trie)
  const evm = await EvmChain.create(SPEC_CHAIN_ID, sm)
  const proposerWallet = Wallet.createRandom()
  const senderWallet = new Wallet(SPEC_PK)
  const recipientWallet = Wallet.createRandom()

  const SENDER_INITIAL = parseEther("100")
  const TX_VALUE = parseEther("0.5")

  const engine = new PersistentChainEngine(
    {
      dataDir: tmpDir,
      nodeId: proposerWallet.address,
      chainId: SPEC_CHAIN_ID,
      validators: [proposerWallet.address],
      finalityDepth: 3,
      maxTxPerBlock: 50,
      minGasPriceWei: 1n,
      stateTrie: trie,
      // Block reward off — isolate I2 fee accounting.
      enableFeeDistribution: true,
      prefundAccounts: [{ address: senderWallet.address, balanceWei: SENDER_INITIAL.toString() }],
    },
    evm,
  )
  await engine.init()

  try {
    // Set baseFee high enough to be observable. After empty block 1, baseFee
    // decreases per EIP-1559 toward MIN_BASE_FEE = 1 gwei. We send a tx with
    // explicit maxFeePerGas and maxPriorityFeePerGas.
    await engine.proposeNextBlock() // block 1 (empty, settles base fee)

    const senderBalanceBefore = await evm.getBalance(senderWallet.address)
    const proposerBalanceBefore = await evm.getBalance(proposerWallet.address)
    assert.strictEqual(proposerBalanceBefore, 0n, "proposer starts with zero balance")

    const MAX_FEE = 5_000_000_000n // 5 gwei
    const MAX_PRIORITY = 2_000_000_000n // 2 gwei
    const tx = await senderWallet.signTransaction({
      to: recipientWallet.address,
      value: TX_VALUE,
      gasLimit: 21000,
      maxFeePerGas: MAX_FEE,
      maxPriorityFeePerGas: MAX_PRIORITY,
      type: 2,
      nonce: 0,
      chainId: SPEC_CHAIN_ID,
    })
    await engine.addRawTx(tx as Hex)
    const block2 = await engine.proposeNextBlock()
    assert.ok(block2)
    assert.strictEqual(block2!.txs.length, 1, "block must include the tx")

    // Compute expected priority credit. baseFee in block2 ≈ MIN_BASE_FEE (1 gwei)
    // because block 1 was empty (gasUsed=0 < target). Priority per gas =
    // min(MAX_PRIORITY, MAX_FEE - baseFee). With baseFee=1 gwei, that's
    // min(2 gwei, 4 gwei) = 2 gwei. Total priority = 21000 * 2 gwei.
    const baseFee = block2!.baseFee ?? 0n
    const priorityPerGas = MAX_PRIORITY < (MAX_FEE - baseFee) ? MAX_PRIORITY : (MAX_FEE - baseFee)
    const expectedProposerCredit = 21000n * priorityPerGas
    const expectedEffectivePrice = baseFee + priorityPerGas
    const expectedSenderLoss = 21000n * expectedEffectivePrice + TX_VALUE

    const senderBalanceAfter = await evm.getBalance(senderWallet.address)
    const proposerBalanceAfter = await evm.getBalance(proposerWallet.address)
    const recipientBalanceAfter = await evm.getBalance(recipientWallet.address)

    assert.strictEqual(
      proposerBalanceAfter,
      expectedProposerCredit,
      `proposer must receive exactly priorityFee*gasUsed = ${expectedProposerCredit}`,
    )
    assert.strictEqual(
      senderBalanceBefore - senderBalanceAfter,
      expectedSenderLoss,
      `sender must lose exactly effectivePrice*gasUsed + value`,
    )
    assert.strictEqual(
      recipientBalanceAfter,
      TX_VALUE,
      "recipient receives only the value (no fees)",
    )

    // Wei-precise burn invariant:
    //   senderLoss == proposerCredit + recipientBalance + burnedBaseFee
    // where burnedBaseFee = baseFee * gasUsed (vanishes from supply).
    const burnedBaseFee = baseFee * 21000n
    assert.strictEqual(
      senderBalanceBefore - senderBalanceAfter,
      proposerBalanceAfter + recipientBalanceAfter + burnedBaseFee,
      "wei-precise: sender_loss == proposer + recipient + burned_base_fee",
    )
  } finally {
    await engine.close()
    rmSync(tmpDir, { recursive: true, force: true })
  }
})

test("Phase I2: zero-priority tx still burns base fee and credits zero priority", async () => {
  // Edge case: maxPriorityFeePerGas = 0 means proposer gets nothing, all the
  // gas cost is base fee burn. Sender still pays full baseFee*gasUsed.
  const tmpDir = mkdtempSync(join(tmpdir(), "coc-i2-zero-"))
  const db = new LevelDatabase(join(tmpDir, "state"))
  await db.open()
  const trie = new PersistentStateTrie(db)
  await trie.init()
  const sm = new PersistentStateManager(trie)
  const evm = await EvmChain.create(SPEC_CHAIN_ID, sm)
  const proposerWallet = Wallet.createRandom()
  const senderWallet = new Wallet(SPEC_PK)

  const engine = new PersistentChainEngine(
    {
      dataDir: tmpDir,
      nodeId: proposerWallet.address,
      chainId: SPEC_CHAIN_ID,
      validators: [proposerWallet.address],
      finalityDepth: 3,
      maxTxPerBlock: 50,
      minGasPriceWei: 0n, // allow zero-priority tx
      stateTrie: trie,
      enableFeeDistribution: true,
      prefundAccounts: [{ address: senderWallet.address, balanceWei: parseEther("100").toString() }],
    },
    evm,
  )
  await engine.init()

  try {
    await engine.proposeNextBlock() // block 1 empty

    const tx = await senderWallet.signTransaction({
      to: Wallet.createRandom().address,
      value: 0n,
      gasLimit: 21000,
      maxFeePerGas: 5_000_000_000n,
      maxPriorityFeePerGas: 0n,
      type: 2,
      nonce: 0,
      chainId: SPEC_CHAIN_ID,
    })
    await engine.addRawTx(tx as Hex)
    const block2 = await engine.proposeNextBlock()
    assert.ok(block2)
    assert.strictEqual(block2!.txs.length, 1)

    const proposerBalanceAfter = await evm.getBalance(proposerWallet.address)
    assert.strictEqual(proposerBalanceAfter, 0n, "zero-priority means zero credit")
  } finally {
    await engine.close()
    rmSync(tmpDir, { recursive: true, force: true })
  }
})

test("Phase I2: I1 block reward + I2 priority fee both credit proposer in same block", async () => {
  // Combined acceptance: with both flags on, proposer receives reward +
  // priority fee in one block. Validates the two paths don't interfere.
  const tmpDir = mkdtempSync(join(tmpdir(), "coc-i12-"))
  const db = new LevelDatabase(join(tmpDir, "state"))
  await db.open()
  const trie = new PersistentStateTrie(db)
  await trie.init()
  const sm = new PersistentStateManager(trie)
  const evm = await EvmChain.create(SPEC_CHAIN_ID, sm)
  const proposerWallet = Wallet.createRandom()
  const senderWallet = new Wallet(SPEC_PK)

  const REWARD = 100_000_000_000_000_000n // 0.1 ETH
  const engine = new PersistentChainEngine(
    {
      dataDir: tmpDir,
      nodeId: proposerWallet.address,
      chainId: SPEC_CHAIN_ID,
      validators: [proposerWallet.address],
      finalityDepth: 3,
      maxTxPerBlock: 50,
      minGasPriceWei: 1n,
      stateTrie: trie,
      enableBlockReward: true,
      blockRewardWei: REWARD,
      blockRewardHalvingInterval: 1_000_000_000n,
      enableFeeDistribution: true,
      prefundAccounts: [{ address: senderWallet.address, balanceWei: parseEther("100").toString() }],
    },
    evm,
  )
  await engine.init()

  try {
    await engine.proposeNextBlock() // block 1 empty: only block reward
    const afterEmpty = await evm.getBalance(proposerWallet.address)
    assert.strictEqual(afterEmpty, REWARD, "empty block credits only block reward")

    const MAX_FEE = 5_000_000_000n
    const MAX_PRIORITY = 2_000_000_000n
    const tx = await senderWallet.signTransaction({
      to: Wallet.createRandom().address,
      value: parseEther("0.1"),
      gasLimit: 21000,
      maxFeePerGas: MAX_FEE,
      maxPriorityFeePerGas: MAX_PRIORITY,
      type: 2,
      nonce: 0,
      chainId: SPEC_CHAIN_ID,
    })
    await engine.addRawTx(tx as Hex)
    const block2 = await engine.proposeNextBlock()
    assert.ok(block2)

    const baseFee = block2!.baseFee ?? 0n
    const priorityPerGas = MAX_PRIORITY < (MAX_FEE - baseFee) ? MAX_PRIORITY : (MAX_FEE - baseFee)
    const priorityCredit = 21000n * priorityPerGas

    const finalBalance = await evm.getBalance(proposerWallet.address)
    assert.strictEqual(
      finalBalance,
      REWARD * 2n + priorityCredit,
      "proposer balance == 2*reward + priorityFee from block 2",
    )
  } finally {
    await engine.close()
    rmSync(tmpDir, { recursive: true, force: true })
  }
})

test("Phase H10: applyBlock throws stateRoot mismatch when block.stateRoot != computed (no sig required)", async () => {
  // Pins the 2026-04-30 silent-skip bug. Pre-H10 gating required all of
  // (signatureVerifier + block.stateRootSig + !locallyProposed) before the
  // equality check fired. Some BFT-finalized block paths arrive without
  // a stateRootSig (legacy compat / wire-dedup retries), so the check
  // skipped and a divergent local stateRoot was committed silently.
  // After H10 the equality check fires whenever both block.stateRoot and
  // computed stateRoot are present.
  const tmpDir = mkdtempSync(join(tmpdir(), "coc-h10-"))
  const db = new LevelDatabase(join(tmpDir, "state"))
  await db.open()
  const trie = new PersistentStateTrie(db)
  await trie.init()
  const sm = new PersistentStateManager(trie)
  const evm = await EvmChain.create(SPEC_CHAIN_ID, sm)
  const wallet = Wallet.createRandom()

  const engine = new PersistentChainEngine(
    {
      dataDir: tmpDir,
      nodeId: wallet.address,
      chainId: SPEC_CHAIN_ID,
      validators: [wallet.address],
      finalityDepth: 3,
      maxTxPerBlock: 50,
      minGasPriceWei: 1n,
      stateTrie: trie,
      // No signatureEnforcement override — defaults to "enforce", which
      // turns the H10 mismatch detection into a hard throw.
    },
    evm,
  )
  await engine.init()

  try {
    // Build a real block by proposing — that produces a block whose stateRoot
    // matches what our local engine computes.
    const block1 = await engine.proposeNextBlock(true)
    assert.ok(block1)

    // Tamper: re-apply the same block with a deliberately-wrong claimed stateRoot
    // and NO stateRootSig. Pre-H10 this would silently commit a divergent root;
    // post-H10 it must throw.
    const tampered = {
      ...block1!,
      stateRoot: ("0x" + "ff".repeat(32)) as Hex,
      stateRootSig: undefined,
    }
    // Need a fresh engine since the original engine already applied block1.
    // Use a new tmpdir/trie pair so the apply path runs cleanly against the
    // tampered claim.
    const tmpDir2 = mkdtempSync(join(tmpdir(), "coc-h10b-"))
    const db2 = new LevelDatabase(join(tmpDir2, "state"))
    await db2.open()
    const trie2 = new PersistentStateTrie(db2)
    await trie2.init()
    const sm2 = new PersistentStateManager(trie2)
    const evm2 = await EvmChain.create(SPEC_CHAIN_ID, sm2)
    const engine2 = new PersistentChainEngine(
      {
        dataDir: tmpDir2,
        nodeId: wallet.address,
        chainId: SPEC_CHAIN_ID,
        validators: [wallet.address],
        finalityDepth: 3,
        maxTxPerBlock: 50,
        minGasPriceWei: 1n,
        stateTrie: trie2,
      },
      evm2,
    )
    await engine2.init()

    try {
      // engine2 hasn't seen block1 yet. Apply tampered with locallyProposed=false
      // (since engine2 didn't propose it) so it goes through the BFT-finalized
      // apply path — exactly where the silent-skip bug lived.
      await assert.rejects(
        () => engine2.applyBlock(tampered as ChainBlock, false),
        /stateRoot mismatch/,
      )
    } finally {
      await engine2.close()
      rmSync(tmpDir2, { recursive: true, force: true })
    }
  } finally {
    await engine.close()
    rmSync(tmpDir, { recursive: true, force: true })
  }
})

test("Phase I2: feeDistribution disabled — proposer balance unchanged, priority fee accumulates at 0x0", async () => {
  // Regression: enableFeeDistribution defaults to false so legacy networks
  // see the pre-I2 behaviour (coinbase=0x0, priority fee credited to 0x0).
  const tmpDir = mkdtempSync(join(tmpdir(), "coc-i2off-"))
  const db = new LevelDatabase(join(tmpDir, "state"))
  await db.open()
  const trie = new PersistentStateTrie(db)
  await trie.init()
  const sm = new PersistentStateManager(trie)
  const evm = await EvmChain.create(SPEC_CHAIN_ID, sm)
  const proposerWallet = Wallet.createRandom()
  const senderWallet = new Wallet(SPEC_PK)

  const engine = new PersistentChainEngine(
    {
      dataDir: tmpDir,
      nodeId: proposerWallet.address,
      chainId: SPEC_CHAIN_ID,
      validators: [proposerWallet.address],
      finalityDepth: 3,
      maxTxPerBlock: 50,
      minGasPriceWei: 1n,
      stateTrie: trie,
      // enableFeeDistribution NOT set → legacy 0x0 coinbase
      prefundAccounts: [{ address: senderWallet.address, balanceWei: parseEther("100").toString() }],
    },
    evm,
  )
  await engine.init()

  try {
    await engine.proposeNextBlock() // block 1 empty
    const tx = await senderWallet.signTransaction({
      to: Wallet.createRandom().address,
      value: parseEther("0.1"),
      gasLimit: 21000,
      maxFeePerGas: 5_000_000_000n,
      maxPriorityFeePerGas: 2_000_000_000n,
      type: 2,
      nonce: 0,
      chainId: SPEC_CHAIN_ID,
    })
    await engine.addRawTx(tx as Hex)
    const block2 = await engine.proposeNextBlock()
    assert.ok(block2)

    // Proposer should NOT receive priority fee — it goes to 0x0 instead.
    const proposerBalance = await evm.getBalance(proposerWallet.address)
    assert.strictEqual(
      proposerBalance,
      0n,
      "feeDistribution off — proposer balance must stay zero",
    )
    const zeroBalance = await evm.getBalance("0x0000000000000000000000000000000000000000")
    assert.ok(zeroBalance > 0n, "priority fee accumulates at 0x0 in legacy mode")
  } finally {
    await engine.close()
    rmSync(tmpDir, { recursive: true, force: true })
  }
})

// ── Phase X2 (#84) — sign stateRootSig only when local node is actual proposer ─────

/**
 * Build an isolated PersistentChainEngine pinned to a specific signing key.
 * The engine is a fresh tmpdir so each test instance has independent state.
 */
async function buildPhaseX2Engine(opts: {
  signerKey: string
  validators: string[]
  prefund?: { address: string; balanceWei: string }[]
}): Promise<{ engine: PersistentChainEngine; wallet: Wallet; tmpDir: string; close: () => Promise<void> }> {
  const tmpDir = mkdtempSync(join(tmpdir(), "coc-x2-"))
  const db = new LevelDatabase(join(tmpDir, "state"))
  await db.open()
  const trie = new PersistentStateTrie(db)
  await trie.init()
  const sm = new PersistentStateManager(trie)
  const evm = await EvmChain.create(SPEC_CHAIN_ID, sm)
  const wallet = new Wallet(opts.signerKey)
  const engine = new PersistentChainEngine(
    {
      dataDir: tmpDir,
      nodeId: wallet.address.toLowerCase(),
      chainId: SPEC_CHAIN_ID,
      validators: opts.validators,
      finalityDepth: 3,
      maxTxPerBlock: 50,
      minGasPriceWei: 1n,
      stateTrie: trie,
      prefundAccounts: opts.prefund,
    },
    evm,
  )
  await engine.init()
  // Attach a signer so applyBlock's sig logic actually runs.
  const signer = createNodeSigner(opts.signerKey)
  engine.setNodeSigner(signer, signer)
  return {
    engine,
    wallet,
    tmpDir,
    close: async () => {
      await engine.close()
      rmSync(tmpDir, { recursive: true, force: true })
    },
  }
}

test("Phase X2 (#84): non-proposer applyBlock(., true) does NOT re-sign stateRootSig as itself", async () => {
  // Repro for chainofclaw/COC#84: BFT onFinalized calls applyBlock(., true)
  // on every validator, but only the actual block proposer should sign the
  // stateRootSig field. Pre-fix: each follower re-signs with its own key, so
  // observers fetching the block via /p2p/chain-snapshot recover an address
  // that doesn't match block.proposer and reject with "stateRoot signature
  // invalid". Post-fix: followers preserve block.stateRootSig (undefined when
  // gossip strips it, which is the production reality) and skip the verify
  // branch on subsequent applies.
  const proposerKey = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"
  const followerKey = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d"
  const proposer = new Wallet(proposerKey)
  const follower = new Wallet(followerKey)

  const ctxA = await buildPhaseX2Engine({
    signerKey: proposerKey,
    // Single-validator round-robin so the proposer always wins height N.
    validators: [proposer.address.toLowerCase()],
  })
  const ctxB = await buildPhaseX2Engine({
    signerKey: followerKey,
    // Single-validator round-robin so the proposer always wins height N.
    validators: [proposer.address.toLowerCase()],
  })

  try {
    // Proposer builds + applies block (locallyProposed=true via proposeNextBlock).
    // forcePropose=true bypasses round-robin so this test is height-agnostic.
    const block = await ctxA.engine.proposeNextBlock(false, true)
    assert.ok(block, "proposer should produce a block")

    // Simulate gossip → follower: gossip strips stateRootSig from broadcast,
    // so the block the follower applies has stateRootSig=undefined.
    // Set bftFinalized=true to mirror node/src/index.ts:493 finalizedBlock,
    // which lets applyBlock skip its round-robin proposer check.
    const blockFromGossip: ChainBlock = {
      ...block!,
      stateRootSig: undefined,
      bftFinalized: true,
    }

    // Follower applies as BFT-finalized (locallyProposed=true) — exact path
    // hit by node/src/index.ts:510 onFinalized callback.
    await ctxB.engine.applyBlock(blockFromGossip, true)

    // Assert: follower's stored block has stateRootSig=undefined, NOT
    // re-signed with the follower's key.
    const stored = await ctxB.engine.getBlockByHash(block!.hash)
    assert.ok(stored, "follower must store block")
    assert.strictEqual(
      stored!.stateRootSig,
      undefined,
      "non-proposer must NOT re-sign stateRootSig — preserve gossip's value",
    )
  } finally {
    await ctxA.close()
    await ctxB.close()
  }
})

test("Phase X2 (#84): actual proposer applyBlock(., true) DOES sign stateRootSig recoverable to its address", async () => {
  // Counter-test: when the local engine IS the actual block proposer, the
  // sign branch fires and the stored sig recovers to the proposer's address.
  const proposerKey = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"
  const proposer = new Wallet(proposerKey)

  const ctx = await buildPhaseX2Engine({
    signerKey: proposerKey,
    validators: [proposer.address.toLowerCase()],
  })

  try {
    const block = await ctx.engine.proposeNextBlock(false, true)
    assert.ok(block, "proposer should produce a block")

    // proposeNextBlock returns the in-memory block ref; the sig is populated
    // on the persisted copy by applyBlock. Read back via blockIndex.
    const stored = await ctx.engine.getBlockByHash(block!.hash)
    assert.ok(stored, "proposer must persist block")
    assert.ok(stored!.stateRootSig, "proposer must populate stateRootSig in stored block")
    assert.ok(stored!.stateRoot, "stored block must carry stateRoot")

    // Recover the signer from the stored sig and confirm it matches the
    // proposer's address (proves the right key signed).
    const signer = createNodeSigner(proposerKey)
    const stateRootMsg = `stateRoot:${stored!.hash}:${stored!.stateRoot!}`
    const recovered = signer.recoverAddress(stateRootMsg, stored!.stateRootSig!)
    assert.strictEqual(
      recovered,
      proposer.address.toLowerCase(),
      "stateRootSig must recover to the actual proposer's address",
    )
  } finally {
    await ctx.close()
  }
})
