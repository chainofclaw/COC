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
