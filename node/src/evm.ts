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

export interface TxReceipt {
  transactionHash: string
  blockNumber: string
  blockHash: string
  transactionIndex: string
  cumulativeGasUsed: string
  gasUsed: string
  status: "0x0" | "0x1"
  logsBloom: string
  logs: unknown[]
  effectiveGasPrice: string
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
    const vm = await createVM(opts as any)
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

  async executeRawTx(rawTx: string, blockNumber?: bigint, txIndex = 0, blockHash?: string): Promise<ExecutionResult> {
    const tx = createTxFromRLP(hexToBytes(rawTx), { common: this.common })
    // Use baseFeePerGas=0 so dev-chain txs with any gasPrice are accepted
    const block = createBlock({ header: { baseFeePerGas: 0n } }, { common: this.common })
    const result = await runTx(this.vm, { tx, block, skipHardForkValidation: true })
    const txHash = bytesToHex(tx.hash())
    const appliedBlock = blockNumber ?? (this.blockNumber + 1n)
    this.blockNumber = appliedBlock
    const resolvedBlockHash = blockHash ?? `0x${appliedBlock.toString(16).padStart(64, "0")}`
    const gasUsed = `0x${result.totalGasSpent.toString(16)}`
    const status = result.execResult.exceptionError === undefined ? "0x1" : "0x0"
    const gasPrice = (tx.gasPrice ?? tx.maxFeePerGas ?? 0n) as bigint
    const logs = (result.execResult.logs ?? []).map((entry) => {
      const [addressBytes, topicBytes, dataBytes] = entry as [Uint8Array, Uint8Array[], Uint8Array]
      return {
        address: bytesToHex(addressBytes),
        topics: topicBytes.map((topic) => bytesToHex(topic)),
        data: bytesToHex(dataBytes),
        blockNumber: `0x${appliedBlock.toString(16)}`,
        transactionHash: txHash,
        transactionIndex: `0x${txIndex.toString(16)}`,
        logIndex: "0x0",
        removed: false,
      }
    })

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
      effectiveGasPrice: `0x${gasPrice.toString(16)}`
    })

    const from = tx.getSenderAddress().toString()
    const to = tx.to ? tx.to.toString() : null
    const nonce = tx.nonce ?? 0n
    const gasLimit = tx.gasLimit ?? 0n
    const value = tx.value ?? 0n

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
    this.vm = await createVM(opts as any)
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
    const gasLimit = params.gas ? BigInt(params.gas) : 10_000_000n

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
  }

  async estimateGas(params: { from?: string; to: string; data?: string; value?: string }): Promise<bigint> {
    const { gasUsed } = await this.callRaw({ ...params, gas: "0x989680" }) // 10M gas limit
    // Add 10% buffer
    return gasUsed + gasUsed / 10n
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
    return bytesToHex(result).padEnd(66, "0")
  }

  getAllReceipts(): Map<string, TxReceipt> {
    return new Map(this.receipts)
  }
}
