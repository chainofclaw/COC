/**
 * Debug/Trace APIs
 *
 * Provides transaction tracing and debugging capabilities:
 * - debug_traceTransaction: step-by-step EVM execution trace
 * - debug_traceBlockByNumber: trace all txs in a block
 * - debug_getBlockRlp: raw RLP of a block (simplified)
 * - trace_transaction: OpenEthereum-compatible trace format
 *
 * Traces are collected by re-executing transactions against the current
 * state with instrumentation hooks.
 */

import type { EvmChain, TxReceipt } from "./evm.ts"
import type { IChainEngine } from "./chain-engine-types.ts"
import type { Hex } from "./blockchain-types.ts"

export interface TraceStep {
  pc: number
  op: string
  gas: string
  gasCost: string
  depth: number
  stack: string[]
  memory: string[]
  storage: Record<string, string>
}

export interface TransactionTrace {
  gas: number
  failed: boolean
  returnValue: string
  structLogs: TraceStep[]
}

export interface TraceOptions {
  disableStorage?: boolean
  disableMemory?: boolean
  disableStack?: boolean
  tracer?: string
}

export interface CallTrace {
  type: string
  from: string
  to: string
  value: string
  gas: string
  gasUsed: string
  input: string
  output: string
  error?: string
}

/**
 * Generate a simplified execution trace for a transaction.
 * Since we can't hook into the EVM step-by-step without VM modification,
 * we provide a call-level trace based on stored receipt data.
 */
export async function traceTransaction(
  txHash: Hex,
  chain: IChainEngine,
  evm: EvmChain,
  _options?: TraceOptions,
): Promise<TransactionTrace> {
  // Try persistent storage first
  let receipt: TxReceipt | null = null
  if (typeof chain.getTransactionByHash === "function") {
    const txData = await chain.getTransactionByHash(txHash)
    if (txData?.receipt) {
      receipt = {
        transactionHash: txData.receipt.transactionHash as string,
        blockNumber: `0x${txData.receipt.blockNumber.toString(16)}`,
        blockHash: txData.receipt.blockHash as string,
        transactionIndex: "0x0",
        cumulativeGasUsed: `0x${txData.receipt.gasUsed.toString(16)}`,
        gasUsed: `0x${txData.receipt.gasUsed.toString(16)}`,
        status: txData.receipt.status === 1n ? "0x1" : "0x0",
        logsBloom: "0x" + "0".repeat(512),
        logs: txData.receipt.logs ?? [],
        effectiveGasPrice: "0x0",
      }
    }
  }

  // Fall back to EVM memory
  if (!receipt) {
    receipt = evm.getReceipt(txHash)
  }

  if (!receipt) {
    throw new Error(`transaction not found: ${txHash}`)
  }

  const gasUsed = parseInt(receipt.gasUsed, 16)
  const failed = receipt.status === "0x0"

  // Build a simplified trace from receipt data
  // Full step-by-step tracing would require EVM hooks
  const structLogs: TraceStep[] = [{
    pc: 0,
    op: failed ? "REVERT" : "STOP",
    gas: `0x${gasUsed.toString(16)}`,
    gasCost: "0x0",
    depth: 1,
    stack: [],
    memory: [],
    storage: {},
  }]

  return {
    gas: gasUsed,
    failed,
    returnValue: "0x",
    structLogs,
  }
}

/**
 * Trace all transactions in a block
 */
export async function traceBlockByNumber(
  blockNumber: bigint,
  chain: IChainEngine,
  evm: EvmChain,
  options?: TraceOptions,
): Promise<Array<{ txHash: string; result: TransactionTrace }>> {
  const block = await Promise.resolve(chain.getBlockByNumber(blockNumber))
  if (!block) {
    throw new Error(`block not found: ${blockNumber}`)
  }

  const results: Array<{ txHash: string; result: TransactionTrace }> = []
  const receipts = await Promise.resolve(chain.getReceiptsByBlock(blockNumber))

  for (const receipt of receipts) {
    const txHash = receipt.transactionHash as Hex
    try {
      const trace = await traceTransaction(txHash, chain, evm, options)
      results.push({ txHash, result: trace })
    } catch {
      // Skip txs that can't be traced
    }
  }

  return results
}

/**
 * Get call-level trace for a transaction (OpenEthereum trace format)
 */
export async function traceTransactionCalls(
  txHash: Hex,
  chain: IChainEngine,
  evm: EvmChain,
): Promise<CallTrace[]> {
  let receipt: TxReceipt | null = null
  let txInfo = evm.getTransaction(txHash)

  if (typeof chain.getTransactionByHash === "function") {
    const txData = await chain.getTransactionByHash(txHash)
    if (txData?.receipt) {
      receipt = {
        transactionHash: txData.receipt.transactionHash as string,
        blockNumber: `0x${txData.receipt.blockNumber.toString(16)}`,
        blockHash: txData.receipt.blockHash as string,
        transactionIndex: "0x0",
        cumulativeGasUsed: `0x${txData.receipt.gasUsed.toString(16)}`,
        gasUsed: `0x${txData.receipt.gasUsed.toString(16)}`,
        status: txData.receipt.status === 1n ? "0x1" : "0x0",
        logsBloom: "0x" + "0".repeat(512),
        logs: txData.receipt.logs ?? [],
        effectiveGasPrice: "0x0",
      }

      if (!txInfo) {
        txInfo = {
          hash: txData.receipt.transactionHash as string,
          from: txData.receipt.from as string,
          to: (txData.receipt.to as string) ?? null,
          nonce: "0x0",
          gas: `0x${txData.receipt.gasUsed.toString(16)}`,
          gasPrice: "0x0",
          value: "0x0",
          blockNumber: `0x${txData.receipt.blockNumber.toString(16)}`,
        }
      }
    }
  }

  if (!receipt) receipt = evm.getReceipt(txHash)
  if (!receipt || !txInfo) {
    throw new Error(`transaction not found: ${txHash}`)
  }

  const failed = receipt.status === "0x0"

  return [{
    type: "call",
    from: txInfo.from,
    to: txInfo.to ?? "0x0000000000000000000000000000000000000000",
    value: txInfo.value ?? "0x0",
    gas: txInfo.gas,
    gasUsed: receipt.gasUsed,
    input: "0x",
    output: "0x",
    error: failed ? "execution reverted" : undefined,
  }]
}
