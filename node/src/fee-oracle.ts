/**
 * Fee Oracle — EIP-1559 fee estimation module.
 *
 * Computes priority fee recommendations and fee history reward percentiles
 * based on actual on-chain transaction data.
 */
import { Transaction } from "ethers"
import type { IChainEngine } from "./chain-engine-types.ts"
import { genesisBaseFee, BLOCK_GAS_LIMIT } from "./base-fee.ts"

const DEFAULT_LOOKBACK = 20
const DEFAULT_TIP_FALLBACK = 1_000_000_000n // 1 gwei

interface FeeOracleCache {
  height: bigint
  value: bigint
  cachedAtMs: number
}

export class FeeOracle {
  private cache: FeeOracleCache | null = null
  private readonly cacheTtlMs: number

  constructor(cacheTtlMs = 3000) {
    this.cacheTtlMs = cacheTtlMs
  }

  /**
   * Compute recommended maxPriorityFeePerGas based on recent block history.
   * Returns the median effective priority fee across the last N blocks.
   * Falls back to 1 gwei if no transactions found.
   */
  async computeMaxPriorityFeePerGas(chain: IChainEngine): Promise<bigint> {
    const height = await Promise.resolve(chain.getHeight())

    // Check cache
    if (this.cache && this.cache.height === height && Date.now() - this.cache.cachedAtMs < this.cacheTtlMs) {
      return this.cache.value
    }

    const tips: bigint[] = []
    const lookback = height < BigInt(DEFAULT_LOOKBACK) ? Number(height) : DEFAULT_LOOKBACK

    for (let i = 0; i < lookback; i++) {
      const blk = await Promise.resolve(chain.getBlockByNumber(height - BigInt(i)))
      if (!blk) continue
      const blkBaseFee = blk.baseFee ?? genesisBaseFee()
      for (const rawTx of blk.txs) {
        try {
          const tx = Transaction.from(rawTx)
          const tip = computeEffectiveTip(tx, blkBaseFee)
          if (tip > 0n) tips.push(tip)
        } catch { /* skip unparseable */ }
      }
    }

    const result = tips.length === 0
      ? DEFAULT_TIP_FALLBACK
      : median(tips)

    this.cache = { height, value: result, cachedAtMs: Date.now() }
    return result
  }

  /**
   * Compute fee history reward percentiles for a given block.
   * Uses gasUsed-weighted percentile calculation across block transactions.
   */
  computeFeeHistoryRewards(
    block: Awaited<ReturnType<IChainEngine["getBlockByNumber"]>>,
    baseFee: bigint,
    percentiles: number[],
  ): string[] {
    if (!block || block.txs.length === 0) {
      return percentiles.map(() => "0x0")
    }

    const txFees: Array<{ tip: bigint; gasUsed: bigint }> = []
    for (const rawTx of block.txs) {
      try {
        const tx = Transaction.from(rawTx)
        const tip = computeEffectiveTip(tx, baseFee)
        const gasUsed = tx.gasLimit > 0n ? tx.gasLimit : 21000n
        txFees.push({ tip, gasUsed })
      } catch { /* skip unparseable */ }
    }

    if (txFees.length === 0) {
      return percentiles.map(() => "0x0")
    }

    // Sort by tip ascending
    txFees.sort((a, b) => (a.tip < b.tip ? -1 : a.tip > b.tip ? 1 : 0))

    // Total gas weight
    let totalGas = 0n
    for (const entry of txFees) totalGas += entry.gasUsed

    // Weighted percentile
    return percentiles.map((pct) => {
      if (totalGas === 0n) return "0x0"
      const threshold = (totalGas * BigInt(Math.round(pct * 100))) / 10000n
      let cumulative = 0n
      for (const entry of txFees) {
        cumulative += entry.gasUsed
        if (cumulative >= threshold) {
          return `0x${entry.tip.toString(16)}`
        }
      }
      return `0x${txFees[txFees.length - 1].tip.toString(16)}`
    })
  }
}

/**
 * Compute the effective priority fee (tip) for a transaction.
 * effectiveTip = min(maxPriorityFeePerGas, maxFeePerGas - baseFee)
 */
function computeEffectiveTip(tx: Transaction, baseFee: bigint): bigint {
  const maxFee = tx.maxFeePerGas ?? tx.gasPrice ?? 0n
  const maxPrio = tx.maxPriorityFeePerGas ?? 0n

  if (maxPrio > 0n) {
    const diff = maxFee - baseFee
    return diff < maxPrio ? (diff > 0n ? diff : 0n) : maxPrio
  }
  // Legacy tx: tip = gasPrice - baseFee
  return maxFee > baseFee ? maxFee - baseFee : 0n
}

function median(values: bigint[]): bigint {
  const sorted = [...values].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
  return sorted[Math.floor(sorted.length / 2)]
}
