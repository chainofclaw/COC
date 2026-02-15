/**
 * Chain Engine with Persistent Storage
 *
 * Enhanced version of ChainEngine that uses LevelDB for:
 * - Block and transaction indexing
 * - Transaction deduplication (via nonce store)
 * - Receipts storage
 */

import type { TxReceipt, EvmChain, EvmLog } from "./evm.ts"
import { Mempool } from "./mempool.ts"
import { hashBlockPayload, validateBlockLink, zeroHash } from "./hash.ts"
import type { ChainBlock, Hex, MempoolTx } from "./blockchain-types.ts"
import { Transaction } from "ethers"
import { LevelDatabase } from "./storage/db.ts"
import { BlockIndex } from "./storage/block-index.ts"
import type { TxWithReceipt, IndexedLog, LogFilter } from "./storage/block-index.ts"
import { PersistentNonceStore } from "./storage/nonce-store.ts"
import { ChainEventEmitter } from "./chain-events.ts"
import type { BlockEvent, PendingTxEvent } from "./chain-events.ts"
import type { IStateTrie } from "./storage/state-trie.ts"
import { ValidatorGovernance } from "./validator-governance.ts"
import type { ValidatorInfo } from "./validator-governance.ts"
import { createLogger } from "./logger.ts"

const log = createLogger("persistent-engine")

export interface PersistentChainEngineConfig {
  dataDir: string
  nodeId: string
  chainId?: number
  validators: string[]
  finalityDepth: number
  maxTxPerBlock: number
  minGasPriceWei: bigint
  prefundAccounts?: Array<{ address: string; balanceWei: string }>
  stateTrie?: IStateTrie
  enableGovernance?: boolean
  validatorStakes?: Array<{ id: string; address: string; stake: bigint }>
}

export class PersistentChainEngine {
  readonly mempool: Mempool
  readonly events: ChainEventEmitter
  readonly governance: ValidatorGovernance | null
  private readonly db: LevelDatabase
  private readonly blockIndex: BlockIndex
  private readonly txNonceStore: PersistentNonceStore
  private readonly cfg: PersistentChainEngineConfig
  private readonly evm: EvmChain
  private readonly stateTrie: IStateTrie | null

  constructor(cfg: PersistentChainEngineConfig, evm: EvmChain) {
    this.cfg = cfg
    this.evm = evm
    this.mempool = new Mempool({ chainId: cfg.chainId ?? 18780 })
    this.db = new LevelDatabase(cfg.dataDir, "chain")
    this.blockIndex = new BlockIndex(this.db)
    this.txNonceStore = new PersistentNonceStore(this.db)
    this.events = new ChainEventEmitter()
    this.stateTrie = cfg.stateTrie ?? null

    // Initialize validator governance if enabled
    if (cfg.enableGovernance) {
      this.governance = new ValidatorGovernance()
      const genesisValidators = cfg.validatorStakes ?? cfg.validators.map((id) => ({
        id,
        address: "0x" + "0".repeat(40),
        stake: 1000000000000000000n, // 1 ETH default
      }))
      this.governance.initGenesis(genesisValidators)
    } else {
      this.governance = null
    }
  }

  async init(): Promise<void> {
    await this.db.open()

    // Apply prefund accounts to EVM
    if (this.cfg.prefundAccounts && this.cfg.prefundAccounts.length > 0) {
      await this.evm.prefund(this.cfg.prefundAccounts)
    }

    // Load latest block and rebuild if exists
    const latestBlock = await this.blockIndex.getLatestBlock()
    if (latestBlock) {
      // If we have a persistent state trie with a valid state root,
      // skip full replay - state is already persisted in LevelDB
      if (this.stateTrie && this.stateTrie.stateRoot()) {
        // State already restored from trie init, no replay needed
      } else {
        await this.rebuildFromPersisted(latestBlock.number)
      }
    }
  }

  async close(): Promise<void> {
    await this.db.close()
  }

  async getTip(): Promise<ChainBlock | null> {
    return this.blockIndex.getLatestBlock()
  }

  async getHeight(): Promise<bigint> {
    const tip = await this.getTip()
    return tip?.number ?? 0n
  }

  async getBlockByNumber(number: bigint): Promise<ChainBlock | null> {
    return this.blockIndex.getBlockByNumber(number)
  }

  async getBlockByHash(hash: Hex): Promise<ChainBlock | null> {
    return this.blockIndex.getBlockByHash(hash)
  }

  async getTransactionByHash(hash: Hex): Promise<TxWithReceipt | null> {
    return this.blockIndex.getTransactionByHash(hash)
  }

  async getLogs(filter: LogFilter): Promise<IndexedLog[]> {
    return this.blockIndex.getLogs(filter)
  }

  async getTransactionsByAddress(address: Hex, opts?: { limit?: number; reverse?: boolean }): Promise<TxWithReceipt[]> {
    return this.blockIndex.getTransactionsByAddress(address, opts)
  }

  async getReceiptsByBlock(number: bigint): Promise<TxReceipt[]> {
    const block = await this.getBlockByNumber(number)
    if (!block) return []

    const receipts: TxReceipt[] = []
    for (const rawTx of block.txs) {
      try {
        const parsed = Transaction.from(rawTx)
        const txHash = parsed.hash as Hex
        const tx = await this.blockIndex.getTransactionByHash(txHash)
        if (tx?.receipt) {
          receipts.push(tx.receipt)
        }
      } catch (err) {
        log.warn("skipping unparseable tx in getReceiptsByBlock", { block: number.toString(), error: String(err) })
      }
    }
    return receipts
  }

  expectedProposer(nextHeight: bigint): string {
    // Use governance-based stake-weighted selection if available
    if (this.governance) {
      const activeValidators = this.governance.getActiveValidators()
      if (activeValidators.length > 0) {
        return stakeWeightedProposer(activeValidators, nextHeight)
      }
    }

    // Fallback to simple round-robin
    const set = this.cfg.validators
    if (set.length === 0) {
      return this.cfg.nodeId
    }
    const idx = Number((nextHeight - 1n) % BigInt(set.length))
    return set[idx]
  }

  async addRawTx(rawTx: Hex): Promise<MempoolTx> {
    const tx = this.mempool.addRawTx(rawTx)

    // Check if tx already confirmed using nonce store
    const nonce = `tx:${tx.hash}`
    if (await this.txNonceStore.isUsed(nonce)) {
      this.mempool.remove(tx.hash)
      throw new Error("tx already confirmed")
    }

    // Emit pending transaction event
    this.events.emitPendingTx({
      hash: tx.hash,
      from: tx.from,
      nonce: tx.nonce,
      gasPrice: tx.gasPrice,
    })

    return tx
  }

  async proposeNextBlock(): Promise<ChainBlock | null> {
    const nextHeight = (await this.getHeight()) + 1n
    if (this.expectedProposer(nextHeight) !== this.cfg.nodeId) {
      return null
    }

    const txs = await this.mempool.pickForBlock(
      this.cfg.maxTxPerBlock,
      (address) => this.evm.getNonce(address),
      this.cfg.minGasPriceWei
    )

    const block = await this.buildBlock(nextHeight, txs)
    try {
      await this.applyBlock(block, true)
    } catch (err) {
      log.warn("block application failed, falling back to empty block", { height: nextHeight.toString(), txCount: txs.length, error: String(err) })
      for (const tx of txs) {
        this.mempool.remove(tx.hash)
      }
      const emptyBlock = await this.buildBlock(nextHeight, [])
      await this.applyBlock(emptyBlock, true)
      return emptyBlock
    }
    return block
  }

  async applyBlock(block: ChainBlock, locallyProposed = false): Promise<void> {
    const prev = await this.getTip()
    if (!validateBlockLink(prev ?? null, block)) {
      throw new Error("invalid block link")
    }
    if (this.expectedProposer(block.number) !== block.proposer) {
      throw new Error("invalid block proposer")
    }

    const expectedHash = hashBlockPayload({
      number: block.number,
      parentHash: block.parentHash,
      proposer: block.proposer,
      timestampMs: block.timestampMs,
      txs: block.txs,
    })
    if (expectedHash !== block.hash) {
      throw new Error("invalid block hash")
    }

    // Execute transactions and collect receipts + logs
    const blockLogs: IndexedLog[] = []

    for (let i = 0; i < block.txs.length; i++) {
      const raw = block.txs[i]
      const result = await this.evm.executeRawTx(raw, block.number, i, block.hash)
      const receipt = this.evm.getReceipt(result.txHash)

      // Extract from/to from the raw transaction
      const txInfo = this.evm.getTransaction(result.txHash)
      const txFrom = (txInfo?.from ?? "0x0") as Hex
      const txTo = (txInfo?.to ?? null) as Hex | null

      if (receipt) {
        const receiptLogs = Array.isArray(receipt.logs) ? receipt.logs : []

        // Store transaction with receipt
        await this.blockIndex.putTransaction(result.txHash as Hex, {
          rawTx: raw,
          receipt: {
            transactionHash: receipt.transactionHash as Hex,
            blockNumber: block.number,
            blockHash: block.hash,
            from: txFrom,
            to: txTo ?? ("0x0" as Hex),
            gasUsed: BigInt(receipt.gasUsed.toString()),
            status: BigInt(receipt.status ?? 1),
            logs: receiptLogs.map((log: EvmLog) => ({
              address: log.address as Hex,
              topics: log.topics as Hex[],
              data: log.data as Hex,
            })),
          },
        })

        // Collect indexed logs
        for (let logIdx = 0; logIdx < receiptLogs.length; logIdx++) {
          const log = receiptLogs[logIdx]
          blockLogs.push({
            address: log.address as Hex,
            topics: log.topics.map((t) => t as Hex),
            data: log.data as Hex,
            blockNumber: block.number,
            blockHash: block.hash,
            transactionHash: result.txHash as Hex,
            transactionIndex: i,
            logIndex: logIdx,
          })
        }

        // Register contract if this is a contract creation tx
        if (!txTo && receipt.contractAddress) {
          await this.blockIndex.registerContract(
            receipt.contractAddress as Hex,
            block.number,
            result.txHash as Hex,
            txFrom,
          )
        }

        // Mark transaction as confirmed
        const nonce = `tx:${result.txHash}`
        await this.txNonceStore.markUsed(nonce)
      }
    }

    // Commit state trie and attach stateRoot to block header
    if (this.stateTrie) {
      const root = await this.stateTrie.commit()
      block.stateRoot = root as Hex
    }

    // Store block and logs
    await this.blockIndex.putBlock(block)
    await this.blockIndex.putLogs(block.number, blockLogs)

    // Update finality flags for recent blocks
    await this.updateFinalityFlags()

    // Remove confirmed transactions from mempool
    for (const raw of block.txs) {
      try {
        const parsed = Transaction.from(raw)
        this.mempool.remove(parsed.hash as Hex)
      } catch (err) {
        log.warn("failed to parse tx for mempool removal", { error: String(err) })
      }
    }

    // Emit events for subscribers
    this.events.emitNewBlock({
      block,
      receipts: blockLogs.map((l) => ({
        transactionHash: l.transactionHash,
        status: "0x1",
        gasUsed: "0x5208",
      })),
    })

    for (const log of blockLogs) {
      this.events.emitLog({ log })
    }
  }

  async maybeAdoptSnapshot(blocks: ChainBlock[]): Promise<boolean> {
    const incomingTip = blocks[blocks.length - 1]
    if (!incomingTip) return false

    const currentHeight = await this.getHeight()
    if (incomingTip.number <= currentHeight) return false

    // Verify block hash chain integrity before adopting
    if (!this.verifyBlockChain(blocks)) {
      return false
    }

    await this.rebuildFromBlocks(blocks)
    return true
  }

  private verifyBlockChain(blocks: ChainBlock[]): boolean {
    for (let i = 0; i < blocks.length; i++) {
      const block = blocks[i]
      const normalized = {
        number: BigInt(block.number),
        parentHash: block.parentHash,
        proposer: block.proposer,
        timestampMs: Number(block.timestampMs),
        txs: [...block.txs],
      }
      const expectedHash = hashBlockPayload(normalized)
      if (expectedHash !== block.hash) {
        return false
      }
      if (i === 0) {
        if (BigInt(block.number) === 1n && block.parentHash !== zeroHash()) return false
      } else {
        const prev = blocks[i - 1]
        if (block.parentHash !== prev.hash) return false
        if (BigInt(block.number) !== BigInt(prev.number) + 1n) return false
      }
    }
    return true
  }

  private async buildBlock(nextHeight: bigint, selected: MempoolTx[]): Promise<ChainBlock> {
    const tip = await this.getTip()
    const parentHash = tip?.hash ?? zeroHash()
    const txs = selected.map((item) => item.rawTx)
    const timestampMs = Date.now()
    const hash = hashBlockPayload({
      number: nextHeight,
      parentHash,
      proposer: this.cfg.nodeId,
      timestampMs,
      txs,
    })

    return {
      number: nextHeight,
      hash,
      parentHash,
      proposer: this.cfg.nodeId,
      timestampMs,
      txs,
      finalized: false,
    }
  }

  private async updateFinalityFlags(): Promise<void> {
    const depth = BigInt(Math.max(1, this.cfg.finalityDepth))
    const tip = await this.getHeight()

    // Update finality for recent blocks (last 100 blocks)
    const startBlock = tip > 100n ? tip - 100n : 1n
    for (let i = startBlock; i <= tip; i++) {
      const block = await this.getBlockByNumber(i)
      if (block) {
        const wasFinalized = block.finalized
        const nowFinalized = tip >= block.number + depth

        if (wasFinalized !== nowFinalized) {
          block.finalized = nowFinalized
          await this.blockIndex.updateBlock(block)
        }
      }
    }
  }

  private async rebuildFromPersisted(latestBlockNum: bigint): Promise<void> {
    await this.evm.resetExecution()

    // Replay all blocks to restore EVM state
    for (let i = 1n; i <= latestBlockNum; i++) {
      const block = await this.getBlockByNumber(i)
      if (!block) {
        throw new Error(`Missing block ${i} during rebuild`)
      }

      // Re-execute transactions to restore EVM state
      for (let txIdx = 0; txIdx < block.txs.length; txIdx++) {
        const raw = block.txs[txIdx]
        await this.evm.executeRawTx(raw, block.number, txIdx, block.hash)
      }
    }
  }

  private async rebuildFromBlocks(blocks: ChainBlock[]): Promise<void> {
    await this.evm.resetExecution()

    for (const block of blocks) {
      const normalized: ChainBlock = {
        number: BigInt(block.number),
        hash: block.hash,
        parentHash: block.parentHash,
        proposer: block.proposer,
        timestampMs: Number(block.timestampMs),
        txs: [...block.txs],
        finalized: Boolean(block.finalized),
      }
      await this.applyBlock(normalized)
    }
  }
}

/**
 * Deterministic stake-weighted proposer selection.
 * Uses cumulative stake thresholds with block-height-seeded selection.
 */
function stakeWeightedProposer(validators: ValidatorInfo[], blockHeight: bigint): string {
  // Sort deterministically by ID
  const sorted = [...validators].sort((a, b) => a.id.localeCompare(b.id))

  const totalStake = sorted.reduce((sum, v) => sum + v.stake, 0n)
  if (totalStake === 0n) {
    // Equal weight fallback
    const idx = Number((blockHeight - 1n) % BigInt(sorted.length))
    return sorted[idx].id
  }

  // Deterministic seed from block height
  const seed = blockHeight % totalStake

  // Walk cumulative stakes to find proposer
  let cumulative = 0n
  for (const v of sorted) {
    cumulative += v.stake
    if (seed < cumulative) {
      return v.id
    }
  }

  // Fallback (shouldn't reach here)
  return sorted[0].id
}
