import { VM, createVM, runTx } from "@ethereumjs/vm"
import { Hardfork, createCustomCommon, getPresetChainConfig } from "@ethereumjs/common"
import { Account, Address, bytesToHex, hexToBytes, bigIntToHex } from "@ethereumjs/util"
import { createTxFromRLP } from "@ethereumjs/tx"
import { createBlock } from "@ethereumjs/block"
import type { PrefundAccount } from "./types.ts"

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
  contractAddress?: string
}

export interface TxInfo {
  hash: string
  from: string
  to: string | null
  nonce: string
  gas: string
  gasPrice: string
  value: string
  blockNumber: string
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
      value: `0x${value.toString(16)}`,
      blockNumber: `0x${appliedBlock.toString(16)}`
    })

    return { txHash, gasUsed: result.totalGasSpent, success: result.execResult.exceptionError === undefined }
  }

  async getBalance(address: string): Promise<bigint> {
    const acc = await this.vm.stateManager.getAccount(Address.fromString(address))
    return acc?.balance ?? 0n
  }

  async getNonce(address: string): Promise<bigint> {
    const acc = await this.vm.stateManager.getAccount(Address.fromString(address))
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

  getReceipt(txHash: string): TxReceipt | null {
    return this.receipts.get(txHash) ?? null
  }

  getTransaction(txHash: string): TxInfo | null {
    return this.txs.get(txHash) ?? null
  }

  async callRaw(params: { from?: string; to: string; data?: string; value?: string; gas?: string }): Promise<{ returnValue: string; gasUsed: bigint }> {
    const caller = params.from ? Address.fromString(params.from) : Address.zero()
    const to = Address.fromString(params.to)
    const data = params.data ? hexToBytes(params.data) : new Uint8Array()
    const value = params.value ? BigInt(params.value) : 0n
    const MAX_CALL_GAS = 30_000_000n
    const requestedGas = params.gas ? BigInt(params.gas) : 10_000_000n
    const gasLimit = requestedGas > MAX_CALL_GAS ? MAX_CALL_GAS : requestedGas

    // Checkpoint/revert to prevent eth_call from mutating persistent state
    await this.vm.stateManager.checkpoint()
    try {
      const result = await this.vm.evm.runCall({
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
      await this.vm.stateManager.revert()
    }
  }

  async estimateGas(params: { from?: string; to: string; data?: string; value?: string }): Promise<bigint> {
    const { gasUsed } = await this.callRaw({ ...params, gas: "0x989680" }) // 10M gas limit
    // Minimum 21000 for basic transaction, plus 10% buffer
    const base = gasUsed < 21000n ? 21000n : gasUsed
    return base + base / 10n
  }

  async getCode(address: string): Promise<string> {
    const code = await this.vm.stateManager.getCode(Address.fromString(address))
    if (!code || code.length === 0) return "0x"
    return bytesToHex(code)
  }

  async getStorageAt(address: string, slot: string): Promise<string> {
    const key = hexToBytes(slot.length === 66 ? slot : `0x${slot.replace("0x", "").padStart(64, "0")}`)
    const result = await this.vm.stateManager.getStorage(Address.fromString(address), key)
    if (!result || result.length === 0) return "0x" + "0".repeat(64)
    const hex = bytesToHex(result)
    return "0x" + hex.slice(2).padStart(64, "0")
  }

  getAllReceipts(): Map<string, TxReceipt> {
    return new Map(this.receipts)
  }
}
