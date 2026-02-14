/**
 * Persistent Chain Engine tests
 */

import { test } from "node:test"
import assert from "node:assert"
import { PersistentChainEngine } from "./chain-engine-persistent.ts"
import { EvmChain } from "./evm.ts"
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
