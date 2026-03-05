import type { TxReceipt, EvmChain } from "./evm.ts"
import { Mempool } from "./mempool.ts"
import { ChainStorage } from "./storage.ts"
import { hashBlockPayload, validateBlockLink, zeroHash } from "./hash.ts"
import type { ChainBlock, ChainSnapshot, Hex, MempoolTx } from "./blockchain-types.ts"
import { Transaction } from "ethers"
import { ChainEventEmitter } from "./chain-events.ts"
import type { NodeSigner, SignatureVerifier } from "./crypto/signer.ts"
import { calculateBaseFee, genesisBaseFee, BLOCK_GAS_LIMIT } from "./base-fee.ts"
import { BoundedSet } from "./p2p.ts"
import { createLogger } from "./logger.ts"

const log = createLogger("chain-engine")

function uniformWeightValidationError(
  prev: ChainBlock | null | undefined,
  block: ChainBlock,
): string | null {
  if (block.cumulativeWeight === undefined) {
    if (prev?.cumulativeWeight !== undefined) {
      return "block missing cumulativeWeight after weighted chain activation"
    }
    return null
  }

  // Non-governance engine uses uniform +1 weight, so cumulativeWeight must equal block height.
  const expectedWeight = BigInt(block.number)
  if (block.cumulativeWeight !== expectedWeight) {
    return `invalid cumulativeWeight: expected ${expectedWeight}, got ${block.cumulativeWeight}`
  }
  return null
}

export interface ChainEngineConfig {
  dataDir: string
  nodeId: string
  chainId?: number
  validators: string[]
  finalityDepth: number
  maxTxPerBlock: number
  minGasPriceWei: bigint
  signatureEnforcement?: "off" | "monitor" | "enforce"
}

export class ChainEngine {
  readonly mempool: Mempool
  readonly events: ChainEventEmitter
  private readonly storage: ChainStorage
  private readonly blocks: ChainBlock[] = []
  private readonly blockByNumber = new Map<bigint, ChainBlock>()
  private readonly blockByHash = new Map<Hex, ChainBlock>()
  private readonly receiptsByBlock = new Map<bigint, TxReceipt[]>()
  private readonly txHashSet = new BoundedSet<Hex>(500_000)
  private readonly cfg: ChainEngineConfig
  private readonly evm: EvmChain
  private nodeSigner: NodeSigner | null = null
  private signatureVerifier: SignatureVerifier | null = null
  private applyingBlock = false

  constructor(cfg: ChainEngineConfig, evm: EvmChain) {
    this.cfg = cfg
    this.evm = evm
    this.mempool = new Mempool({ chainId: cfg.chainId ?? 18780 })
    this.storage = new ChainStorage(cfg.dataDir)
    this.events = new ChainEventEmitter()
  }

  /** Attach a node signer for block proposer signatures */
  setNodeSigner(signer: NodeSigner, verifier: SignatureVerifier): void {
    this.nodeSigner = signer
    this.signatureVerifier = verifier
  }

  async init(): Promise<void> {
    const snapshot = await this.storage.load()
    if (snapshot.blocks.length === 0) {
      return
    }

    await this.rebuildFromBlocks(snapshot.blocks)
  }

  getTip(): ChainBlock | undefined {
    return this.blocks[this.blocks.length - 1]
  }

  getHeight(): bigint {
    return this.getTip()?.number ?? 0n
  }

  getBlockByNumber(number: bigint): ChainBlock | null {
    return this.blockByNumber.get(number) ?? null
  }

  getBlockByHash(hash: Hex): ChainBlock | null {
    return this.blockByHash.get(hash) ?? null
  }

  getBlocks(): ChainBlock[] {
    return [...this.blocks]
  }

  getReceiptsByBlock(number: bigint): TxReceipt[] {
    return this.receiptsByBlock.get(number) ?? []
  }

  makeSnapshot(): ChainSnapshot {
    return {
      blocks: [...this.blocks],
      updatedAtMs: Date.now(),
    }
  }

  expectedProposer(nextHeight: bigint): string {
    const set = this.cfg.validators
    if (set.length === 0) {
      return this.cfg.nodeId
    }
    // Guard against nextHeight <= 0 which would produce negative BigInt modulo
    if (nextHeight < 1n) {
      return set[0]
    }
    const idx = Number((nextHeight - 1n) % BigInt(set.length))
    return set[idx]
  }

  async addRawTx(rawTx: Hex): Promise<MempoolTx> {
    // Pre-check: decode tx hash and reject if already confirmed BEFORE adding to mempool
    // Fixes TOCTOU race where tx could be picked by pickForBlock between add and check
    const decoded = Transaction.from(rawTx)
    if (this.txHashSet.has(decoded.hash as Hex)) {
      throw new Error("tx already confirmed")
    }
    const tx = this.mempool.addRawTx(rawTx)

    this.events.emitPendingTx({
      hash: tx.hash,
      from: tx.from,
      nonce: tx.nonce,
      gasPrice: tx.gasPrice,
    })

    return tx
  }

  async proposeNextBlock(): Promise<ChainBlock | null> {
    const nextHeight = this.getHeight() + 1n
    if (this.expectedProposer(nextHeight) !== this.cfg.nodeId) {
      return null
    }

    // Compute baseFee for next block
    const tip = this.getTip()
    const parentBaseFee = tip?.baseFee ?? genesisBaseFee()
    const parentGasUsed = tip?.gasUsed ?? 0n
    const nextBaseFee = calculateBaseFee({ parentBaseFee, parentGasUsed })

    const txs = await this.mempool.pickForBlock(
      this.cfg.maxTxPerBlock,
      (address) => this.evm.getNonce(address),
      this.cfg.minGasPriceWei,
      nextBaseFee,
    )

    const block = this.buildBlock(nextHeight, txs)
    // Sign the proposed block if signer available
    if (this.nodeSigner) {
      block.signature = this.nodeSigner.sign(`block:${block.hash}`) as Hex
    }
    try {
      await this.applyBlock(block, true)
    } catch {
      for (const tx of txs) {
        this.mempool.remove(tx.hash)
      }
      const emptyBlock = this.buildBlock(nextHeight, [])
      if (this.nodeSigner) {
        emptyBlock.signature = this.nodeSigner.sign(`block:${emptyBlock.hash}`) as Hex
      }
      try {
        await this.applyBlock(emptyBlock, true)
      } catch (emptyErr) {
        log.error("CRITICAL: empty block fallback also failed", {
          height: nextHeight.toString(),
          error: String(emptyErr),
        })
        return null
      }
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
    const existing = this.blockByHash.get(block.hash)
    if (existing) {
      // Allow trusted local path (BFT finalize callback) to promote finality metadata.
      if (locallyProposed && block.bftFinalized && !existing.bftFinalized) {
        // Immutable update: create new block object instead of mutating stored reference
        const updated = { ...existing, bftFinalized: true }
        const arrIdx = this.blocks.indexOf(existing)
        if (arrIdx >= 0) this.blocks[arrIdx] = updated
        this.blockByNumber.set(updated.number, updated)
        this.blockByHash.set(updated.hash, updated)
        try {
          await this.storage.save(this.makeSnapshot())
        } catch {
          // best-effort metadata persistence
        }
      }
      return // already applied, skip silently
    }

    const prev = this.getTip()
    if (!validateBlockLink(prev, block)) {
      throw new Error("invalid block link")
    }
    if (this.expectedProposer(block.number) !== block.proposer) {
      throw new Error("invalid block proposer")
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

    const weightError = uniformWeightValidationError(prev, block)
    if (weightError) {
      throw new Error(weightError)
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

    const receipts: TxReceipt[] = []
    let totalGasUsed = 0n
    for (let i = 0; i < block.txs.length; i++) {
      const raw = block.txs[i]
      const result = await this.evm.executeRawTx(raw, block.number, i, block.hash, block.baseFee ?? 0n)
      const receipt = this.evm.getReceipt(result.txHash)
      if (receipt) {
        receipts.push(receipt)
        totalGasUsed += typeof receipt.gasUsed === "bigint" ? receipt.gasUsed : BigInt(receipt.gasUsed)
      }
      this.txHashSet.add(result.txHash as Hex)
    }

    // Enforce block gas limit
    if (totalGasUsed > BLOCK_GAS_LIMIT) {
      throw new Error(`block gas used ${totalGasUsed} exceeds limit ${BLOCK_GAS_LIMIT}`)
    }

    // Verify gasUsed matches claimed value (post-execution integrity check)
    if (!locallyProposed && block.gasUsed !== undefined && block.gasUsed !== totalGasUsed) {
      throw new Error(`block gasUsed mismatch: claimed ${block.gasUsed}, computed ${totalGasUsed}`)
    }

    // Create a new block object to avoid mutating the caller's input
    const storedBlock = {
      ...block,
      gasUsed: totalGasUsed,
      // Never trust remote/non-hash metadata from gossip. Finality is local-state derived.
      finalized: false,
      bftFinalized: locallyProposed && block.bftFinalized === true,
    }

    // Persist BEFORE committing to memory — if persistence fails, the block is
    // still added (chain must progress) but with a critical warning. This ordering
    // ensures makeSnapshot() includes the new block for the save operation.
    this.blocks.push(storedBlock)
    this.blockByNumber.set(storedBlock.number, storedBlock)
    this.blockByHash.set(storedBlock.hash, storedBlock)
    this.receiptsByBlock.set(block.number, receipts)

    this.updateFinalityFlags()
    try {
      await this.storage.save(this.makeSnapshot())
    } catch (saveErr) {
      // CRITICAL: block is in memory but not persisted. On restart, this block
      // will be lost, creating state inconsistency. Log at error level.
      log.error("CRITICAL: failed to persist block — node restart will lose this block", {
        height: block.number.toString(),
        hash: block.hash,
        error: String(saveErr),
        dataDir: this.cfg.dataDir,
      })
    }

    for (const raw of block.txs) {
      try {
        const parsed = Transaction.from(raw)
        this.mempool.remove(parsed.hash as Hex)
      } catch {
        // ignore parse failures
      }
    }

    // Emit new block event (use storedBlock with computed gasUsed and finality flags)
    this.events.emitNewBlock({
      block: storedBlock,
      receipts: receipts.map((r) => ({
        transactionHash: (r.transactionHash ?? "0x") as Hex,
        status: String(r.status ?? "0x1"),
        gasUsed: String(r.gasUsed ?? "0x5208"),
      })),
    })

    // Emit log events with correct transaction and log indices
    let globalLogIdx = 0
    for (let txIdx = 0; txIdx < receipts.length; txIdx++) {
      const receipt = receipts[txIdx]
      const recLogs = Array.isArray(receipt.logs) ? receipt.logs : []
      for (const logEntry of recLogs as Array<Record<string, unknown>>) {
        this.events.emitLog({
          log: {
            address: (logEntry.address ?? "0x") as Hex,
            topics: ((logEntry.topics ?? []) as string[]).map((t) => t as Hex),
            data: (logEntry.data ?? "0x") as Hex,
            blockNumber: block.number,
            blockHash: block.hash,
            transactionHash: (receipt.transactionHash ?? "0x") as Hex,
            transactionIndex: txIdx,
            logIndex: globalLogIdx++,
          },
        })
      }
    }

    } finally {
      this.applyingBlock = false
    }
  }

  async maybeAdoptSnapshot(snapshot: ChainSnapshot): Promise<boolean> {
    const incomingTip = snapshot.blocks[snapshot.blocks.length - 1]
    if (!incomingTip) return false
    if (incomingTip.number <= this.getHeight()) return false

    // Verify block hash chain integrity before adopting
    if (!this.verifyBlockChain(snapshot.blocks)) {
      return false
    }

    await this.rebuildFromBlocks(snapshot.blocks)
    await this.storage.save(this.makeSnapshot())
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
      if (uniformWeightValidationError(prev, block)) {
        return false
      }

      // Verify proposer is in validator set
      if (this.cfg.validators.length > 0 && !this.cfg.validators.includes(block.proposer)) {
        return false
      }

      // Verify proposer signature — must respect signatureEnforcement policy
      const sigMode = this.cfg.signatureEnforcement ?? "enforce"
      if (this.signatureVerifier && sigMode !== "off") {
        if (block.signature) {
          const canonical = `block:${block.hash}`
          if (!this.signatureVerifier.verifyNodeSig(canonical, block.signature, block.proposer)) {
            return false
          }
        } else if (sigMode === "enforce") {
          // Block missing signature in enforce mode — reject
          return false
        }
      }
    }
    return true
  }

  private buildBlock(nextHeight: bigint, selected: MempoolTx[]): ChainBlock {
    const tip = this.getTip()
    const parentHash = tip?.hash ?? zeroHash()
    const txs = selected.map((item) => item.rawTx)
    const timestampMs = Date.now()

    // Compute baseFee from parent block
    const parentBaseFee = tip?.baseFee ?? genesisBaseFee()
    const parentGasUsed = tip?.gasUsed ?? 0n
    const baseFee = calculateBaseFee({ parentBaseFee, parentGasUsed })

    // Accumulate cumulative weight (parent weight + 1 for uniform stake)
    const parentWeight = tip?.cumulativeWeight ?? 0n
    const cumulativeWeight = parentWeight + 1n

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

  private updateFinalityFlags(): void {
    const depth = BigInt(Math.max(1, this.cfg.finalityDepth))
    const tip = this.getHeight()
    const newlyFinalBlock = tip - depth
    if (newlyFinalBlock < 1n) return
    // Use blockByNumber map instead of array index. Array index assumes blocks
    // start at block 1 contiguously, which breaks after snap sync or partial rebuild.
    const block = this.blockByNumber.get(newlyFinalBlock)
    if (block && !block.finalized) {
      // Create new object instead of mutating — preserves immutability principle
      const updated = { ...block, finalized: true }
      // Update array entry by finding the correct index
      const arrIdx = this.blocks.indexOf(block)
      if (arrIdx >= 0) this.blocks[arrIdx] = updated
      this.blockByNumber.set(updated.number, updated)
      this.blockByHash.set(updated.hash, updated)
    }
  }

  private async rebuildFromBlocks(blocks: ChainBlock[]): Promise<void> {
    this.blocks.length = 0
    this.blockByNumber.clear()
    this.blockByHash.clear()
    this.receiptsByBlock.clear()
    this.txHashSet.clear()
    await this.evm.resetExecution()

    for (let i = 0; i < blocks.length; i++) {
      const block = blocks[i]
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
      try {
        await this.applyBlock(normalized)
      } catch (err) {
        log.error("rebuildFromBlocks failed mid-rebuild, chain state is partial", {
          failedAt: i,
          totalBlocks: blocks.length,
          blockNumber: normalized.number.toString(),
          error: String(err),
        })
        throw err
      }
    }
  }
}
