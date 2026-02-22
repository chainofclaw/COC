import type { TxReceipt, EvmChain } from "./evm.ts"
import { Mempool } from "./mempool.ts"
import { ChainStorage } from "./storage.ts"
import { hashBlockPayload, validateBlockLink, zeroHash } from "./hash.ts"
import type { ChainBlock, ChainSnapshot, Hex, MempoolTx } from "./blockchain-types.ts"
import { Transaction } from "ethers"
import { ChainEventEmitter } from "./chain-events.ts"
import type { NodeSigner, SignatureVerifier } from "./crypto/signer.ts"
import { calculateBaseFee, genesisBaseFee } from "./base-fee.ts"
import { createLogger } from "./logger.ts"

const log = createLogger("chain-engine")

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
  private readonly receiptsByBlock = new Map<bigint, TxReceipt[]>()
  private readonly txHashSet = new Set<Hex>()
  private readonly cfg: ChainEngineConfig
  private readonly evm: EvmChain
  private nodeSigner: NodeSigner | null = null
  private signatureVerifier: SignatureVerifier | null = null

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
    return this.blocks.find((b) => b.number === number) ?? null
  }

  getBlockByHash(hash: Hex): ChainBlock | null {
    return this.blocks.find((b) => b.hash === hash) ?? null
  }

  getBlocks(): ChainBlock[] {
    return [...this.blocks]
  }

  getReceiptsByBlock(number: bigint): TxReceipt[] {
    return this.receiptsByBlock.get(number) ?? []
  }

  makeSnapshot(): ChainSnapshot {
    return {
      blocks: this.blocks,
      updatedAtMs: Date.now(),
    }
  }

  expectedProposer(nextHeight: bigint): string {
    const set = this.cfg.validators
    if (set.length === 0) {
      return this.cfg.nodeId
    }
    const idx = Number((nextHeight - 1n) % BigInt(set.length))
    return set[idx]
  }

  async addRawTx(rawTx: Hex): Promise<MempoolTx> {
    const tx = this.mempool.addRawTx(rawTx)
    if (this.txHashSet.has(tx.hash)) {
      this.mempool.remove(tx.hash)
      throw new Error("tx already confirmed")
    }

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
      await this.applyBlock(emptyBlock, true)
      return emptyBlock
    }
    return block
  }

  async applyBlock(block: ChainBlock, locallyProposed = false): Promise<void> {
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
      if (prev && block.timestampMs <= prev.timestampMs) {
        throw new Error("block timestamp must be after parent timestamp")
      }
      const MAX_FUTURE_MS = 60_000
      if (block.timestampMs > Date.now() + MAX_FUTURE_MS) {
        throw new Error("block timestamp too far in the future")
      }
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

    const receipts: TxReceipt[] = []
    let totalGasUsed = 0n
    for (let i = 0; i < block.txs.length; i++) {
      const raw = block.txs[i]
      const result = await this.evm.executeRawTx(raw, block.number, i, block.hash, block.baseFee ?? 0n)
      const receipt = this.evm.getReceipt(result.txHash)
      if (receipt) {
        receipts.push(receipt)
        totalGasUsed += receipt.gasUsed ?? 0n
      }
      this.txHashSet.add(result.txHash as Hex)
    }

    // Store cumulative gas used for baseFee calculation
    block.gasUsed = totalGasUsed

    this.blocks.push(block)
    this.receiptsByBlock.set(block.number, receipts)

    for (const raw of block.txs) {
      try {
        const parsed = Transaction.from(raw)
        this.mempool.remove(parsed.hash as Hex)
      } catch {
        // ignore parse failures
      }
    }

    this.updateFinalityFlags()
    await this.storage.save(this.makeSnapshot())

    // Emit new block event
    this.events.emitNewBlock({
      block,
      receipts: receipts.map((r) => ({
        transactionHash: (r.transactionHash ?? "0x") as Hex,
        status: String(r.status ?? "0x1"),
        gasUsed: String(r.gasUsed ?? "0x5208"),
      })),
    })

    // Emit log events
    for (const receipt of receipts) {
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
            transactionIndex: 0,
            logIndex: 0,
          },
        })
      }
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

  private buildBlock(nextHeight: bigint, selected: MempoolTx[]): ChainBlock {
    const tip = this.getTip()
    const parentHash = tip?.hash ?? zeroHash()
    const txs = selected.map((item) => item.rawTx)
    const timestampMs = Date.now()

    // Compute baseFee from parent block
    const parentBaseFee = tip?.baseFee ?? genesisBaseFee()
    const parentGasUsed = tip?.gasUsed ?? 0n
    const baseFee = calculateBaseFee({ parentBaseFee, parentGasUsed })

    const hash = hashBlockPayload({
      number: nextHeight,
      parentHash,
      proposer: this.cfg.nodeId,
      timestampMs,
      txs,
    })

    // Accumulate cumulative weight (parent weight + 1 for uniform stake)
    const parentWeight = tip?.cumulativeWeight ?? 0n

    return {
      number: nextHeight,
      hash,
      parentHash,
      proposer: this.cfg.nodeId,
      timestampMs,
      txs,
      finalized: false,
      baseFee,
      cumulativeWeight: parentWeight + 1n,
    }
  }

  private updateFinalityFlags(): void {
    const depth = BigInt(Math.max(1, this.cfg.finalityDepth))
    const tip = this.getHeight()
    for (const block of this.blocks) {
      block.finalized = tip >= block.number + depth
    }
  }

  private async rebuildFromBlocks(blocks: ChainBlock[]): Promise<void> {
    this.blocks.length = 0
    this.receiptsByBlock.clear()
    this.txHashSet.clear()
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
        baseFee: block.baseFee !== undefined ? BigInt(block.baseFee) : undefined,
        cumulativeWeight: block.cumulativeWeight !== undefined ? BigInt(block.cumulativeWeight) : undefined,
      }
      await this.applyBlock(normalized)
    }
  }
}
