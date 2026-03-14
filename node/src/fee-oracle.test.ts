import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { Transaction } from "ethers"
import { FeeOracle } from "./fee-oracle.ts"

function createMockChain(blocks: Array<{
  number: bigint
  txs: string[]
  gasUsed?: bigint
  baseFee?: bigint
}>) {
  const map = new Map<bigint, (typeof blocks)[0]>()
  for (const b of blocks) map.set(b.number, b)
  return {
    getHeight: () => blocks.length > 0 ? blocks[blocks.length - 1].number : 0n,
    getBlockByNumber: (n: bigint) => map.get(n) ?? null,
    getBlockByHash: () => null,
    getReceiptsByBlock: () => [],
    expectedProposer: () => "0x" + "00".repeat(20),
    addRawTx: async () => ({ hash: "0x" + "a".repeat(64) }),
    validators: [],
  }
}

function buildEip1559Tx(opts: { maxFeePerGas: bigint; maxPriorityFeePerGas: bigint; gasLimit?: bigint; nonce?: number }): string {
  const tx = Transaction.from({
    to: "0x" + "bb".repeat(20),
    value: 0n,
    nonce: opts.nonce ?? 0,
    gasLimit: opts.gasLimit ?? 21000n,
    maxFeePerGas: opts.maxFeePerGas,
    maxPriorityFeePerGas: opts.maxPriorityFeePerGas,
    chainId: 31337,
    type: 2,
  })
  return tx.unsignedSerialized
}

describe("FeeOracle", () => {
  it("returns 1 gwei fallback for empty blocks", async () => {
    const chain = createMockChain([{
      number: 1n,
      txs: [],
      gasUsed: 0n,
      baseFee: 1_000_000_000n,
    }])
    const oracle = new FeeOracle()
    const tip = await oracle.computeMaxPriorityFeePerGas(chain as any)
    assert.equal(tip, 1_000_000_000n) // 1 gwei
  })

  it("computes median tip from EIP-1559 transactions", async () => {
    const txs = [
      buildEip1559Tx({ maxFeePerGas: 3_000_000_000n, maxPriorityFeePerGas: 500_000_000n }),
      buildEip1559Tx({ maxFeePerGas: 5_000_000_000n, maxPriorityFeePerGas: 1_000_000_000n, nonce: 1 }),
      buildEip1559Tx({ maxFeePerGas: 10_000_000_000n, maxPriorityFeePerGas: 2_000_000_000n, nonce: 2 }),
    ]
    const chain = createMockChain([{
      number: 1n,
      txs,
      gasUsed: 63000n,
      baseFee: 1_000_000_000n,
    }])
    const oracle = new FeeOracle()
    const tip = await oracle.computeMaxPriorityFeePerGas(chain as any)
    // Median of [500M, 1000M, 2000M] = 1000M
    assert.equal(tip, 1_000_000_000n)
  })

  it("handles mixed legacy and EIP-1559 transactions", async () => {
    const eip1559Tx = buildEip1559Tx({ maxFeePerGas: 5_000_000_000n, maxPriorityFeePerGas: 1_500_000_000n })
    // Legacy tx: gasPrice only (type 0), tip = gasPrice - baseFee
    const legacyTx = Transaction.from({
      to: "0x" + "cc".repeat(20),
      value: 0n,
      nonce: 1,
      gasLimit: 21000n,
      gasPrice: 3_000_000_000n,
      chainId: 31337,
      type: 0,
    }).unsignedSerialized

    const chain = createMockChain([{
      number: 1n,
      txs: [eip1559Tx, legacyTx],
      gasUsed: 42000n,
      baseFee: 1_000_000_000n,
    }])
    const oracle = new FeeOracle()
    const tip = await oracle.computeMaxPriorityFeePerGas(chain as any)
    // EIP-1559: tip = min(1500M, 5000M - 1000M) = 1500M
    // Legacy: tip = 3000M - 1000M = 2000M
    // Median of [1500M, 2000M] = 2000M (upper median)
    assert.equal(tip, 2_000_000_000n)
  })

  it("uses cache for same height", async () => {
    const txs = [buildEip1559Tx({ maxFeePerGas: 3_000_000_000n, maxPriorityFeePerGas: 500_000_000n })]
    const chain = createMockChain([{ number: 1n, txs, gasUsed: 21000n, baseFee: 1_000_000_000n }])
    const oracle = new FeeOracle(60_000) // long TTL

    const tip1 = await oracle.computeMaxPriorityFeePerGas(chain as any)
    const tip2 = await oracle.computeMaxPriorityFeePerGas(chain as any)
    assert.equal(tip1, tip2)
  })

  it("computeFeeHistoryRewards returns 0x0 for empty block", () => {
    const oracle = new FeeOracle()
    const block = { number: 1n, txs: [] as string[], gasUsed: 0n, baseFee: 1_000_000_000n, hash: "0x", parentHash: "0x", proposer: "x", timestampMs: 0 }
    const rewards = oracle.computeFeeHistoryRewards(block as any, 1_000_000_000n, [25, 50, 75])
    assert.deepEqual(rewards, ["0x0", "0x0", "0x0"])
  })

  it("computeFeeHistoryRewards weighted percentiles", () => {
    const txs = [
      buildEip1559Tx({ maxFeePerGas: 3_000_000_000n, maxPriorityFeePerGas: 100_000_000n, gasLimit: 21000n }),
      buildEip1559Tx({ maxFeePerGas: 5_000_000_000n, maxPriorityFeePerGas: 500_000_000n, gasLimit: 42000n, nonce: 1 }),
      buildEip1559Tx({ maxFeePerGas: 10_000_000_000n, maxPriorityFeePerGas: 2_000_000_000n, gasLimit: 21000n, nonce: 2 }),
    ]
    const block = { number: 1n, txs, gasUsed: 84000n, baseFee: 1_000_000_000n, hash: "0x", parentHash: "0x", proposer: "x", timestampMs: 0 }
    const oracle = new FeeOracle()
    const rewards = oracle.computeFeeHistoryRewards(block as any, 1_000_000_000n, [25, 50, 75])

    // All rewards should be valid hex
    for (const r of rewards) {
      assert.ok(r.startsWith("0x"), `reward ${r} should start with 0x`)
      assert.ok(BigInt(r) >= 0n, "reward should be non-negative")
    }

    // P25 <= P50 <= P75
    assert.ok(BigInt(rewards[0]) <= BigInt(rewards[1]), "p25 <= p50")
    assert.ok(BigInt(rewards[1]) <= BigInt(rewards[2]), "p50 <= p75")
  })

  it("computeFeeHistoryRewards returns null block as zeros", () => {
    const oracle = new FeeOracle()
    const rewards = oracle.computeFeeHistoryRewards(null as any, 1_000_000_000n, [50])
    assert.deepEqual(rewards, ["0x0"])
  })
})
