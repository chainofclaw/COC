import { VM, createVM, runTx } from "@ethereumjs/vm"
import { Hardfork, createCustomCommon, getPresetChainConfig } from "@ethereumjs/common"
import { Account, Address, bytesToHex, hexToBytes, bigIntToHex } from "@ethereumjs/util"
import { createTxFromRLP, createLegacyTx } from "@ethereumjs/tx"
import { createBlock } from "@ethereumjs/block"
import type { PrefundAccount } from "./types.ts"
import { PersistentStateManager } from "./storage/persistent-state-manager.ts"
import type { HardforkScheduleEntry } from "./config.ts"
import type { CallTrace, CallTraceResult, RpcAccessListItem, TraceOptions, TraceStep, TransactionTrace, TxTraceResult } from "./trace-types.ts"

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
  private readonly hardfork: Hardfork
  private readonly hardforkSchedule: Array<{ blockNumber: bigint; hardfork: Hardfork }>
  private blockNumber = 0n
  private readonly receipts = new Map<string, TxReceipt>()
  private readonly txs = new Map<string, TxInfo>()
  private prefundAccounts: PrefundAccount[] = []

  private externalStateManager: unknown | null = null

  private constructor(
    chainId: number,
    vm: VM,
    common: ReturnType<typeof createCustomCommon>,
    hardfork: Hardfork,
    hardforkSchedule: Array<{ blockNumber: bigint; hardfork: Hardfork }>,
    externalStateManager?: unknown,
  ) {
    this.vm = vm
    this.common = common
    this.hardfork = hardfork
    this.hardforkSchedule = hardforkSchedule
    this.externalStateManager = externalStateManager ?? null
  }

  static async create(
    chainId: number,
    stateManager?: unknown,
    opts?: { hardfork?: Hardfork; hardforkSchedule?: HardforkScheduleEntry[] },
  ): Promise<EvmChain> {
    const base = getPresetChainConfig("mainnet")
    const hardfork = opts?.hardfork ?? Hardfork.Shanghai
    const common = createCustomCommon({ chainId, networkId: chainId, name: "COC" }, base, {
      hardfork,
    })
    const vmOpts: Record<string, unknown> = { common }
    if (stateManager) {
      vmOpts.stateManager = stateManager
    }
    // VMOpts type not directly importable in strip-types mode
    const vm = await createVM(vmOpts as Parameters<typeof createVM>[0])
    const hardforkSchedule = normalizeHardforkSchedule(opts?.hardforkSchedule)
    return new EvmChain(chainId, vm, common, hardfork, hardforkSchedule, stateManager)
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
    const appliedBlock = blockNumber ?? (this.blockNumber + 1n)
    const blockCommon = this.createExecutionCommon(appliedBlock)
    this.applyHardforkToVm(this.vm, appliedBlock)
    const tx = createTxFromRLP(hexToBytes(rawTx), { common: blockCommon.copy() })
    // Use provided baseFeePerGas (defaults to 0 for backward compatibility with dev chains)
    const block = createBlock({ header: { baseFeePerGas } }, { common: blockCommon })
    const result = await runTx(this.vm, { tx, block, skipHardForkValidation: true })
    const txHash = bytesToHex(tx.hash())
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
    blockNumber?: bigint,
  ): Promise<{ returnValue: string; gasUsed: bigint }> {
    if (stateRoot || blockNumber !== undefined) {
      const stateManager = await this.resolveStateManager(stateRoot)
      const tempVm = await this.createVm(stateManager, blockNumber)
      return this.runCall(tempVm, params, { blockNumber })
    }
    return this.runCall(this.vm, params, { blockNumber })
  }

  async estimateGas(
    params: { from?: string; to: string; data?: string; value?: string; gas?: string },
    stateRoot?: string,
    blockNumber?: bigint,
  ): Promise<bigint> {
    // Use caller-supplied gas cap or default to 30M (block gas limit)
    const gasCap = params.gas ?? "0x1c9c380"
    const { gasUsed } = await this.callRaw({ ...params, gas: gasCap }, stateRoot, blockNumber)
    const executionCommon = this.createExecutionCommon(blockNumber)
    const intrinsicGas = calculateIntrinsicGas(
      params.data ? hexToBytes(params.data) : new Uint8Array(),
      !params.to,
      executionCommon,
    )
    const total = intrinsicGas + gasUsed
    return total + total / 10n
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

  async getProof(address: string, slots: string[], stateRoot?: string): Promise<{
    address: string
    balance: string
    codeHash: string
    nonce: string
    storageHash: string
    accountProof: string[]
    storageProof: Array<{ key: string; value: string; proof: string[] }>
  }> {
    const stateManager = await this.resolveStateManager(stateRoot)
    if (!(stateManager instanceof PersistentStateManager) || typeof stateManager.getProof !== "function") {
      throw new Error("eth_getProof requires proof-capable persistent state manager support")
    }
    return stateManager.getProof(
      Address.fromString(address),
      slots.map((slot) => hexToBytes(slot.length === 66 ? slot : `0x${slot.replace("0x", "").padStart(64, "0")}`)),
    )
  }

  getAllReceipts(): Map<string, TxReceipt> {
    return new Map(this.receipts)
  }

  getChainId(): number {
    return Number(this.common.chainId())
  }

  getHardfork(blockNumber?: bigint): Hardfork {
    return this.resolveHardfork(blockNumber)
  }

  async createReplayChain(): Promise<EvmChain> {
    const replay = await EvmChain.create(this.getChainId(), undefined, {
      hardfork: this.hardfork,
      hardforkSchedule: this.hardforkSchedule.map((entry) => ({
        blockNumber: Number(entry.blockNumber),
        hardfork: entry.hardfork,
      })),
    })
    if (this.prefundAccounts.length > 0) {
      await replay.prefund(this.prefundAccounts)
    }
    return replay
  }

  async traceCall(
    params: { from?: string; to: string; data?: string; value?: string; gas?: string },
    options: TraceOptions = {},
    stateRoot?: string,
    blockNumber?: bigint,
  ): Promise<CallTraceResult> {
    const stateManager = stateRoot ? await this.resolveStateManager(stateRoot) : this.vm.stateManager
    const vm = await this.createVm(stateManager, blockNumber)
    return this.traceCallOnVm(vm, params, options, { blockNumber })
  }

  async traceCallMany(
    calls: Array<{ from?: string; to: string; data?: string; value?: string; gas?: string }>,
    options: TraceOptions = {},
    stateRoot?: string,
    blockNumber?: bigint,
  ): Promise<CallTraceResult[]> {
    const stateManager = stateRoot ? await this.resolveStateManager(stateRoot) : this.vm.stateManager
    const vm = await this.createVm(stateManager, blockNumber)
    const results: CallTraceResult[] = []
    await vm.stateManager.checkpoint()
    try {
      for (const params of calls) {
        results.push(await this.traceCallOnVm(vm, params, options, { persistAfter: true, blockNumber }))
      }
      return results
    } finally {
      await vm.stateManager.revert()
    }
  }

  private async traceCallOnVm(
    vm: VM,
    params: { from?: string; to: string; data?: string; value?: string; gas?: string },
    options: TraceOptions = {},
    opts: { persistAfter?: boolean; blockNumber?: bigint } = {},
  ): Promise<CallTraceResult> {
    const collector = createTraceCollector(vm, options)
    let needsRevert = false
    await vm.evm.journal.cleanup()
    vm.evm.journal.startReportingAccessList()
    try {
      const result = await this.runCall(vm, params, { revertAfter: false, blockNumber: opts.blockNumber })
      needsRevert = true
      const accessList = normalizeAccessList(vm.evm.journal.accessList)
      const traced = collector.finish({
        returnValue: result.returnValue,
        gasUsed: result.gasUsed,
        failed: result.failed,
        accessList,
      })
      const targets = collectTraceTargets(traced.callTraces, accessList, traced.trace)
      const afterState = await captureStateSnapshots(vm.stateManager, targets)
      await vm.stateManager.revert()
      needsRevert = false
      const beforeState = await captureStateSnapshots(vm.stateManager, targets)
      if (opts.persistAfter) {
        await vm.evm.journal.cleanup()
        await this.runCall(vm, params, { revertAfter: false, blockNumber: opts.blockNumber })
        needsRevert = true
        await vm.stateManager.commit()
        needsRevert = false
      }
      if (params.from) {
        suppressCallEnvelopeNoise(beforeState, afterState, params.from)
      }
      const stateDiff = buildStateDiff(beforeState, afterState)
      return {
        ...traced,
        stateDiff,
        prestate: formatPrestateSnapshot(beforeState),
        poststate: formatPrestateSnapshot(afterState),
      }
    } finally {
      collector.dispose()
      if (needsRevert) {
        await vm.stateManager.revert()
      }
      await vm.evm.journal.cleanup()
    }
  }

  async traceRawTx(
    rawTx: string,
    options: TraceOptions = {},
    context?: { blockNumber?: bigint; txIndex?: number; blockHash?: string; baseFeePerGas?: bigint },
  ): Promise<TxTraceResult> {
    const executionBlockNumber = context?.blockNumber
    const blockCommon = this.createExecutionCommon(executionBlockNumber)
    this.applyHardforkToVm(this.vm, executionBlockNumber)
    const tx = createTxFromRLP(hexToBytes(rawTx), { common: blockCommon.copy() })
    const block = createBlock({ header: { baseFeePerGas: context?.baseFeePerGas ?? 0n } }, { common: blockCommon })
    const collector = createTraceCollector(this.vm, options)
    let needsRevert = true
    await this.vm.stateManager.checkpoint()
    try {
      const result = await runTx(this.vm, {
        tx,
        block,
        skipHardForkValidation: true,
        reportAccessList: true,
      })
      const txHash = bytesToHex(tx.hash())
      const traced = collector.finish({
        txHash,
        gasUsed: result.totalGasSpent,
        success: result.execResult.exceptionError === undefined,
        failed: result.execResult.exceptionError !== undefined,
        returnValue: result.execResult.returnValue.length > 0 ? bytesToHex(result.execResult.returnValue) : "0x",
        accessList: result.accessList?.map((item) => ({
          address: item.address,
          storageKeys: [...item.storageKeys],
        })) ?? [],
      })
      const targets = collectTraceTargets(traced.callTraces, traced.accessList, traced.trace)
      const afterState = await captureStateSnapshots(this.vm.stateManager, targets)
      await this.vm.stateManager.revert()
      needsRevert = false
      const beforeState = await captureStateSnapshots(this.vm.stateManager, targets)
      await runTx(this.vm, {
        tx,
        block,
        skipHardForkValidation: true,
      })
      return {
        ...traced,
        stateDiff: buildStateDiff(beforeState, afterState),
        prestate: formatPrestateSnapshot(beforeState),
        poststate: formatPrestateSnapshot(afterState),
      }
    } finally {
      collector.dispose()
      if (needsRevert) {
        await this.vm.stateManager.revert()
      }
    }
  }

  async traceRawTxOnState(
    rawTx: string,
    options: TraceOptions = {},
    context?: { blockNumber?: bigint; txIndex?: number; blockHash?: string; baseFeePerGas?: bigint },
    stateRoot?: string,
  ): Promise<TxTraceResult> {
    const executionBlockNumber = context?.blockNumber
    const blockCommon = this.createExecutionCommon(executionBlockNumber)
    const tx = createTxFromRLP(hexToBytes(rawTx), { common: blockCommon.copy() })
    const block = createBlock({ header: { baseFeePerGas: context?.baseFeePerGas ?? 0n } }, { common: blockCommon })
    const stateManager = stateRoot ? await this.resolveStateManager(stateRoot) : this.vm.stateManager
    const vm = stateRoot || executionBlockNumber !== undefined
      ? await this.createVm(stateManager, executionBlockNumber)
      : this.vm
    this.applyHardforkToVm(vm, executionBlockNumber)
    const collector = createTraceCollector(vm, options)
    let needsRevert = true
    await vm.stateManager.checkpoint()
    try {
      const result = await runTx(vm, {
        tx,
        block,
        skipHardForkValidation: true,
        reportAccessList: true,
      })
      const txHash = bytesToHex(tx.hash())
      const traced = collector.finish({
        txHash,
        gasUsed: result.totalGasSpent,
        success: result.execResult.exceptionError === undefined,
        failed: result.execResult.exceptionError !== undefined,
        returnValue: result.execResult.returnValue.length > 0 ? bytesToHex(result.execResult.returnValue) : "0x",
        accessList: result.accessList?.map((item) => ({
          address: item.address,
          storageKeys: [...item.storageKeys],
        })) ?? [],
      })
      const targets = collectTraceTargets(traced.callTraces, traced.accessList, traced.trace)
      const afterState = await captureStateSnapshots(vm.stateManager, targets)
      await vm.stateManager.revert()
      needsRevert = false
      const beforeState = await captureStateSnapshots(vm.stateManager, targets)
      return {
        ...traced,
        stateDiff: buildStateDiff(beforeState, afterState),
        prestate: formatPrestateSnapshot(beforeState),
        poststate: formatPrestateSnapshot(afterState),
      }
    } finally {
      collector.dispose()
      if (needsRevert) {
        await vm.stateManager.revert()
      }
    }
  }

  private async runCall(
    vm: VM,
    params: { from?: string; to: string; data?: string; value?: string; gas?: string },
    opts: { revertAfter?: boolean; blockNumber?: bigint } = {},
  ): Promise<{ returnValue: string; gasUsed: bigint; failed: boolean }> {
    this.applyHardforkToVm(vm, opts.blockNumber)
    const caller = params.from ? Address.fromString(params.from) : Address.zero()
    const to = params.to ? Address.fromString(params.to) : undefined
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
        failed: result.execResult.exceptionError !== undefined,
      }
    } finally {
      if (opts.revertAfter !== false) {
        await vm.stateManager.revert()
      }
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

  private async createVm(stateManager: unknown, blockNumber?: bigint): Promise<VM> {
    const opts: Record<string, unknown> = { common: this.createExecutionCommon(blockNumber), stateManager }
    return createVM(opts as Parameters<typeof createVM>[0])
  }

  private resolveHardfork(blockNumber?: bigint): Hardfork {
    if (this.hardforkSchedule.length === 0) {
      return this.hardfork
    }
    const effectiveBlockNumber = blockNumber ?? this.blockNumber
    let selected = this.hardfork
    for (const entry of this.hardforkSchedule) {
      if (entry.blockNumber > effectiveBlockNumber) {
        break
      }
      selected = entry.hardfork
    }
    return selected
  }

  private createExecutionCommon(blockNumber?: bigint): ReturnType<typeof createCustomCommon> {
    const common = this.common.copy()
    common.setHardfork(this.resolveHardfork(blockNumber))
    return common as ReturnType<typeof createCustomCommon>
  }

  private applyHardforkToVm(vm: VM, blockNumber?: bigint): void {
    const hardfork = this.resolveHardfork(blockNumber)
    if (vm.common.hardfork() !== hardfork) {
      vm.common.setHardfork(hardfork)
    }
  }
}

function normalizeHardforkSchedule(
  schedule?: HardforkScheduleEntry[],
): Array<{ blockNumber: bigint; hardfork: Hardfork }> {
  if (!Array.isArray(schedule) || schedule.length === 0) {
    return []
  }
  return [...schedule]
    .map((entry) => ({
      blockNumber: BigInt(entry.blockNumber),
      hardfork: entry.hardfork,
    }))
    .sort((left, right) => (left.blockNumber < right.blockNumber ? -1 : left.blockNumber > right.blockNumber ? 1 : 0))
}

function calculateIntrinsicGas(
  data: Uint8Array,
  isContractCreation: boolean,
  common: ReturnType<typeof createCustomCommon>,
): bigint {
  const tx = createLegacyTx({
    nonce: 0n,
    gasLimit: 30_000_000n,
    gasPrice: 0n,
    value: 0n,
    data,
    to: isContractCreation ? undefined : Address.zero(),
  }, { common })
  return tx.getIntrinsicGas()
}

interface TraceCollector {
  dispose(): void
  finish<T extends { returnValue: string; gasUsed: bigint; failed: boolean; accessList: RpcAccessListItem[] }>(
    result: T,
  ): T & { trace: TransactionTrace; callTraces: CallTrace[] }
}

interface AccountStateSnapshot {
  balance: string
  nonce: string
  code: string
  storage: Record<string, string>
}

interface PendingCallFrame extends CallTrace {
  order: number
  traceAddress: number[]
  childCount: number
}

function createTraceCollector(vm: VM, options: TraceOptions): TraceCollector {
  const structLogs: TraceStep[] = []
  const completedCalls: PendingCallFrame[] = []
  const pendingCalls: PendingCallFrame[] = []
  let nextOrder = 0

  const onBeforeMessage = (message: any) => {
    const parent = pendingCalls[pendingCalls.length - 1]
    const traceAddress = parent
      ? [...parent.traceAddress, parent.childCount++]
      : []
    pendingCalls.push({
      order: nextOrder++,
      type: classifyMessageType(message),
      from: message.caller.toString(),
      to: message.to?.toString() ?? "0x0000000000000000000000000000000000000000",
      value: bigIntToHex(message.value ?? 0n),
      gas: bigIntToHex(message.gasLimit ?? 0n),
      gasUsed: "0x0",
      input: message.data && message.data.length > 0 ? bytesToHex(message.data) : "0x",
      output: "0x",
      traceAddress,
      childCount: 0,
    })
  }

  const onAfterMessage = (result: any) => {
    const frame = pendingCalls.pop()
    if (!frame) return
    frame.gasUsed = bigIntToHex(result.execResult.executionGasUsed ?? 0n)
    frame.output = result.execResult.returnValue?.length ? bytesToHex(result.execResult.returnValue) : "0x"
    if (result.createdAddress) {
      frame.to = result.createdAddress.toString()
    }
    if (result.execResult.exceptionError) {
      frame.error = result.execResult.exceptionError.error
      frame.revertReason = decodeRevertReason(frame.output)
    }
    if (Array.isArray(result.execResult.logs) && result.execResult.logs.length > 0) {
      frame.logs = result.execResult.logs.map((entry: unknown) => {
        const [addressBytes, topicBytes, dataBytes] = entry as [Uint8Array, Uint8Array[], Uint8Array]
        return {
          address: bytesToHex(addressBytes),
          topics: topicBytes.map((topic) => bytesToHex(topic)),
          data: bytesToHex(dataBytes),
        }
      })
    }
    frame.subtraces = frame.childCount
    completedCalls.push(frame)
  }

  const onStep = async (step: any, resolve: () => void) => {
    try {
      structLogs.push({
        pc: step.pc,
        op: step.opcode.name,
        gas: bigIntToHex(step.gasLeft ?? 0n),
        gasCost: bigIntToHex(step.opcode.dynamicFee ?? step.opcode.fee ?? 0n),
        depth: step.depth,
        stack: options.disableStack ? [] : step.stack.map((item: unknown) => formatTraceWord(item)),
        memory: options.disableMemory ? [] : formatTraceMemory(step.memory),
        storage: options.disableStorage ? {} : await captureTraceStorage(step),
      })
    } finally {
      resolve()
    }
  }

  vm.evm.events?.on("beforeMessage", onBeforeMessage)
  vm.evm.events?.on("afterMessage", onAfterMessage)
  vm.evm.events?.on("step", onStep)

  return {
    dispose(): void {
      vm.evm.events?.off("beforeMessage", onBeforeMessage)
      vm.evm.events?.off("afterMessage", onAfterMessage)
      vm.evm.events?.off("step", onStep)
    },
    finish<T extends { returnValue: string; gasUsed: bigint; failed: boolean; accessList: RpcAccessListItem[] }>(
      result: T,
    ): T & { trace: TransactionTrace; callTraces: CallTrace[] } {
      const trace: TransactionTrace = {
        gas: Number(result.gasUsed),
        failed: result.failed,
        returnValue: result.returnValue,
        structLogs,
      }
      const callTraces = completedCalls
        .sort((a, b) => a.order - b.order)
        .map(({ order: _order, childCount: _childCount, ...callTrace }) => callTrace)
      return { ...result, trace, callTraces }
    },
  }
}

function normalizeAccessList(accessList?: Map<string, Set<string>>): RpcAccessListItem[] {
  if (!accessList) return []
  return Array.from(accessList.entries()).map(([address, slots]) => ({
    address: `0x${address}`,
    storageKeys: Array.from(slots).map((slot) => `0x${slot.padStart(64, "0")}`),
  }))
}

function collectTraceTargets(
  callTraces: CallTrace[],
  accessList: RpcAccessListItem[],
  trace?: TransactionTrace,
): Map<string, Set<string>> {
  const targets = new Map<string, Set<string>>()

  const ensureAddress = (rawAddress?: string): Set<string> | null => {
    if (!rawAddress || !/^0x[0-9a-fA-F]{40}$/.test(rawAddress)) return null
    const address = rawAddress.toLowerCase()
    const existing = targets.get(address)
    if (existing) return existing
    const slots = new Set<string>()
    targets.set(address, slots)
    return slots
  }

  for (const callTrace of callTraces) {
    ensureAddress(callTrace.from)
    ensureAddress(callTrace.to)
  }

  for (const item of accessList) {
    const slots = ensureAddress(item.address)
    if (!slots) continue
    for (const slot of item.storageKeys) {
      slots.add(normalizeStateSlot(slot))
    }
  }

  if (trace) {
    augmentTargetsWithTraceStorage(callTraces, trace, targets)
  }

  return targets
}

function augmentTargetsWithTraceStorage(
  callTraces: CallTrace[],
  trace: TransactionTrace,
  targets: Map<string, Set<string>>,
): void {
  if (callTraces.length === 0 || trace.structLogs.length === 0) {
    return
  }

  const orderedCalls = [...callTraces].sort((left, right) =>
    compareTraceAddress(left.traceAddress ?? [], right.traceAddress ?? [])
  )
  const rootDepth = trace.structLogs[0].depth
  const callStack: Array<{ depth: number; address: string | null }> = []
  let nextCallIndex = 0

  const pushCallForDepth = (depth: number) => {
    const callTrace = orderedCalls[nextCallIndex++]
    if (!callTrace) {
      return
    }
    callStack.push({
      depth,
      address: /^0x[0-9a-fA-F]{40}$/.test(callTrace.to) ? callTrace.to.toLowerCase() : null,
    })
  }

  pushCallForDepth(rootDepth)

  for (const step of trace.structLogs) {
    while (callStack.length > 0 && step.depth < callStack[callStack.length - 1].depth) {
      callStack.pop()
    }
    while ((callStack.length === 0 || step.depth > callStack[callStack.length - 1].depth) && nextCallIndex < orderedCalls.length) {
      pushCallForDepth(step.depth)
    }

    const current = callStack[callStack.length - 1]
    if (!current?.address) {
      continue
    }

    let slots = targets.get(current.address)
    if (!slots) {
      slots = new Set<string>()
      targets.set(current.address, slots)
    }
    for (const slot of Object.keys(step.storage)) {
      slots.add(normalizeStateSlot(slot))
    }
  }
}

function compareTraceAddress(left: number[], right: number[]): number {
  const length = Math.min(left.length, right.length)
  for (let index = 0; index < length; index++) {
    if (left[index] !== right[index]) {
      return left[index] - right[index]
    }
  }
  return left.length - right.length
}

async function captureStateSnapshots(
  stateManager: any,
  targets: Map<string, Set<string>>,
): Promise<Map<string, AccountStateSnapshot>> {
  const snapshots = new Map<string, AccountStateSnapshot>()

  for (const [address, slots] of targets) {
    const accountAddress = Address.fromString(address)
    const account = await stateManager.getAccount(accountAddress)
    const code = await stateManager.getCode(accountAddress)
    const storage: Record<string, string> = {}

    for (const slot of slots) {
      const value = await stateManager.getStorage(accountAddress, hexToBytes(slot))
      storage[slot] = normalizeStateQuantity(bytesToHex(value))
    }

    snapshots.set(address, {
      balance: account ? bigIntToHex(account.balance) : "0x0",
      nonce: account ? bigIntToHex(account.nonce) : "0x0",
      code: code.length > 0 ? bytesToHex(code) : "0x",
      storage,
    })
  }

  return snapshots
}

function buildStateDiff(
  beforeState: Map<string, AccountStateSnapshot>,
  afterState: Map<string, AccountStateSnapshot>,
): Record<string, unknown> {
  const diff: Record<string, unknown> = {}
  const addresses = new Set([...beforeState.keys(), ...afterState.keys()])

  for (const address of addresses) {
    const before = beforeState.get(address) ?? emptyAccountStateSnapshot()
    const after = afterState.get(address) ?? emptyAccountStateSnapshot()
    const addressDiff: Record<string, unknown> = {}

    const balanceDiff = buildScalarDiff(before.balance, after.balance, "0x0")
    if (balanceDiff) addressDiff.balance = balanceDiff

    const nonceDiff = buildScalarDiff(before.nonce, after.nonce, "0x0")
    if (nonceDiff) addressDiff.nonce = nonceDiff

    const codeDiff = buildScalarDiff(before.code, after.code, "0x")
    if (codeDiff) addressDiff.code = codeDiff

    const storageDiff: Record<string, unknown> = {}
    const slots = new Set([...Object.keys(before.storage), ...Object.keys(after.storage)])
    for (const slot of slots) {
      const slotDiff = buildScalarDiff(before.storage[slot] ?? "0x0", after.storage[slot] ?? "0x0", "0x0")
      if (slotDiff) storageDiff[slot] = slotDiff
    }
    if (Object.keys(storageDiff).length > 0) {
      addressDiff.storage = storageDiff
    }

    if (Object.keys(addressDiff).length > 0) {
      diff[address] = addressDiff
    }
  }

  return diff
}

function formatPrestateSnapshot(state: Map<string, AccountStateSnapshot>): Record<string, unknown> {
  const formatted: Record<string, unknown> = {}

  for (const [address, snapshot] of state) {
    const entry: Record<string, unknown> = {
      balance: snapshot.balance,
      nonce: snapshot.nonce,
    }
    if (snapshot.code !== "0x") {
      entry.code = snapshot.code
    }
    if (Object.keys(snapshot.storage).length > 0) {
      entry.storage = { ...snapshot.storage }
    }
    formatted[address] = entry
  }

  return formatted
}

function suppressCallEnvelopeNoise(
  beforeState: Map<string, AccountStateSnapshot>,
  afterState: Map<string, AccountStateSnapshot>,
  callerAddress: string,
): void {
  const address = callerAddress.toLowerCase()
  const before = beforeState.get(address)
  const after = afterState.get(address)
  if (!before || !after) return
  after.nonce = before.nonce
}

function buildScalarDiff(from: string, to: string, emptyValue: string): Record<string, unknown> | undefined {
  if (from === to) return undefined
  if (from === emptyValue) return { "+": to }
  if (to === emptyValue) return { "-": from }
  return { "*": { from, to } }
}

function emptyAccountStateSnapshot(): AccountStateSnapshot {
  return {
    balance: "0x0",
    nonce: "0x0",
    code: "0x",
    storage: {},
  }
}

function normalizeStateSlot(slot: string): string {
  return slot.length === 66 ? slot.toLowerCase() : `0x${slot.replace(/^0x/, "").padStart(64, "0").toLowerCase()}`
}

function normalizeStateQuantity(value: string): string {
  const stripped = value.replace(/^0x/, "").replace(/^0+/, "")
  return stripped.length > 0 ? `0x${stripped}` : "0x0"
}

function classifyMessageType(message: { to?: Address; delegatecall?: boolean; isStatic?: boolean }): string {
  if (!message.to) return "create"
  if (message.delegatecall) return "delegatecall"
  if (message.isStatic) return "staticcall"
  return "call"
}

function formatTraceMemory(memory: Uint8Array): string[] {
  if (!memory || memory.length === 0) return []
  const words: string[] = []
  for (let offset = 0; offset < memory.length; offset += 32) {
    const chunk = memory.subarray(offset, Math.min(offset + 32, memory.length))
    words.push(`0x${Buffer.from(chunk).toString("hex").padEnd(64, "0")}`)
  }
  return words
}

function formatTraceWord(value: unknown): string {
  if (typeof value === "bigint") return bigIntToHex(value)
  if (typeof value === "number") return bigIntToHex(BigInt(value))
  if (value instanceof Uint8Array) {
    return `0x${Buffer.from(value).toString("hex")}`
  }
  if (typeof value === "string") {
    return value.startsWith("0x") ? value : `0x${value}`
  }
  return "0x0"
}

function decodeRevertReason(data: string): string | undefined {
  if (!data || data === "0x" || !data.startsWith("0x")) {
    return undefined
  }
  const hex = data.slice(2).toLowerCase()
  if (hex.length < 8) {
    return undefined
  }
  const selector = hex.slice(0, 8)
  if (selector === "08c379a0") {
    return decodeAbiString(hex.slice(8))
  }
  if (selector === "4e487b71") {
    const panicCode = decodeAbiUint256(hex.slice(8))
    return panicCode !== undefined ? `Panic(${panicCode})` : undefined
  }
  return `CustomError(0x${selector})`
}

function decodeAbiString(payloadHex: string): string | undefined {
  const offset = decodeAbiUint256(payloadHex.slice(0, 64))
  if (offset === undefined) {
    return undefined
  }
  const lengthOffset = Number(offset * 2n)
  if (lengthOffset + 64 > payloadHex.length) {
    return undefined
  }
  const stringLength = decodeAbiUint256(payloadHex.slice(lengthOffset, lengthOffset + 64))
  if (stringLength === undefined) {
    return undefined
  }
  const dataOffset = lengthOffset + 64
  const byteLength = Number(stringLength)
  const stringHex = payloadHex.slice(dataOffset, dataOffset + byteLength * 2)
  if (stringHex.length !== byteLength * 2) {
    return undefined
  }
  try {
    return Buffer.from(stringHex, "hex").toString("utf8")
  } catch {
    return undefined
  }
}

function decodeAbiUint256(hexWord: string): bigint | undefined {
  if (hexWord.length < 64) {
    return undefined
  }
  try {
    return BigInt(`0x${hexWord.slice(0, 64)}`)
  } catch {
    return undefined
  }
}

async function captureTraceStorage(step: any): Promise<Record<string, string>> {
  if (step.opcode.name !== "SLOAD" && step.opcode.name !== "SSTORE") {
    return {}
  }
  const stack = Array.isArray(step.stack) ? step.stack : []
  const rawSlot = stack.at(-1)
  if (rawSlot === undefined) return {}
  const slot = formatTraceWord(rawSlot).replace(/^0x/, "").padStart(64, "0")
  const value = await step.stateManager.getStorage(step.address, hexToBytes(`0x${slot}`))
  const normalizedValue = value && value.length > 0
    ? `0x${Buffer.from(value).toString("hex").padStart(64, "0")}`
    : `0x${"0".repeat(64)}`
  return {
    [`0x${slot}`]: normalizedValue,
  }
}
