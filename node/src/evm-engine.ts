/**
 * Engine-agnostic EVM interface.
 *
 * Both EthereumJS (EvmChain) and future engines (revm, evmone) implement
 * this interface. Consumers (chain engines, RPC) depend only on IEvmEngine,
 * never on engine-specific types.
 */

import type { EvmBlockEnv, CallParams, CallResult } from "./evm-types.ts"
import type { ExecutionContext, ExecutionResult, BlockExecutionResult, TxReceipt, TxInfo } from "./evm.ts"
import type { PrefundAccount } from "./types.ts"

export interface IEvmEngine {
  // ── Block preparation ──────────────────────────────────────────────
  applyBlockContext(context: ExecutionContext): Promise<void>
  prepareBlock(blockNumber: bigint, context?: ExecutionContext): EvmBlockEnv

  // ── Transaction execution ──────────────────────────────────────────
  executeRawTx(
    rawTx: string,
    blockNumber?: bigint,
    txIndex?: number,
    blockHash?: string,
    baseFeePerGas?: bigint,
    opts?: { excessBlobGas?: bigint; parentBeaconBlockRoot?: Uint8Array; timestamp?: bigint },
  ): Promise<ExecutionResult>

  // ── Account queries ────────────────────────────────────────────────
  getBalance(address: string, stateRoot?: string): Promise<bigint>
  getNonce(address: string, stateRoot?: string): Promise<bigint>
  getCode(address: string, stateRoot?: string): Promise<string>
  getStorageAt(address: string, slot: string, stateRoot?: string): Promise<string>

  // ── State management ───────────────────────────────────────────────
  prefund(accounts: PrefundAccount[]): Promise<void>
  checkpointState(): Promise<void>
  commitState(): Promise<void>
  revertState(): Promise<void>

  // ── Cache / metadata ───────────────────────────────────────────────
  getReceipt(txHash: string): TxReceipt | null
  getTransaction(txHash: string): TxInfo | null
  evictCaches(): void
  getBlockNumber(): bigint
  getChainId(): number
}
