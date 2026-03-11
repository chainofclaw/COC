import { VM, createVM, runTx } from "@ethereumjs/vm"
import { Hardfork, createCustomCommon, getPresetChainConfig } from "@ethereumjs/common"
import { Account, Address, bytesToHex, hexToBytes, bigIntToHex } from "@ethereumjs/util"
import { createTxFromRLP } from "@ethereumjs/tx"
import { createBlock } from "@ethereumjs/block"
import type { PrefundAccount } from "./types.ts"
import { PersistentStateManager } from "./storage/persistent-state-manager.ts"

export interface ExecutionResult {
  txHash: string
  gasUsed: bigint
  success: boolean
}

export interface EvmLog {
  address: string
  topics: string[]
  data: string
  blockNumber: string
  transactionHash: string
  transactionIndex: string
  logIndex: string
  removed: boolean
}

export interface TxReceipt {
  transactionHash: string
  blockNumber: string
  blockHash: string
  transactionIndex: string
  cumulativeGasUsed: string
  gasUsed: string
  status: "0x0" | "0x1"
  logsBloom: string
  logs: EvmLog[]
  effectiveGasPrice: string
  from?: string
  to?: string | null
  type?: string
  contractAddress?: string
}

export interface TxInfo {
  hash: string
  from: string
  to: string | null
  nonce: string
  gas: string
  gasPrice: string
  maxFeePerGas?: string
  maxPriorityFeePerGas?: string
  value: string
  input: string
  blockNumber: string
  blockHash: string
  transactionIndex: string
  type: string
  chainId: string
  v: string
  r: string
  s: string
}

const MAX_RECEIPT_CACHE = 50_000
const MAX_TX_CACHE = 50_000

export class EvmChain {
  private vm: VM
  private readonly common: ReturnType<typeof createCustomCommon>
  private blockNumber = 0n
  private readonly receipts = new Map<string, TxReceipt>()
  private readonly txs = new Map<string, TxInfo>()
  private prefundAccounts: PrefundAccount[] = []

  private externalStateManager: unknown | null = null

  private constructor(chainId: number, vm: VM, common: ReturnType<typeof createCustomCommon>, externalStateManager?: unknown) {
    this.vm = vm
    this.common = common
    this.externalStateManager = externalStateManager ?? null
  }

  static async create(chainId: number, stateManager?: unknown): Promise<EvmChain> {
    const base = getPresetChainConfig("mainnet")
    const common = createCustomCommon({ chainId, networkId: chainId, name: "COC" }, base, {
      hardfork: Hardfork.Shanghai
    })
    const opts: Record<string, unknown> = { common }
    if (stateManager) {
      opts.stateManager = stateManager
    }
    // VMOpts type not directly importable in strip-types mode
    const vm = await createVM(opts as Parameters<typeof createVM>[0])
    return new EvmChain(chainId, vm, common, stateManager)
  }

  async prefund(accounts: PrefundAccount[]): Promise<void> {
    this.prefundAccounts = [...accounts]
    for (const acc of accounts) {
      const address = Address.fromString(acc.address)
      const account = Account.fromAccountData({ balance: BigInt(acc.balanceWei) })
      await this.vm.stateManager.putAccount(address, account)
    }
  }

  async executeRawTx(rawTx: string, blockNumber?: bigint, txIndex = 0, blockHash?: string, baseFeePerGas: bigint = 0n): Promise<ExecutionResult> {
    const tx = createTxFromRLP(hexToBytes(rawTx), { common: this.common })
    // Use provided baseFeePerGas (defaults to 0 for backward compatibility with dev chains)
    const block = createBlock({ header: { baseFeePerGas } }, { common: this.common })
    const result = await runTx(this.vm, { tx, block, skipHardForkValidation: true })
    const txHash = bytesToHex(tx.hash())
    const appliedBlock = blockNumber ?? (this.blockNumber + 1n)
    this.blockNumber = appliedBlock
    const resolvedBlockHash = blockHash ?? `0x${appliedBlock.toString(16).padStart(64, "0")}`
    const gasUsed = `0x${result.totalGasSpent.toString(16)}`
    const status = result.execResult.exceptionError === undefined ? "0x1" : "0x0"
    const rawGasPrice = tx.gasPrice as bigint | undefined
    const gasPrice = rawGasPrice != null
      ? rawGasPrice
      : (() => {
          const maxFee = (tx.maxFeePerGas ?? 0n) as bigint
          const maxPriority = (tx.maxPriorityFeePerGas ?? 0n) as bigint
          const priorityFee = maxFee > baseFeePerGas
            ? (maxPriority < maxFee - baseFeePerGas ? maxPriority : maxFee - baseFeePerGas)
            : 0n
          return baseFeePerGas + priorityFee
        })()
    const logs = (result.execResult.logs ?? []).map((entry, logIdx) => {
      const [addressBytes, topicBytes, dataBytes] = entry as [Uint8Array, Uint8Array[], Uint8Array]
      return {
        address: bytesToHex(addressBytes),
        topics: topicBytes.map((topic) => bytesToHex(topic)),
        data: bytesToHex(dataBytes),
        blockNumber: `0x${appliedBlock.toString(16)}`,
        transactionHash: txHash,
        transactionIndex: `0x${txIndex.toString(16)}`,
        logIndex: `0x${logIdx.toString(16)}`,
        removed: false,
      }
    })

    // Evict oldest entries if cache is full (FIFO via insertion order)
    if (this.receipts.size >= MAX_RECEIPT_CACHE) {
      const first = this.receipts.keys().next().value
      if (first !== undefined) this.receipts.delete(first)
    }

    const contractAddress = result.createdAddress
      ? result.createdAddress.toString()
      : undefined

    this.receipts.set(txHash, {
      transactionHash: txHash,
      blockNumber: `0x${appliedBlock.toString(16)}`,
      blockHash: resolvedBlockHash,
      transactionIndex: `0x${txIndex.toString(16)}`,
      cumulativeGasUsed: gasUsed,
      gasUsed,
      status,
      logsBloom: result.bloom ? bytesToHex(result.bloom.bitvector) : "0x" + "0".repeat(512),
      logs,
      effectiveGasPrice: `0x${gasPrice.toString(16)}`,
      contractAddress,
    })

    const from = tx.getSenderAddress().toString()
    const to = tx.to ? tx.to.toString() : null
    const nonce = tx.nonce ?? 0n
    const gasLimit = tx.gasLimit ?? 0n
    const value = tx.value ?? 0n
    const typeHex = `0x${(tx.type ?? 0).toString(16)}`
    const txData = tx.data ?? new Uint8Array()
    const input = txData.length > 0 ? bytesToHex(txData) : "0x"
    const maxFeePerGas = tx.maxFeePerGas !== undefined ? `0x${tx.maxFeePerGas.toString(16)}` : undefined
    const maxPriorityFeePerGas = tx.maxPriorityFeePerGas !== undefined
      ? `0x${tx.maxPriorityFeePerGas.toString(16)}`
      : undefined

    if (this.txs.size >= MAX_TX_CACHE) {
      const first = this.txs.keys().next().value
      if (first !== undefined) this.txs.delete(first)
    }

    this.txs.set(txHash, {
      hash: txHash,
      from,
      to,
      nonce: `0x${nonce.toString(16)}`,
      gas: `0x${gasLimit.toString(16)}`,
      gasPrice: `0x${gasPrice.toString(16)}`,
      maxFeePerGas,
      maxPriorityFeePerGas,
      value: `0x${value.toString(16)}`,
      input,
      blockNumber: `0x${appliedBlock.toString(16)}`,
      blockHash: resolvedBlockHash,
      transactionIndex: `0x${txIndex.toString(16)}`,
      type: typeHex,
      chainId: bigIntToHex(this.common.chainId()),
      v: tx.v !== undefined ? bigIntToHex(tx.v) : "0x0",
      r: tx.r !== undefined ? bigIntToHex(tx.r) : "0x0",
      s: tx.s !== undefined ? bigIntToHex(tx.s) : "0x0",
    })

    const storedReceipt = this.receipts.get(txHash)
    if (storedReceipt) {
      storedReceipt.from = from
      storedReceipt.to = to
      storedReceipt.type = typeHex
    }

    return { txHash, gasUsed: result.totalGasSpent, success: result.execResult.exceptionError === undefined }
  }

  async getBalance(address: string, stateRoot?: string): Promise<bigint> {
    const stateManager = await this.resolveStateManager(stateRoot)
    const acc = await stateManager.getAccount(Address.fromString(address))
    return acc?.balance ?? 0n
  }

  async getNonce(address: string, stateRoot?: string): Promise<bigint> {
    const stateManager = await this.resolveStateManager(stateRoot)
    const acc = await stateManager.getAccount(Address.fromString(address))
    return acc?.nonce ?? 0n
  }

  getBlockNumber(): bigint {
    return this.blockNumber
  }

  async resetExecution(): Promise<void> {
    const opts: Record<string, unknown> = { common: this.common }
    if (this.externalStateManager) {
      opts.stateManager = this.externalStateManager
    }
    this.vm = await createVM(opts as Parameters<typeof createVM>[0])
    if (this.prefundAccounts.length > 0) {
      await this.prefund(this.prefundAccounts)
    }
    this.receipts.clear()
    this.txs.clear()
    this.blockNumber = 0n
  }

  /**
   * Checkpoint the VM state manager for speculative execution.
   * Call commitState() on success or revertState() on failure.
   */
  async checkpointState(): Promise<void> {
    await this.vm.stateManager.checkpoint()
  }

  /**
   * Commit a previously checkpointed state (speculative execution succeeded).
   */
  async commitState(): Promise<void> {
    await this.vm.stateManager.commit()
  }

  /**
   * Revert to a previously checkpointed state (speculative execution failed).
   */
  async revertState(): Promise<void> {
    await this.vm.stateManager.revert()
  }

  getReceipt(txHash: string): TxReceipt | null {
    return this.receipts.get(txHash) ?? null
  }

  getTransaction(txHash: string): TxInfo | null {
    return this.txs.get(txHash) ?? null
  }

  async callRaw(
    params: { from?: string; to: string; data?: string; value?: string; gas?: string },
    stateRoot?: string,
  ): Promise<{ returnValue: string; gasUsed: bigint }> {
    if (stateRoot) {
      const stateManager = await this.resolveStateManager(stateRoot)
      const tempVm = await this.createVm(stateManager)
      return this.runCall(tempVm, params)
    }
    return this.runCall(this.vm, params)
  }

  async estimateGas(params: { from?: string; to: string; data?: string; value?: string; gas?: string }): Promise<bigint> {
    // Use caller-supplied gas cap or default to 30M (block gas limit)
    const gasCap = params.gas ?? "0x1c9c380"
    const { gasUsed } = await this.callRaw({ ...params, gas: gasCap })
    // Minimum 21000 for basic transaction, plus 10% buffer
    const base = gasUsed < 21000n ? 21000n : gasUsed
    return base + base / 10n
  }

  async getCode(address: string, stateRoot?: string): Promise<string> {
    const stateManager = await this.resolveStateManager(stateRoot)
    const code = await stateManager.getCode(Address.fromString(address))
    if (!code || code.length === 0) return "0x"
    return bytesToHex(code)
  }

  async getStorageAt(address: string, slot: string, stateRoot?: string): Promise<string> {
    const stateManager = await this.resolveStateManager(stateRoot)
    const key = hexToBytes(slot.length === 66 ? slot : `0x${slot.replace("0x", "").padStart(64, "0")}`)
    const result = await stateManager.getStorage(Address.fromString(address), key)
    if (!result || result.length === 0) return "0x" + "0".repeat(64)
    const hex = bytesToHex(result)
    return "0x" + hex.slice(2).padStart(64, "0")
  }

  getAllReceipts(): Map<string, TxReceipt> {
    return new Map(this.receipts)
  }

  private async runCall(vm: VM, params: { from?: string; to: string; data?: string; value?: string; gas?: string }): Promise<{ returnValue: string; gasUsed: bigint }> {
    const caller = params.from ? Address.fromString(params.from) : Address.zero()
    const to = params.to ? Address.fromString(params.to) : Address.zero()
    const data = params.data ? hexToBytes(params.data) : new Uint8Array()
    let value: bigint
    try { value = params.value ? BigInt(params.value) : 0n } catch { value = 0n }
    const MAX_CALL_GAS = 30_000_000n
    const requestedGas = params.gas ? BigInt(params.gas) : 10_000_000n
    const gasLimit = requestedGas > MAX_CALL_GAS ? MAX_CALL_GAS : requestedGas

    // Checkpoint/revert to prevent eth_call from mutating persistent state
    await vm.stateManager.checkpoint()
    try {
      const result = await vm.evm.runCall({
        caller,
        to,
        data,
        value,
        gasLimit,
      })

      const returnValue = result.execResult.returnValue.length > 0
        ? bytesToHex(result.execResult.returnValue)
        : "0x"

      return {
        returnValue,
        gasUsed: result.execResult.executionGasUsed,
      }
    } finally {
      await vm.stateManager.revert()
    }
  }

  private async resolveStateManager(stateRoot?: string): Promise<any> {
    if (!stateRoot) {
      return this.vm.stateManager
    }
    if (!(this.externalStateManager instanceof PersistentStateManager)) {
      throw new Error("historical state queries require persistent state manager support")
    }
    return this.externalStateManager.forkAtStateRoot(stateRoot)
  }

  private async createVm(stateManager: unknown): Promise<VM> {
    const opts: Record<string, unknown> = { common: this.common, stateManager }
    return createVM(opts as Parameters<typeof createVM>[0])
  }
}
