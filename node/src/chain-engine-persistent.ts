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
import { keccak256Hex } from "../../services/relayer/keccak256.ts"
import type { ChainBlock, Hex, MempoolTx } from "./blockchain-types.ts"
import { Transaction } from "ethers"
import type { NodeSigner, SignatureVerifier } from "./crypto/signer.ts"
import { calculateBaseFee, genesisBaseFee, BLOCK_GAS_LIMIT } from "./base-fee.ts"
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
  signatureEnforcement?: "off" | "monitor" | "enforce"
}

export class PersistentChainEngine {
  readonly mempool: Mempool
  readonly events: ChainEventEmitter
  readonly governance: ValidatorGovernance | null
  private readonly db: LevelDatabase
  readonly blockIndex: BlockIndex
  private readonly txNonceStore: PersistentNonceStore
  private readonly cfg: PersistentChainEngineConfig
  private readonly evm: EvmChain
  private readonly stateTrie: IStateTrie | null
  private nodeSigner: NodeSigner | null = null
  private signatureVerifier: SignatureVerifier | null = null
  private applyingBlock = false

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

  /** Attach a node signer for block proposer signatures */
  setNodeSigner(signer: NodeSigner, verifier: SignatureVerifier): void {
    this.nodeSigner = signer
    this.signatureVerifier = verifier
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
    } else if (this.cfg.validators.length >= 2) {
      // Multi-validator network: create deterministic genesis block.
      // All validators produce the same genesis so they start from the same state.
      const genesisProposer = this.cfg.validators[0]
      const parentHash = zeroHash()
      const genesisTimestampMs = 0 // deterministic: all nodes produce identical hash
      const hash = hashBlockPayload({
        number: 1n,
        parentHash,
        proposer: genesisProposer,
        timestampMs: genesisTimestampMs,
        txs: [],
      })
      const genesis: ChainBlock = {
        number: 1n,
        hash,
        parentHash,
        proposer: genesisProposer,
        timestampMs: genesisTimestampMs,
        txs: [],
        finalized: false,
      }
      await this.blockIndex.putBlock(genesis)
      log.info("genesis block created", { height: "1", hash, proposer: genesisProposer })
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

    // Compute baseFee for next block
    const tip = await this.getTip()
    const parentBaseFee = tip?.baseFee ?? genesisBaseFee()
    const parentGasUsed = tip?.gasUsed ?? 0n
    const nextBaseFee = calculateBaseFee({ parentBaseFee, parentGasUsed })

    const txs = await this.mempool.pickForBlock(
      this.cfg.maxTxPerBlock,
      (address) => this.evm.getNonce(address),
      this.cfg.minGasPriceWei,
      nextBaseFee,
    )

    const block = await this.buildBlock(nextHeight, txs)
    if (this.nodeSigner) {
      block.signature = this.nodeSigner.sign(`block:${block.hash}`) as Hex
    }
    try {
      await this.applyBlock(block, true)
    } catch (err) {
      log.warn("block application failed, falling back to empty block", { height: nextHeight.toString(), txCount: txs.length, error: String(err) })
      for (const tx of txs) {
        this.mempool.remove(tx.hash)
      }
      const emptyBlock = await this.buildBlock(nextHeight, [])
      if (this.nodeSigner) {
        emptyBlock.signature = this.nodeSigner.sign(`block:${emptyBlock.hash}`) as Hex
      }
      await this.applyBlock(emptyBlock, true)
      return emptyBlock
    }
    return block
  }

  async applyBlock(block: ChainBlock, locallyProposed = false): Promise<void> {
    // Re-entrant guard (async EVM execution can yield back to event loop)
    if (this.applyingBlock) {
      throw new Error("applyBlock re-entrant call detected")
    }
    this.applyingBlock = true
    try {

    // Duplicate block detection (inside guard to prevent TOCTOU race)
    const existing = await this.blockIndex.getBlockByHash(block.hash)
    if (existing) {
      // Allow trusted local path (BFT finalize callback) to promote finality metadata.
      if (locallyProposed && block.bftFinalized && !existing.bftFinalized) {
        existing.bftFinalized = true
        const tip = await this.getTip()
        if (tip?.hash === existing.hash) {
          await this.blockIndex.putBlock(existing)
        } else {
          await this.blockIndex.updateBlock(existing)
        }
      }
      return
    }

    const prev = await this.getTip()
    if (!validateBlockLink(prev ?? null, block)) {
      throw new Error("invalid block link")
    }
    if (this.expectedProposer(block.number) !== block.proposer) {
      throw new Error("invalid block proposer")
    }

    // Timestamp validation (skip for locally proposed blocks — we set them ourselves)
    if (!locallyProposed) {
      if (prev && block.timestampMs <= prev.timestampMs) {
        throw new Error("block timestamp must be after parent timestamp")
      }
      const MAX_FUTURE_MS = 60_000
      if (block.timestampMs > Date.now() + MAX_FUTURE_MS) {
        throw new Error("block timestamp too far in the future")
      }
    }

    const weightError = this.cumulativeWeightValidationError(prev, block)
    if (weightError) {
      throw new Error(weightError)
    }

    // Verify proposer signature based on enforcement mode
    const sigMode = this.cfg.signatureEnforcement ?? "enforce"
    if (!locallyProposed && this.signatureVerifier && sigMode !== "off") {
      if (block.signature) {
        const canonical = `block:${block.hash}`
        if (!this.signatureVerifier.verifyNodeSig(canonical, block.signature, block.proposer)) {
          throw new Error("block proposer signature invalid")
        }
      } else if (sigMode === "enforce") {
        throw new Error("block missing proposer signature")
      } else {
        log.warn("block missing proposer signature", { height: block.number.toString(), proposer: block.proposer })
      }
    }

    const expectedHash = hashBlockPayload({
      number: block.number,
      parentHash: block.parentHash,
      proposer: block.proposer,
      timestampMs: block.timestampMs,
      txs: block.txs,
      baseFee: block.baseFee,
      cumulativeWeight: block.cumulativeWeight,
    })
    if (expectedHash !== block.hash) {
      throw new Error("invalid block hash")
    }

    // Execute transactions and collect receipts + logs
    const blockLogs: IndexedLog[] = []
    const txReceipts: Array<{ transactionHash: string; status: string; gasUsed: string }> = []
    let totalGasUsed = 0n

    for (let i = 0; i < block.txs.length; i++) {
      const raw = block.txs[i]
      const result = await this.evm.executeRawTx(raw, block.number, i, block.hash, block.baseFee ?? 0n)
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

        totalGasUsed += BigInt(receipt.gasUsed.toString())
        txReceipts.push({
          transactionHash: receipt.transactionHash,
          status: String(receipt.status ?? "0x1"),
          gasUsed: String(receipt.gasUsed ?? "0x5208"),
        })

        // Mark transaction as confirmed
        const nonce = `tx:${result.txHash}`
        await this.txNonceStore.markUsed(nonce)
      }
    }

    // Enforce block gas limit
    if (totalGasUsed > BLOCK_GAS_LIMIT) {
      throw new Error(`block gas used ${totalGasUsed} exceeds limit ${BLOCK_GAS_LIMIT}`)
    }

    // Verify gasUsed matches claimed value (post-execution integrity check)
    if (!locallyProposed && block.gasUsed !== undefined && block.gasUsed !== totalGasUsed) {
      throw new Error(`block gasUsed mismatch: claimed ${block.gasUsed}, computed ${totalGasUsed}`)
    }

    // Store cumulative gas used for baseFee calculation
    block.gasUsed = totalGasUsed
    // Never trust remote/non-hash metadata from gossip. Finality is local-state derived.
    block.finalized = false
    block.bftFinalized = locallyProposed && block.bftFinalized === true

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
      receipts: txReceipts.map((r) => ({
        transactionHash: r.transactionHash as Hex,
        status: r.status,
        gasUsed: r.gasUsed,
      })),
    })

    for (const log of blockLogs) {
      this.events.emitLog({ log })
    }

    } finally {
      this.applyingBlock = false
    }
  }

  /**
   * Adopt a snapshot by re-executing all blocks (incremental append mode).
   * Requires parent-link continuity with current tip — will fail if
   * snapshot blocks do not link to the local chain.
   * Used by normal block-level sync when the snapshot is an extension of the current chain.
   */
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

  /**
   * Import blocks from SnapSync without re-executing transactions.
   * Skips parent-link-to-local-tip validation because SnapSync jumps ahead
   * past the snapshot window. State was already imported via SnapSyncProvider.
   * Only validates internal chain integrity (hashes, parent links within array).
   */
  async importSnapSyncBlocks(blocks: ChainBlock[]): Promise<boolean> {
    const incomingTip = blocks[blocks.length - 1]
    if (!incomingTip) return false

    const currentHeight = await this.getHeight()
    if (BigInt(incomingTip.number) <= currentHeight) return false
    const snapshotStartHeight = BigInt(blocks[0].number)
    // SnapSync block import is append-only to avoid stale hash-index residue
    // from overwriting existing heights without full reindex/replay.
    if (snapshotStartHeight <= currentHeight) return false

    // Verify internal chain integrity (hashes, parent links); skip proposer
    // check because historical blocks may reference validators no longer active
    if (!this.verifyBlockChain(blocks, true)) {
      return false
    }

    // Write blocks directly to block index — no tx re-execution needed.
    // Recompute depth-finality locally; never trust remote finalized/bftFinalized flags.
    const depth = BigInt(Math.max(1, this.cfg.finalityDepth))
    const tipHeight = BigInt(incomingTip.number)
    for (const block of blocks) {
      const blockNum = BigInt(block.number)
      const normalized: ChainBlock = {
        ...block,
        number: blockNum,
        timestampMs: Number(block.timestampMs),
        txs: [...block.txs],
        finalized: tipHeight >= blockNum + depth,
        bftFinalized: false,
        ...(block.baseFee !== undefined ? { baseFee: BigInt(block.baseFee) } : {}),
        ...(block.gasUsed !== undefined ? { gasUsed: BigInt(block.gasUsed) } : {}),
        ...(block.cumulativeWeight !== undefined ? { cumulativeWeight: BigInt(block.cumulativeWeight) } : {}),
      }
      await this.blockIndex.putBlock(normalized)
    }
    return true
  }

  /**
   * Verify internal chain integrity: hashes, parent links, timestamps.
   * @param skipProposerCheck - skip validator-set proposer check (for SnapSync
   *   where historical blocks may reference validators no longer active)
   */
  private verifyBlockChain(blocks: ChainBlock[], skipProposerCheck = false): boolean {
    // Get active validators from governance or config
    const validators = this.governance
      ? this.governance.getActiveValidators().map((v) => v.id)
      : this.cfg.validators

    for (let i = 0; i < blocks.length; i++) {
      const block = blocks[i]
      const normalized = {
        number: BigInt(block.number),
        parentHash: block.parentHash,
        proposer: block.proposer,
        timestampMs: Number(block.timestampMs),
        txs: [...block.txs],
      }
      const expectedHash = hashBlockPayload({
        ...normalized,
        baseFee: block.baseFee !== undefined ? BigInt(block.baseFee) : undefined,
        cumulativeWeight: block.cumulativeWeight !== undefined ? BigInt(block.cumulativeWeight) : undefined,
      })
      if (expectedHash !== block.hash) {
        return false
      }
      if (i === 0) {
        if (BigInt(block.number) === 1n && block.parentHash !== zeroHash()) return false
      } else {
        const prev = blocks[i - 1]
        if (block.parentHash !== prev.hash) return false
        if (BigInt(block.number) !== BigInt(prev.number) + 1n) return false
        // Verify timestamps are monotonically increasing
        if (Number(block.timestampMs) <= Number(prev.timestampMs)) return false
      }

      const prev = i > 0 ? blocks[i - 1] : undefined
      if (!this.hasValidSnapshotWeight(prev, block)) {
        return false
      }

      // Verify proposer is in validator set (skip for SnapSync — historical validators may differ)
      if (!skipProposerCheck && validators.length > 0 && !validators.includes(block.proposer)) {
        return false
      }

      // Verify proposer signature if verifier available
      if (this.signatureVerifier && block.signature) {
        const canonical = `block:${block.hash}`
        if (!this.signatureVerifier.verifyNodeSig(canonical, block.signature, block.proposer)) {
          return false
        }
      }
    }
    return true
  }

  private async buildBlock(nextHeight: bigint, selected: MempoolTx[]): Promise<ChainBlock> {
    const tip = await this.getTip()
    const parentHash = tip?.hash ?? zeroHash()
    const txs = selected.map((item) => item.rawTx)
    const timestampMs = Date.now()

    // Compute baseFee from parent block
    const parentBaseFee = tip?.baseFee ?? genesisBaseFee()
    const parentGasUsed = tip?.gasUsed ?? 0n
    const baseFee = calculateBaseFee({ parentBaseFee, parentGasUsed })

    // Accumulate cumulative weight using proposer stake
    const parentWeight = tip?.cumulativeWeight ?? 0n
    const proposerStake = this.getValidatorStake(this.cfg.nodeId)
    const cumulativeWeight = parentWeight + proposerStake

    const hash = hashBlockPayload({
      number: nextHeight,
      parentHash,
      proposer: this.cfg.nodeId,
      timestampMs,
      txs,
      baseFee,
      cumulativeWeight,
    })

    return {
      number: nextHeight,
      hash,
      parentHash,
      proposer: this.cfg.nodeId,
      timestampMs,
      txs,
      finalized: false,
      baseFee,
      cumulativeWeight,
    }
  }

  private async updateFinalityFlags(): Promise<void> {
    const depth = BigInt(Math.max(1, this.cfg.finalityDepth))
    const tip = await this.getHeight()

    // Only check the block that just crossed the finality threshold
    // At tip T with depth D, block T-D just became final
    const newlyFinalBlock = tip - depth
    if (newlyFinalBlock < 1n) return

    const block = await this.getBlockByNumber(newlyFinalBlock)
    if (block && !block.finalized) {
      block.finalized = true
      await this.blockIndex.updateBlock(block)
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
        await this.evm.executeRawTx(raw, block.number, txIdx, block.hash, block.baseFee ?? 0n)
      }
    }
  }

  /**
   * Rebuild by re-executing blocks (incremental append mode).
   * Each block is applied via applyBlock() which validates parent-link
   * continuity with the current tip. NOT suitable for SnapSync jumps —
   * use importSnapSyncBlocks() for that case.
   */
  private async rebuildFromBlocks(blocks: ChainBlock[]): Promise<void> {
    // Do NOT call resetExecution() here -- this method is used for incremental
    // sync where existing blocks are skipped by applyBlock's dedup check.
    // Resetting EVM would overwrite prefund account balances and lose state
    // from blocks not in the incoming window. resetExecution is only appropriate
    // in rebuildFromPersisted which replays ALL blocks from genesis.
    for (const block of blocks) {
      const normalized: ChainBlock = {
        ...block,
        number: BigInt(block.number),
        timestampMs: Number(block.timestampMs),
        txs: [...block.txs],
        finalized: Boolean(block.finalized),
        ...(block.baseFee !== undefined ? { baseFee: BigInt(block.baseFee) } : {}),
        ...(block.gasUsed !== undefined ? { gasUsed: BigInt(block.gasUsed) } : {}),
        ...(block.cumulativeWeight !== undefined ? { cumulativeWeight: BigInt(block.cumulativeWeight) } : {}),
      }
      await this.applyBlock(normalized)
    }
  }

  private getValidatorStake(validatorId: string): bigint {
    if (!this.governance) return 1n
    const active = this.governance.getActiveValidators()
    const validator = active.find((v) => v.id === validatorId)
    return validator?.stake ?? 1n
  }

  private cumulativeWeightValidationError(prev: ChainBlock | null, block: ChainBlock): string | null {
    if (block.cumulativeWeight === undefined) {
      if (prev?.cumulativeWeight !== undefined) {
        return "block missing cumulativeWeight after weighted chain activation"
      }
      return null
    }

    let expectedWeight: bigint
    if (this.governance) {
      const parentWeight = prev?.cumulativeWeight ?? 0n
      expectedWeight = parentWeight + this.getValidatorStake(block.proposer)
    } else {
      expectedWeight = BigInt(block.number)
    }

    if (block.cumulativeWeight !== expectedWeight) {
      return `invalid cumulativeWeight: expected ${expectedWeight}, got ${block.cumulativeWeight}`
    }
    return null
  }

  private hasValidSnapshotWeight(prev: ChainBlock | undefined, block: ChainBlock): boolean {
    if (block.cumulativeWeight === undefined) {
      return prev?.cumulativeWeight === undefined
    }

    if (!this.governance) {
      return block.cumulativeWeight === BigInt(block.number)
    }

    if (!prev || prev.cumulativeWeight === undefined) {
      return block.cumulativeWeight > 0n
    }

    return block.cumulativeWeight > prev.cumulativeWeight
  }
}

/**
 * Deterministic stake-weighted proposer selection.
 * Uses cumulative stake thresholds with block-height-seeded selection.
 */
function stakeWeightedProposer(validators: ValidatorInfo[], blockHeight: bigint): string {
  // Sort deterministically by ID
  const sorted = [...validators].sort((a, b) => a.id.localeCompare(b.id))

  if (sorted.length === 0) {
    throw new Error("cannot select proposer: validator set is empty")
  }

  const totalStake = sorted.reduce((sum, v) => sum + v.stake, 0n)
  if (totalStake === 0n) {
    // Equal weight fallback
    const idx = Number((blockHeight - 1n) % BigInt(sorted.length))
    return sorted[idx].id
  }

  // Hash block height to produce well-distributed seed (raw modulo fails when totalStake >> blockHeight)
  const hashHex = keccak256Hex(Buffer.from(blockHeight.toString(), "utf8"))
  const seed = BigInt("0x" + hashHex) % totalStake

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
