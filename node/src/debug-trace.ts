/**
 * Debug/Trace APIs
 *
 * Uses transaction replay against a temporary EVM chain so traces reflect
 * actual opcode execution instead of receipt-derived approximations.
 */

import { Transaction } from "ethers"
import type { EvmChain } from "./evm.ts"
import type { IChainEngine } from "./chain-engine-types.ts"
import type { ChainBlock, Hex } from "./blockchain-types.ts"
import type { CallTrace, TraceOptions, TransactionTrace, TxTraceResult } from "./trace-types.ts"

interface LocatedTransaction {
  rawTx: Hex
  block: ChainBlock
  txIndex: number
}

export async function traceTransaction(
  txHash: Hex,
  chain: IChainEngine,
  evm: EvmChain,
  options: TraceOptions = {},
): Promise<TransactionTrace> {
  const result = await traceTransactionResult(txHash, chain, evm, options)
  return result.trace
}

export async function traceTransactionResult(
  txHash: Hex,
  chain: IChainEngine,
  evm: EvmChain,
  options: TraceOptions = {},
): Promise<TxTraceResult> {
  return traceTransactionInternal(txHash, chain, evm, options)
}

export async function traceBlockByNumber(
  blockNumber: bigint,
  chain: IChainEngine,
  evm: EvmChain,
  options: TraceOptions = {},
): Promise<Array<{ txHash: string; result: TransactionTrace }>> {
  const results = await traceBlockTransactions(blockNumber, chain, evm, options)
  return results.map((traced) => ({ txHash: traced.txHash, result: traced.trace }))
}

export async function traceBlockTransactions(
  blockNumber: bigint,
  chain: IChainEngine,
  evm: EvmChain,
  options: TraceOptions = {},
): Promise<TxTraceResult[]> {
  const block = await Promise.resolve(chain.getBlockByNumber(blockNumber))
  if (!block) {
    throw new Error(`block not found: ${blockNumber}`)
  }

  const replay = await evm.createReplayChain()
  await replayBlocksBefore(replay, chain, block.number)

  const results: TxTraceResult[] = []
  for (let txIndex = 0; txIndex < block.txs.length; txIndex++) {
    const rawTx = block.txs[txIndex]
    const traced = await replay.traceRawTx(rawTx, options, {
      blockNumber: block.number,
      txIndex,
      blockHash: block.hash,
      baseFeePerGas: block.baseFee ?? 0n,
    })
    results.push(traced)
  }

  return results
}

export async function traceTransactionCalls(
  txHash: Hex,
  chain: IChainEngine,
  evm: EvmChain,
  options: TraceOptions = {},
): Promise<CallTrace[]> {
  const result = await traceTransactionResult(txHash, chain, evm, options)
  return result.callTraces
}

async function traceTransactionInternal(
  txHash: Hex,
  chain: IChainEngine,
  evm: EvmChain,
  options: TraceOptions,
): Promise<TxTraceResult> {
  const located = await locateTransaction(txHash, chain)
  if (!located) {
    throw new Error(`transaction not found: ${txHash}`)
  }

  const replay = await evm.createReplayChain()
  await replayBlocksBefore(replay, chain, located.block.number)
  await replayBlockTransactions(replay, located.block, located.txIndex)

  return replay.traceRawTx(located.rawTx, options, {
    blockNumber: located.block.number,
    txIndex: located.txIndex,
    blockHash: located.block.hash,
    baseFeePerGas: located.block.baseFee ?? 0n,
  })
}

async function replayBlocksBefore(replay: EvmChain, chain: IChainEngine, targetBlockNumber: bigint): Promise<void> {
  for (let blockNumber = 1n; blockNumber < targetBlockNumber; blockNumber++) {
    const block = await Promise.resolve(chain.getBlockByNumber(blockNumber))
    if (!block) {
      throw new Error(`block not found: ${blockNumber}`)
    }
    await replayBlockTransactions(replay, block)
  }
}

async function replayBlockTransactions(replay: EvmChain, block: ChainBlock, stopBeforeTxIndex?: number): Promise<void> {
  const end = stopBeforeTxIndex ?? block.txs.length
  for (let txIndex = 0; txIndex < end; txIndex++) {
    await replay.executeRawTx(block.txs[txIndex], block.number, txIndex, block.hash, block.baseFee ?? 0n)
  }
}

async function locateTransaction(txHash: Hex, chain: IChainEngine): Promise<LocatedTransaction | null> {
  if (typeof chain.getTransactionByHash === "function") {
    const stored = await chain.getTransactionByHash(txHash)
    if (stored?.receipt) {
      const block = await Promise.resolve(chain.getBlockByNumber(stored.receipt.blockNumber))
      if (!block) {
        throw new Error(`block not found: ${stored.receipt.blockNumber}`)
      }
      const txIndex = block.txs.findIndex((rawTx) => matchesTransactionHash(rawTx, txHash))
      if (txIndex === -1) {
        throw new Error(`transaction not found in block: ${txHash}`)
      }
      return {
        rawTx: stored.rawTx,
        block,
        txIndex,
      }
    }
  }

  const height = await Promise.resolve(chain.getHeight())
  for (let blockNumber = 1n; blockNumber <= height; blockNumber++) {
    const block = await Promise.resolve(chain.getBlockByNumber(blockNumber))
    if (!block) continue
    for (let txIndex = 0; txIndex < block.txs.length; txIndex++) {
      const rawTx = block.txs[txIndex]
      if (matchesTransactionHash(rawTx, txHash)) {
        return { rawTx, block, txIndex }
      }
    }
  }

  return null
}

function matchesTransactionHash(rawTx: Hex, txHash: Hex): boolean {
  try {
    return (Transaction.from(rawTx).hash as Hex).toLowerCase() === txHash.toLowerCase()
  } catch {
    return false
  }
}
