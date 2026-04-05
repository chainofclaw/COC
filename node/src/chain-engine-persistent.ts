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
import { hexToBytes } from "@ethereumjs/util"
import type { NodeSigner, SignatureVerifier } from "./crypto/signer.ts"
import { calculateBaseFee, calculateExcessBlobGas, genesisBaseFee, BLOCK_GAS_LIMIT } from "./base-fee.ts"
import { LevelDatabase } from "./storage/db.ts"
import type { BatchOp } from "./storage/db.ts"
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
  private validatorAddressMap: Map<string, string> = new Map()

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

  /** Set validator address map for identity alignment (nodeId → address) */
  setValidatorAddressMap(map: Map<string, string>): void {
    this.validatorAddressMap = map
  }

  /** Resolve validator nodeId to address for signature verification */
  private resolveValidatorAddress(nodeId: string): string {
    return this.validatorAddressMap.get(nodeId) ?? nodeId
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
    // Build sender map from mempool picks to avoid redundant ECDSA in block execution
    const senderByRawTx = new Map<string, string>()
    for (const mt of txs) senderByRawTx.set(mt.rawTx, mt.from)

    try {
      await this.applyBlock(block, true, senderByRawTx)
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

  async applyBlock(block: ChainBlock, locallyProposed = false, senderByRawTx?: Map<string, string>): Promise<void> {
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
        const updated = { ...existing, bftFinalized: true }
        // Use putBlock for tip (updates LATEST_BLOCK_KEY cache), updateBlock for non-tip
        const currentTip = await this.getTip()
        if (currentTip?.hash === updated.hash) {
          await this.blockIndex.putBlock(updated)
        } else {
          await this.blockIndex.updateBlock(updated)
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
      if (block.timestampMs < 0) {
        throw new Error("block timestamp cannot be negative")
      }
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
        const proposerAddr = this.resolveValidatorAddress(block.proposer)
        if (!this.signatureVerifier.verifyNodeSig(canonical, block.signature, proposerAddr)) {
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
      blobGasUsed: block.blobGasUsed,
      excessBlobGas: block.excessBlobGas,
      parentBeaconBlockRoot: block.parentBeaconBlockRoot,
    })
    if (expectedHash !== block.hash) {
      throw new Error("invalid block hash")
    }

    // Checkpoint state trie for atomic rollback on failure
    if (this.stateTrie) await this.stateTrie.checkpoint()

    // Execute transactions and collect receipts + logs
    const blockLogs: IndexedLog[] = []
    const txReceipts: Array<{ transactionHash: string; status: string; gasUsed: string }> = []
    let totalGasUsed = 0n
    const confirmedNonces: string[] = []
    let storedBlock: ChainBlock
    const executionTimestamp = BigInt(Math.floor(block.timestampMs / 1000))
    // Accumulate all DB ops in memory; written as single atomic batch after execution
    const allDbOps: BatchOp[] = []
    const executedTxHashes: Hex[] = []

    try {
    const blockContext: import("./evm.ts").ExecutionContext = {
      blockNumber: block.number,
      baseFeePerGas: block.baseFee ?? 0n,
      excessBlobGas: block.excessBlobGas,
      parentBeaconBlockRoot: block.parentBeaconBlockRoot ? hexToBytes(block.parentBeaconBlockRoot) : undefined,
      timestamp: executionTimestamp,
    }
    await this.evm.applyBlockContext(blockContext)

    // Pre-compute block-scoped objects once — reuse for all txs in this block
    const blockEnv = this.evm.prepareBlock(block.number, blockContext)
    const { blockCommon, executionBlock } = blockEnv._internal as { blockCommon: any; executionBlock: any }
    const baseFee = block.baseFee ?? 0n
    const blockNumberHex = `0x${block.number.toString(16)}`

    for (let i = 0; i < block.txs.length; i++) {
      const raw = block.txs[i]
      const sender = senderByRawTx?.get(raw)
      const result = await this.evm.executeRawTxInBlock(raw, blockCommon, executionBlock, block.number, i, block.hash, baseFee, blockNumberHex, sender)

      // Use directly returned receipt/from/to — no Map lookup needed
      const receipt = result.receipt
      const txFrom = (result.from ?? "0x0") as Hex
      const txTo = (result.to ?? null) as Hex | null

      {
        const receiptLogs = Array.isArray(receipt.logs) ? receipt.logs : []

        // Collect transaction ops (deferred — not written yet)
        const txOps = this.blockIndex.buildTransactionOps(result.txHash as Hex, {
          rawTx: raw,
          receipt: {
            transactionHash: receipt.transactionHash as Hex,
            blockNumber: block.number,
            blockHash: block.hash,
            from: txFrom,
            to: txTo,
            gasUsed: BigInt(receipt.gasUsed.toString()),
            status: BigInt(receipt.status ?? 1),
            logs: receiptLogs.map((log: EvmLog) => ({
              address: log.address as Hex,
              topics: log.topics as Hex[],
              data: log.data as Hex,
            })),
          },
        })
        for (let j = 0; j < txOps.length; j++) allDbOps.push(txOps[j])

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

        // Collect contract registration ops (deferred)
        if (!txTo && result.contractAddress) {
          const ctOps = this.blockIndex.buildContractOps(
            result.contractAddress as Hex,
            block.number,
            result.txHash as Hex,
            txFrom,
          )
          for (let j = 0; j < ctOps.length; j++) allDbOps.push(ctOps[j])
        }

        totalGasUsed += result.gasUsed

        // Incremental gas limit check — fail fast before more side effects
        if (totalGasUsed > BLOCK_GAS_LIMIT) {
          throw new Error(`block gas used ${totalGasUsed} exceeds limit ${BLOCK_GAS_LIMIT}`)
        }

        txReceipts.push({
          transactionHash: receipt.transactionHash,
          status: String(receipt.status ?? "0x1"),
          gasUsed: String(receipt.gasUsed ?? "0x5208"),
        })

        // Collect nonce marks and tx hashes for mempool removal
        confirmedNonces.push(`tx:${result.txHash}`)
        executedTxHashes.push(result.txHash as Hex)
      }
    }

    // Verify gasUsed matches claimed value (post-execution integrity check)
    if (!locallyProposed && block.gasUsed !== undefined && block.gasUsed !== totalGasUsed) {
      throw new Error(`block gasUsed mismatch: claimed ${block.gasUsed}, computed ${totalGasUsed}`)
    }

    // Create immutable stored block — never mutate the input parameter
    let stateRoot: Hex | undefined
    if (this.stateTrie) {
      const root = await this.stateTrie.commit()
      stateRoot = root as Hex
    }

    // Post-execution stateRoot signature
    let stateRootSig = block.stateRootSig
    if (locallyProposed && this.nodeSigner && stateRoot) {
      const stateRootMsg = `stateRoot:${block.hash}:${stateRoot}`
      stateRootSig = this.nodeSigner.sign(stateRootMsg) as Hex
    } else if (!locallyProposed && block.stateRootSig && stateRoot && this.signatureVerifier) {
      // Verify remote stateRoot against locally computed
      if (block.stateRoot && block.stateRoot !== stateRoot) {
        const sigMode = this.cfg.signatureEnforcement ?? "enforce"
        if (sigMode === "enforce") {
          throw new Error(`stateRoot mismatch: claimed ${block.stateRoot}, computed ${stateRoot}`)
        }
        log.warn("stateRoot mismatch", { height: block.number.toString(), claimed: block.stateRoot, computed: stateRoot })
      }
      const stateRootMsg = `stateRoot:${block.hash}:${stateRoot}`
      const sigMode = this.cfg.signatureEnforcement ?? "enforce"
      const proposerAddr = this.resolveValidatorAddress(block.proposer)
      if (!this.signatureVerifier.verifyNodeSig(stateRootMsg, block.stateRootSig, proposerAddr)) {
        if (sigMode === "enforce") {
          throw new Error("stateRoot signature invalid")
        }
        log.warn("stateRoot signature mismatch", { height: block.number.toString(), proposer: block.proposer })
      }
    }

    storedBlock = {
      ...block,
      gasUsed: totalGasUsed,
      stateRootSig,
      // Never trust remote/non-hash metadata from gossip. Finality is local-state derived.
      finalized: false,
      bftFinalized: locallyProposed && block.bftFinalized === true,
      ...(stateRoot !== undefined ? { stateRoot } : {}),
      ...(block.blobGasUsed !== undefined ? { blobGasUsed: BigInt(block.blobGasUsed) } : {}),
      ...(block.excessBlobGas !== undefined ? { excessBlobGas: BigInt(block.excessBlobGas) } : {}),
      ...(block.parentBeaconBlockRoot ? { parentBeaconBlockRoot: block.parentBeaconBlockRoot } : {}),
    }

    // Append block, log, and nonce ops — then flush everything in a single atomic batch
    const blockOps = this.blockIndex.buildBlockOps(storedBlock)
    const logOps = this.blockIndex.buildLogOps(block.number, blockLogs)
    const nonceOps = this.txNonceStore.buildMarkUsedOps(confirmedNonces)
    for (let j = 0; j < blockOps.length; j++) allDbOps.push(blockOps[j])
    for (let j = 0; j < logOps.length; j++) allDbOps.push(logOps[j])
    for (let j = 0; j < nonceOps.length; j++) allDbOps.push(nonceOps[j])
    await this.db.batch(allDbOps)

    // Batch evict receipt/tx caches once per block instead of per-tx
    this.evm.evictCaches()

    } catch (err) {
      // Revert state trie on any failure to prevent state pollution
      if (this.stateTrie) {
        try { await this.stateTrie.revert() } catch { /* best-effort */ }
      }
      throw err
    }

    // Update finality flags for recent blocks
    await this.updateFinalityFlags()

    // Remove confirmed transactions from mempool (reuse hashes from execution phase)
    for (const hash of executedTxHashes) {
      this.mempool.remove(hash)
    }

    // Emit events for subscribers (use storedBlock with computed fields)
    this.events.emitNewBlock({
      block: storedBlock,
      receipts: txReceipts,
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
        blobGasUsed: block.blobGasUsed !== undefined ? BigInt(block.blobGasUsed) : undefined,
        excessBlobGas: block.excessBlobGas !== undefined ? BigInt(block.excessBlobGas) : undefined,
        parentBeaconBlockRoot: block.parentBeaconBlockRoot,
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

    // Cancun blob gas state chain (EIP-4844)
    const parentExcessBlobGas = tip?.excessBlobGas ?? 0n
    const parentBlobGasUsed = tip?.blobGasUsed ?? 0n
    const excessBlobGas = calculateExcessBlobGas(parentExcessBlobGas, parentBlobGasUsed)
    const blobGasUsed = 0n  // COC does not support blob transactions
    const parentBeaconBlockRoot = zeroHash()

    const hash = hashBlockPayload({
      number: nextHeight,
      parentHash,
      proposer: this.cfg.nodeId,
      timestampMs,
      txs,
      baseFee,
      cumulativeWeight,
      blobGasUsed,
      excessBlobGas,
      parentBeaconBlockRoot,
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
      blobGasUsed,
      excessBlobGas,
      parentBeaconBlockRoot,
    }
  }

  async getHighestFinalizedBlock(): Promise<bigint> {
    const tip = await this.getHeight()
    const depth = BigInt(Math.max(1, this.cfg.finalityDepth))
    const finalized = tip - depth
    return finalized < 0n ? 0n : finalized
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
      // Immutable update: create new object instead of mutating the retrieved reference
      const updated = { ...block, finalized: true }
      await this.blockIndex.updateBlock(updated)
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

      const executionTimestamp = BigInt(Math.floor(block.timestampMs / 1000))
      await this.evm.applyBlockContext({
        blockNumber: block.number,
        baseFeePerGas: block.baseFee ?? 0n,
        excessBlobGas: block.excessBlobGas,
        parentBeaconBlockRoot: block.parentBeaconBlockRoot ? hexToBytes(block.parentBeaconBlockRoot) : undefined,
        timestamp: executionTimestamp,
      })

      // Re-execute transactions to restore EVM state
      for (let txIdx = 0; txIdx < block.txs.length; txIdx++) {
        const raw = block.txs[txIdx]
        await this.evm.executeRawTx(raw, block.number, txIdx, block.hash, block.baseFee ?? 0n, {
          excessBlobGas: block.excessBlobGas,
          parentBeaconBlockRoot: block.parentBeaconBlockRoot ? hexToBytes(block.parentBeaconBlockRoot) : undefined,
          timestamp: executionTimestamp,
        })
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
