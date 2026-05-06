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
import { calculateBaseFee, calculateExcessBlobGas, genesisBaseFee, BLOCK_GAS_LIMIT, getBlockReward, DEFAULT_HALVING_INTERVAL_BLOCKS } from "./base-fee.ts"
import { LevelDatabase } from "./storage/db.ts"
import type { BatchOp } from "./storage/db.ts"
import { BlockIndex } from "./storage/block-index.ts"
import type { TxWithReceipt, IndexedLog, LogFilter } from "./storage/block-index.ts"
import { PersistentNonceStore } from "./storage/nonce-store.ts"
import { ChainEventEmitter } from "./chain-events.ts"
import type { BlockEvent, PendingTxEvent } from "./chain-events.ts"
import type { IStateTrie } from "./storage/state-trie.ts"
import { PersistentStateManager } from "./storage/persistent-state-manager.ts"
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
  /**
   * Phase I1: when true, applyBlock mints `blockRewardWei` (halved per
   * `blockRewardHalvingInterval`) into the proposer's balance before
   * committing state. Default false — rollout is gated so mainnet/testnet
   * activation is an explicit flip on every node simultaneously (the
   * reward becomes part of consensus once enabled).
   */
  enableBlockReward?: boolean
  blockRewardWei?: bigint
  blockRewardHalvingInterval?: bigint
  /**
   * Phase I2: when true, set the executionBlock's coinbase to the block
   * proposer's address so ethereumjs runTx credits priority fee to the
   * proposer. Default false → coinbase stays at 0x0 (legacy behaviour:
   * priority fee accumulates at the zero address). Like I1, flipping to
   * true is consensus-affecting because post-state stateRoot includes
   * the proposer's credited balance — every node must run the same flag.
   */
  enableFeeDistribution?: boolean
  /**
   * Phase J1.2: invoked when a non-locally-proposed block is rejected
   * because its claimed stateRoot does not match the locally computed one.
   * The wiring layer (index.ts) routes this to consensus.requestSyncNow()
   * so a stateRoot-corrupted local node can catch up via snap-sync without
   * needing the BFT coordinator to enter a timeout path first — the latter
   * is the H4/H5 deadzone that stalled testnet at 206803 on 2026-05-05
   * (BFT round never started because every incoming block 206804 proposal
   * was rejected at the parent stateRoot check, so prepareVotes stayed
   * empty and detectPeerQuorumDivergence() had nothing to fire on).
   */
  onLocalApplyRejected?: (info: {
    height: bigint
    blockHash: Hex
    expectedRoot: Hex
    actualRoot: Hex
    reason: string
  }) => void
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
  // Serializes concurrent applyBlock callers (see public applyBlock jsdoc).
  private applyQueue: Promise<void> = Promise.resolve()

  /**
   * Force-clear the re-entrant applyBlock guard. The flag is normally cleared
   * in a finally block, but if applyBlock hangs inside an uninterruptible VM
   * operation the finally never runs, leaving the flag pinned true and making
   * every subsequent applyBlock throw "re-entrant" — even legitimate retries.
   *
   * This is only safe to call after the hung applyBlock has been given up on
   * by a higher-level timeout (onFinalized 75s work slot). Any persistent
   * state it partially wrote is recovered via the trie overlay + LevelDB
   * batch atomicity guarantees; stale EVM stateManager checkpoints are
   * revertible on the next block via revertState().
   */
  resetApplyingFlag(): void {
    this.applyingBlock = false
  }
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

  /**
   * Phase J1.3: late-bound rejection callback. The engine is constructed
   * before consensus exists, so we register the consensus.requestSyncNow
   * route via this setter after both are wired. Overrides any callback
   * passed in cfg at construction time.
   */
  setOnLocalApplyRejected(
    cb: NonNullable<PersistentChainEngineConfig["onLocalApplyRejected"]>,
  ): void {
    ;(this.cfg as { onLocalApplyRejected?: typeof cb }).onLocalApplyRejected = cb
  }

  /** Resolve validator nodeId to address for signature verification */
  private resolveValidatorAddress(nodeId: string): string {
    return this.validatorAddressMap.get(nodeId) ?? nodeId
  }

  async init(): Promise<void> {
    await this.db.open()

    // Load latest block first to decide whether this is a genesis boot or a restart.
    const latestBlock = await this.blockIndex.getLatestBlock()

    // Prefund accounts are a genesis-only concern. On a restart with a populated
    // LevelDB, writing genesis balances over a persisted trie corrupts internal
    // trie nodes (Trie "Stack underflow") because the trie still holds cached
    // references from the prior run and the stateRoot has not yet been restored.
    // Persisted balances are already on disk — only prefund when the chain is empty.
    if (
      !latestBlock &&
      this.cfg.prefundAccounts &&
      this.cfg.prefundAccounts.length > 0
    ) {
      await this.evm.prefund(this.cfg.prefundAccounts)
    } else if (
      latestBlock &&
      this.cfg.prefundAccounts &&
      this.cfg.prefundAccounts.length > 0
    ) {
      // Still record the accounts for in-memory replay paths that need them
      // (e.g. speculative re-execution), without writing to the persistent trie.
      this.evm.setPrefundAccounts(this.cfg.prefundAccounts)
    }

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

      // Commit prefunded balances to the state trie so block 1 carries a
      // queryable stateRoot. Without this, eth_getBalance on "latest" returns 0
      // and no account can fund contract deploys until the first regular block.
      let genesisStateRoot: Hex | undefined
      if (this.stateTrie) {
        const root = await this.stateTrie.commit()
        genesisStateRoot = root as Hex
      }

      const hash = hashBlockPayload({
        number: 1n,
        parentHash,
        proposer: genesisProposer,
        timestampMs: genesisTimestampMs,
        txs: [],
        cumulativeWeight: 1n,
      })
      const genesis: ChainBlock = {
        number: 1n,
        hash,
        parentHash,
        proposer: genesisProposer,
        timestampMs: genesisTimestampMs,
        txs: [],
        finalized: false,
        cumulativeWeight: 1n,
        ...(genesisStateRoot !== undefined ? { stateRoot: genesisStateRoot } : {}),
      }
      await this.blockIndex.putBlock(genesis)
      log.info("genesis block created", {
        height: "1",
        hash,
        proposer: genesisProposer,
        stateRoot: genesisStateRoot ?? "(none)",
      })
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

  /**
   * Propose the next block.
   *
   * When `deferApply` is true (BFT mode), the block is built and signed but
   * NOT applied to local EVM/chain state. The caller must apply it later via
   * applyBlock() (typically in the BFT onFinalized callback). This prevents
   * height divergence when BFT round times out — the proposer stays at the
   * same height as other validators.
   *
   * When `deferApply` is false (non-BFT mode), the block is applied immediately
   * as before.
   */
  /**
   * Run `block` through the EVM against current state without committing —
   * returns the post-execution stateRoot the persistent trie would hold
   * if this block were applied. The BFT coordinator uses this to anchor
   * our prepare vote on (blockHash, stateRoot): quorum requires 2/3+
   * validators to agree on both, so a proposer can't slip a block whose
   * stateRoot other validators can't reproduce.
   *
   * Skips block-index writes, mempool updates, and receipt persistence —
   * those are intentionally left to applyBlock. State-trie / EVM mutations
   * are reverted via checkpoint/revert before this returns.
   *
   * Returns undefined when the trie isn't initialized or when execution
   * throws mid-block (e.g. proposer sent a tx we can't process). BFT
   * falls back to voting without stateRoot in that case, which under the
   * protocol's backward-compat rules lets the cluster still finalize so
   * long as the group reaches quorum overall.
   */
  async speculativelyComputeStateRoot(block: ChainBlock): Promise<Hex | undefined> {
    // Phase B: compute the post-block stateRoot on an isolated fork so the
    // BFT coordinator can anchor its prepare vote on (blockHash, stateRoot).
    // PR #7's quorum logic then rejects any proposer whose declared stateRoot
    // 2/3+ of the validator set can't reproduce — stopping divergence at the
    // vote stage instead of the apply stage.
    //
    // Isolation strategy (see plans/coc-phase-b-stateroot-vote.md):
    //  1. stateTrie.forkForDryRun() creates an independent PersistentStateTrie
    //     backed by v6 Trie.shallowCopy(false) — same committed root, empty
    //     CheckpointDB, already carrying one isolation checkpoint. Writes
    //     stay in the frame's in-memory keyValueMap.
    //  2. Wrap the fork in a fresh PersistentStateManager and bind it to a
    //     dry-run EvmChain inheriting this chain's chainId/hardfork schedule.
    //  3. Replay the block's txs through the dry-run EVM exactly the way
    //     applyBlock does (same blockContext, same prepareBlock internals,
    //     trustBlock=true to skip sender nonce/balance pre-validation that
    //     would fail on receiver-only state).
    //  4. Read the post-exec root from the dry-run stateManager and return.
    //  5. The fork is never committed — the caller drops it and GC reclaims
    //     the checkpoint frame, so no write ever reaches LevelDB.
    //
    // Any failure (missing stateTrie, malformed tx, EVM throw) falls back to
    // undefined, which the bft-coordinator wrapper translates to "vote
    // without stateRoot" — hash-only quorum for that round. This is the same
    // fail-open contract the previous stub promised.
    if (!this.stateTrie) return undefined

    // Phase R2 (2026-05-06): refuse speculative compute when our chain tip
    // doesn't match the proposed block's parent. Two failure modes this
    // closes:
    //   (a) we're mid-applyBlock for the parent height — trie's committed
    //       root is still N-1, but the block claims parent=N. Computing
    //       against N-1's state would produce a wrong stateRoot and our
    //       prepare vote would poison BFT quorum.
    //   (b) we have an off-by-one / fork-choice gap — same outcome.
    // Returning undefined falls through to hash-only quorum (BftCoordinator
    // contract), which is safe for liveness; we just skip stating a stateRoot
    // we couldn't produce honestly.
    const localTip = await this.getTip()
    const expectedParentHash = block.parentHash?.toLowerCase()
    const localTipHash = localTip?.hash?.toLowerCase()
    if (expectedParentHash && localTipHash && expectedParentHash !== localTipHash) {
      log.warn("Phase R2: speculative compute aborted — parent mismatch", {
        height: block.number.toString(),
        blockParent: expectedParentHash,
        localTip: localTipHash,
      })
      return undefined
    }

    // Phase R2: force a sync pass on the parent trie so any dirty storage
    // sub-tries (e.g. BEACON_ROOTS write from the previous applyBlock that
    // hasn't yet propagated its storageRoot into the account record) are
    // flushed into the trie before we shallowCopy. Without this, the fork
    // inherits a stale account record whose storageRoot points at the
    // pre-write state, and computeStateRoot returns a non-canonical root.
    // computeStateRoot is idempotent + cheap when dirtyAddresses is empty;
    // it's a defensive flush, not a fast path.
    try {
      await this.stateTrie.computeStateRoot()
    } catch (err) {
      log.warn("Phase R2: parent-trie sync threw — continuing with potentially stale fork", {
        height: block.number.toString(),
        error: String(err),
      })
    }

    // Phase H1 diagnostic: env-gated detailed logging to identify the
    // mechanism behind the recurring proposer-vs-non-proposer divergence
    // observed on testnet 2026-04-30 (heights 140,392 / 141,052 / etc).
    //
    // Logs the BEACON_ROOTS account record + storage-trie state from the
    // FORK at three points: (1) right after fork creation, (2) after
    // applyBlockContext (BEACON_ROOTS write site), (3) after txs replayed.
    // Comparing proposer vs non-proposer dumps for the same block tells us
    // whether divergence appears at fork time (pre-state issue) or only
    // after a specific dry-run step (compute non-determinism).
    //
    // Off by default to avoid log volume in production. Enable with
    // COC_DIAG_SPEC_ROOT=1 on testnet to capture data; safe to leave in
    // place permanently.
    const diagEnabled = process.env.COC_DIAG_SPEC_ROOT === "1"
    const BEACON_ROOTS_ADDR = "0x000f3df6d732807ef1319fb7b8bb8522d0beac02"
    const dumpBeaconState = async (trie: IStateTrie, label: string): Promise<void> => {
      if (!diagEnabled) return
      try {
        const acc = await trie.get(BEACON_ROOTS_ADDR)
        log.info("[diag] speculative-compute BEACON_ROOTS state", {
          label,
          height: block.number.toString(),
          isProposer: block.proposer.toLowerCase() === this.cfg.nodeId.toLowerCase(),
          accountExists: !!acc,
          storageRoot: acc?.storageRoot ?? "<no-account>",
          codeHash: acc?.codeHash ?? "<no-account>",
          parentBeaconBlockRoot: block.parentBeaconBlockRoot ?? "<undef>",
          blockTimestamp: BigInt(Math.floor(block.timestampMs / 1000)).toString(),
          trieRoot: trie.stateRoot() ?? "<null>",
        })
      } catch (err) {
        log.warn("[diag] BEACON_ROOTS dump failed (non-fatal)", { label, error: String(err) })
      }
    }

    // Adversarial test hook: force a specific "computed" stateRoot so
    // integration tests (scripts/adversarial-stateroot-divergence.sh) can
    // validate the pair-quorum defense end-to-end on a live devnet. The
    // env var is deliberately prefixed COC_UNSAFE_ to make accidental
    // production use highly visible in node-config dumps / process listings.
    // Never set in a real deployment — you're telling BFT to vote on a
    // stateRoot that has no relationship to actual post-block state.
    const adversarial = process.env.COC_UNSAFE_ADVERSARIAL_SPEC_ROOT
    if (adversarial && /^0x[0-9a-fA-F]{64}$/.test(adversarial)) {
      log.warn("COC_UNSAFE_ADVERSARIAL_SPEC_ROOT is set — returning poisoned root", {
        height: block.number.toString(),
        poisonRoot: adversarial,
      })
      return adversarial as Hex
    }

    let dryTrie: IStateTrie | null = null
    try {
      dryTrie = await this.stateTrie.forkForDryRun()
      // Phase H1 diag point 1: state of fork BEFORE any block context
      await dumpBeaconState(dryTrie, "post-fork")

      const drySm = new PersistentStateManager(dryTrie)
      const dryEvm = await this.evm.createDryRunChain(drySm)

      // Phase I2: mirror applyBlock's coinbase-as-proposer wiring so the
      // dry-run's priority-fee credit lands on the same address. Without
      // this, post-state would diverge once any tx with non-zero priority
      // fee is included. Env-gated identically to apply path.
      const proposerCoinbase = (this.cfg.enableFeeDistribution && block.proposer)
        ? this.resolveValidatorAddress(block.proposer)
        : undefined
      const dryCoinbase = proposerCoinbase && /^0x[0-9a-fA-F]{40}$/.test(proposerCoinbase)
        ? proposerCoinbase
        : undefined
      const blockContext: import("./evm.ts").ExecutionContext = {
        blockNumber: block.number,
        baseFeePerGas: block.baseFee ?? 0n,
        excessBlobGas: block.excessBlobGas,
        parentBeaconBlockRoot: block.parentBeaconBlockRoot ? hexToBytes(block.parentBeaconBlockRoot) : undefined,
        timestamp: BigInt(Math.floor(block.timestampMs / 1000)),
        coinbase: dryCoinbase,
      }
      await dryEvm.applyBlockContext(blockContext)
      // Phase H1 diag point 2: state AFTER applyBlockContext (BEACON_ROOTS
      // storage writes happen inside applyParentBeaconBlockRoot here).
      await dumpBeaconState(dryTrie, "post-applyBlockContext")

      const blockEnv = dryEvm.prepareBlock(block.number, blockContext)
      const { blockCommon, executionBlock } = blockEnv._internal as { blockCommon: any; executionBlock: any }
      const baseFee = block.baseFee ?? 0n
      const blockNumberHex = `0x${block.number.toString(16)}`

      // trustBlock=true mirrors applyBlock's BFT path: skip sender nonce and
      // balance pre-validation so the dry-run can execute on state that only
      // mirrors what's relevant. Matches the "deterministic re-execution"
      // contract.
      for (let i = 0; i < block.txs.length; i++) {
        await dryEvm.executeRawTxInBlock(
          block.txs[i],
          blockCommon,
          executionBlock,
          block.number,
          i,
          block.hash,
          baseFee,
          blockNumberHex,
          undefined,
          true,
        )
      }

      // Phase I1: Mirror applyBlock's per-block reward credit on the dry-run
      // fork. Without this, the speculative root computed here would diverge
      // from the post-apply root that BFT validators verify — every block
      // would fail the (hash, stateRoot) joint quorum once block rewards
      // are enabled. Same condition as applyBlock: enabled, has proposer,
      // not genesis.
      if (this.cfg.enableBlockReward && block.proposer && block.number > 0n) {
        const reward = getBlockReward(
          block.number,
          this.cfg.blockRewardWei ?? 0n,
          this.cfg.blockRewardHalvingInterval ?? DEFAULT_HALVING_INTERVAL_BLOCKS,
        )
        if (reward > 0n) {
          const proposerAddr = this.resolveValidatorAddress(block.proposer)
          await dryEvm.creditBalance(proposerAddr, reward)
        }
      }

      // Read the post-execution root directly from the fork's v6 trie.
      // Cannot use drySm.getStateRoot() / dryTrie.stateRoot() — those return
      // the cached `lastStateRoot`, which PersistentStateTrie.put() resets
      // to null after every mutation (kept live only by commit()). A commit
      // on the fork would flush the isolation frame and defeat the
      // zero-pollution contract, so we read the live root via the dedicated
      // side-effect-free API.
      //
      // computeStateRoot() is async because it syncs dirty storage tries
      // into the account trie before reading root — without that sync,
      // the BEACON_ROOTS storage write that prepareVmForExecution does on
      // every Cancun block isn't reflected in trie.root(), and three
      // validators dry-running the same empty block produced divergent
      // stateRoots (testnet stall at height 140,392 on 2026-04-30).
      const computedRoot = (await dryTrie.computeStateRoot()) as Hex
      // Phase H1 diag point 3: state at the moment the value is returned.
      await dumpBeaconState(dryTrie, "post-computeStateRoot")
      if (diagEnabled) {
        log.info("[diag] speculative-compute returning", {
          height: block.number.toString(),
          isProposer: block.proposer.toLowerCase() === this.cfg.nodeId.toLowerCase(),
          computedRoot,
          txCount: block.txs.length,
        })
      }
      return computedRoot
    } catch (err) {
      log.warn("speculative stateRoot compute failed; voting without stateRoot", {
        height: block.number.toString(),
        hash: block.hash,
        error: String(err),
      })
      return undefined
    } finally {
      // The fork is unreferenced after this returns; GC reclaims its
      // CheckpointDB frame + in-memory keyValueMap. The explicit null is
      // belt-and-suspenders: if a future caller ever keeps the engine alive
      // much longer than its stack frame, nulling breaks a potential
      // closure-capture reference earlier. We do NOT commit — that would
      // flush the frame to the shared LevelDB.
      dryTrie = null
    }
  }

  async proposeNextBlock(deferApply = false, forcePropose = false): Promise<ChainBlock | null> {
    const nextHeight = (await this.getHeight()) + 1n
    // Phase X1.6 (2026-05-06): case-insensitive proposer check. The validators
    // array is canonicalized to lowercase but a node's `cfg.nodeId` may be
    // EIP-55 checksummed (mixed case). A strict `!==` returned "not my turn"
    // forever for any validator whose nodeId differed from the lowercase set,
    // breaking proposer rotation. Normalize both sides.
    if (!forcePropose && this.expectedProposer(nextHeight).toLowerCase() !== this.cfg.nodeId.toLowerCase()) {
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
      undefined, // blockGasLimit — use mempool default
      // Phase H3 affordability filter: drops txs whose sender can't pay
      // upfront cost. Prevents the 2026-04-30 mempool-poison stall where
      // anvil[1]'s drained balance let a uncovered tx into the proposer's
      // block, applyBlock failed with "insufficient funds", BFT-finalized
      // a different (clean) hash, and the proposer kept retrying its
      // local poisoned copy → chain stuck.
      (address) => this.evm.getBalance(address),
    )

    let block = await this.buildBlock(nextHeight, txs)
    if (this.nodeSigner) {
      block.signature = this.nodeSigner.sign(`block:${block.hash}`) as Hex
    }

    // In BFT deferred mode, return the built block without applying.
    // The block will be applied when BFT onFinalized fires.
    if (deferApply) {
      return block
    }

    // Non-BFT mode: apply immediately (original behavior)
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

  /**
   * Public applyBlock: serializes concurrent callers via a Promise-chain queue.
   *
   * Prior to this change, a second concurrent caller would hit the `applyingBlock`
   * re-entrant guard and throw `applyBlock re-entrant call detected`, forcing every
   * caller (proposer path, gossip onBlock, BFT onFinalized) to wrap the call in a
   * try/catch that silently recovered. Testing showed this fail-fast reaction
   * masked a real need for serialization: the proposer can finish applying while
   * a BFT-retry gossip frame re-delivers the same block, and both are valid.
   *
   * The queue ensures every caller's promise resolves in FIFO order. Rejections
   * stay with their own caller — a failed apply does not poison the chain, so
   * subsequent queued applies still run.
   */
  async applyBlock(block: ChainBlock, locallyProposed = false, senderByRawTx?: Map<string, string>): Promise<void> {
    const run = () => this._applyBlockImpl(block, locallyProposed, senderByRawTx)
    const prior = this.applyQueue
    const current = prior.then(run, run)
    // Absorb rejections into the chain-tracking promise so the next caller's
    // `then(run, run)` continues; per-caller rejection is still exposed via `current`.
    this.applyQueue = current.catch(() => {})
    return current
  }

  private async _applyBlockImpl(block: ChainBlock, locallyProposed = false, senderByRawTx?: Map<string, string>): Promise<void> {
    // Re-entrant guard retained as a safety net: the queue prevents concurrent
    // callers under normal paths, but the flag is still consulted by
    // `resetApplyingFlag()` after the onFinalized 75 s outer timeout abandons
    // a hung apply. Keeping it here preserves that recovery contract.
    if (this.applyingBlock) {
      throw new Error("applyBlock re-entrant call detected")
    }
    this.applyingBlock = true
    try {

    // Early phase markers — the previous patch only started emitting from
    // checkpoint() onwards, but a subsequent deadlock was observed with no
    // phase log at all, indicating the hang sits in one of these DB reads.
    const earlyPhaseLog = (phase: string, extra?: Record<string, unknown>) => {
      log.info("applyBlock phase", { height: block.number.toString(), phase, ...(extra ?? {}) })
    }

    earlyPhaseLog("dup-check")
    // Duplicate block detection (inside guard to prevent TOCTOU race)
    const existing = await this.blockIndex.getBlockByHash(block.hash)
    if (existing) {
      // Allow trusted local path (BFT finalize callback) to promote finality metadata.
      if (locallyProposed && block.bftFinalized && !existing.bftFinalized) {
        const updated = { ...existing, bftFinalized: true }
        earlyPhaseLog("dup-promote.getTip")
        // Use putBlock for tip (updates LATEST_BLOCK_KEY cache), updateBlock for non-tip
        const currentTip = await this.getTip()
        if (currentTip?.hash === updated.hash) {
          earlyPhaseLog("dup-promote.putBlock")
          await this.blockIndex.putBlock(updated)
        } else {
          earlyPhaseLog("dup-promote.updateBlock")
          await this.blockIndex.updateBlock(updated)
        }
      }
      earlyPhaseLog("dup-return")
      return
    }

    earlyPhaseLog("getTip")
    const prev = await this.getTip()
    if (!validateBlockLink(prev ?? null, block)) {
      throw new Error("invalid block link")
    }
    if (this.expectedProposer(block.number).toLowerCase() !== block.proposer.toLowerCase()) {
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

    // Phase markers: let operators localize a hang to a specific await.
    // Emitted at "info" so they're filterable via `grep phase=` in node logs.
    // The last "phase=" line before a BFT onFinalized timeout identifies
    // exactly which await inside applyBlock stopped returning.
    const phaseLog = (phase: string, extra?: Record<string, unknown>) => {
      log.info("applyBlock phase", { height: block.number.toString(), phase, ...(extra ?? {}) })
    }

    phaseLog("checkpoint")
    // Checkpoint both EVM stateManager and persistent trie for atomic rollback on failure
    await this.evm.checkpointState()
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
    // Phase I2: derive coinbase = proposer address so ethereumjs runTx
    // credits priority fee (gasUsed * priorityPerGas) to the proposer.
    // Base fee remains implicitly burned — sender pays full effectivePrice
    // but runTx only credits the priority component to coinbase.
    // resolveValidatorAddress is a no-op when block.proposer is already a
    // 20-byte hex address (the common case in this network). Env-gated:
    // legacy networks see coinbase=0x0 (priority fee accumulates there)
    // until enableFeeDistribution flips on cluster-wide.
    const proposerCoinbase = (this.cfg.enableFeeDistribution && block.proposer)
      ? this.resolveValidatorAddress(block.proposer)
      : undefined
    const coinbase = proposerCoinbase && /^0x[0-9a-fA-F]{40}$/.test(proposerCoinbase)
      ? proposerCoinbase
      : undefined
    const blockContext: import("./evm.ts").ExecutionContext = {
      blockNumber: block.number,
      baseFeePerGas: block.baseFee ?? 0n,
      excessBlobGas: block.excessBlobGas,
      parentBeaconBlockRoot: block.parentBeaconBlockRoot ? hexToBytes(block.parentBeaconBlockRoot) : undefined,
      timestamp: executionTimestamp,
      coinbase,
    }
    phaseLog("applyBlockContext")
    await this.evm.applyBlockContext(blockContext)
    phaseLog("tx-loop", { txCount: block.txs.length })

    // Pre-compute block-scoped objects once — reuse for all txs in this block
    const blockEnv = this.evm.prepareBlock(block.number, blockContext)
    const { blockCommon, executionBlock } = blockEnv._internal as { blockCommon: any; executionBlock: any }
    const baseFee = block.baseFee ?? 0n
    const blockNumberHex = `0x${block.number.toString(16)}`

    // For BFT-finalized blocks, trust the block's transaction ordering and skip
    // nonce/balance pre-validation. The BFT consensus layer has already confirmed
    // the block's validity through 2/3 stake-weighted voting. This enables
    // deterministic re-execution regardless of local EVM state differences.
    // In deferred-apply mode, even the proposer's own block goes through onFinalized
    // with locallyProposed=true, so we always trust when bftFinalized is set.
    const trustBlock = !!block.bftFinalized || !locallyProposed

    for (let i = 0; i < block.txs.length; i++) {
      const raw = block.txs[i]
      const sender = senderByRawTx?.get(raw)
      phaseLog("executeRawTx", { txIndex: i, rawPrefix: raw.slice(0, 18) })
      const result = await this.evm.executeRawTxInBlock(raw, blockCommon, executionBlock, block.number, i, block.hash, baseFee, blockNumberHex, sender, trustBlock)

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

    // Phase I1: Mint per-block reward to the proposer's address inside the
    // same EVM checkpoint as tx execution, so the credit is committed
    // atomically with the block (or rolled back together if applyBlock
    // throws below). The mint happens AFTER tx-loop and BEFORE commitState
    // / stateTrie.commit, which means the post-commit stateRoot already
    // reflects the credit and remote validators recompute the same root.
    if (this.cfg.enableBlockReward && block.proposer && block.number > 0n) {
      const reward = getBlockReward(
        block.number,
        this.cfg.blockRewardWei ?? 0n,
        this.cfg.blockRewardHalvingInterval ?? DEFAULT_HALVING_INTERVAL_BLOCKS,
      )
      if (reward > 0n) {
        const proposerAddr = this.resolveValidatorAddress(block.proposer)
        phaseLog("blockReward", { proposer: proposerAddr, reward: reward.toString() })
        await this.evm.creditBalance(proposerAddr, reward)
      }
    }

    phaseLog("commitState")
    // Commit EVM stateManager checkpoint (matches the checkpoint() at block start)
    await this.evm.commitState()

    // Create immutable stored block — never mutate the input parameter
    let stateRoot: Hex | undefined
    if (this.stateTrie) {
      phaseLog("stateTrie.commit")
      const root = await this.stateTrie.commit()
      stateRoot = root as Hex

      // Phase H1b: belt-and-suspenders post-apply parent-trie sync.
      // commit() already syncs dirty storage tries into account records
      // and clears dirtyAddresses, so this should be a no-op in the
      // common case. We still do it once more to defend against the
      // recurring testnet symptom where proposer-side speculative
      // compute diverges on empty blocks — the hypothesis is that some
      // code path leaves the parent trie's BEACON_ROOTS account record
      // pointing at a stale storageRoot, and forkForDryRun inherits
      // that staleness. Calling computeStateRoot() here forces another
      // sync pass and updates lastStateRoot to the verified live root.
      // Idempotent + cheap: dirtyAddresses is empty post-commit so the
      // sync loop is a no-op; the trie.root() read is just a hash.
      await this.stateTrie.computeStateRoot()

      // Phase H1 diag point 4: state of MAIN trie after apply+commit.
      // Compared with the speculative compute's "post-fork" diag entry
      // for the SAME height on the next block, this tells us whether
      // the parent trie's view of BEACON_ROOTS is canonical.
      if (process.env.COC_DIAG_SPEC_ROOT === "1") {
        try {
          const acc = await this.stateTrie.get("0x000f3df6d732807ef1319fb7b8bb8522d0beac02")
          log.info("[diag] post-apply MAIN trie BEACON_ROOTS state", {
            height: block.number.toString(),
            blockProposer: block.proposer,
            isLocalProposer: block.proposer.toLowerCase() === this.cfg.nodeId.toLowerCase(),
            accountExists: !!acc,
            storageRoot: acc?.storageRoot ?? "<no-account>",
            mainStateRoot: stateRoot,
          })
        } catch (err) {
          log.warn("[diag] post-apply BEACON_ROOTS dump failed", { error: String(err) })
        }
      }
    }

    // Phase H10: unconditional stateRoot equality enforcement.
    //
    // The previous gating (`!locallyProposed && block.stateRootSig &&
    // signatureVerifier`) left a critical hole: if a BFT-finalized block
    // arrived without a stateRoot signature OR was applied via a code
    // path that didn't carry the verifier, the equality check was
    // silently skipped — and the apply would commit a state-tree whose
    // root didn't match the block's claimed root. Subsequent queries
    // (eth_getTransactionCount etc.) returned stale state because the
    // committed root advanced but the underlying trie data didn't reflect
    // every tx's mutations. The 2026-04-30 testnet stalls all share this
    // signature: same stateRoot reported on all 3 nodes but `nonce@latest`
    // differed for accounts whose txs were silently skipped on node-1.
    //
    // Fix: when both `block.stateRoot` and our computed `stateRoot` are
    // present, ALWAYS compare. Throw on mismatch under default
    // signatureEnforcement="enforce" so the catch reverts EVM + trie
    // checkpoints atomically; the BFT layer's onFinalized retry / H4
    // peer-quorum path picks up from there.
    if (stateRoot && block.stateRoot && block.stateRoot !== stateRoot) {
      const sigMode = this.cfg.signatureEnforcement ?? "enforce"
      log.error("Phase H10 stateRoot mismatch — silent-skip detected", {
        height: block.number.toString(),
        blockHash: block.hash,
        claimed: block.stateRoot,
        computed: stateRoot,
        locallyProposed,
        txCount: block.txs.length,
        enforcement: sigMode,
      })
      // Phase J1.2: notify wiring layer so it can trigger snap-sync. We
      // report on every mismatch (regardless of enforcement mode) because
      // the throw below short-circuits applyBlock; the BFT round never
      // accumulates a prepareVote, so the H4 timeout-time detection never
      // fires. This callback is the in-band signal that "we and peers
      // disagree on the post-state of THIS block" — the cleanest moment
      // to escalate to snap-sync.
      if (!locallyProposed && this.cfg.onLocalApplyRejected) {
        try {
          this.cfg.onLocalApplyRejected({
            height: block.number,
            blockHash: block.hash,
            expectedRoot: block.stateRoot,
            actualRoot: stateRoot,
            reason: "stateRoot mismatch",
          })
        } catch (err) {
          log.warn("onLocalApplyRejected callback threw", { error: String(err) })
        }
      }
      if (sigMode === "enforce") {
        throw new Error(`stateRoot mismatch: claimed ${block.stateRoot}, computed ${stateRoot}`)
      }
    }

    // Post-execution stateRoot signature
    let stateRootSig = block.stateRootSig
    if (locallyProposed && this.nodeSigner && stateRoot) {
      const stateRootMsg = `stateRoot:${block.hash}:${stateRoot}`
      stateRootSig = this.nodeSigner.sign(stateRootMsg) as Hex
    } else if (!locallyProposed && block.stateRootSig && stateRoot && this.signatureVerifier) {
      // Signature verification is independent of stateRoot equality (which
      // is now enforced unconditionally above). This branch only validates
      // the proposer's signature when one is present.
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
    phaseLog("db.batch", { opCount: allDbOps.length })
    await this.db.batch(allDbOps)
    phaseLog("done")

    // Batch evict receipt/tx caches once per block instead of per-tx
    this.evm.evictCaches()

    } catch (err) {
      // Revert both EVM stateManager and state trie on failure.
      // The trie overlay ensures no partial writes reach LevelDB.
      // EVM revert drains all checkpoint levels (including runTx internals).
      try { await this.evm.revertState() } catch { /* no checkpoint to revert */ }
      if (this.stateTrie) {
        try { await this.stateTrie.revert() } catch { /* no checkpoint to revert */ }
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
    if (!incomingTip) {
      log.warn("snap block import rejected: empty block list")
      return false
    }

    const currentHeight = await this.getHeight()
    if (BigInt(incomingTip.number) <= currentHeight) {
      log.warn("snap block import rejected: incoming tip not ahead", {
        incomingTip: String(incomingTip.number),
        currentHeight: currentHeight.toString(),
      })
      return false
    }
    const snapshotStartHeight = BigInt(blocks[0].number)
    // Phase H14: previously rejected the entire import when the snapshot
    // window overlapped local chain. That was correct for cold-start snap-
    // sync (avoid overwriting hash-index residue) but wrong for divergence
    // recovery: the chain-snapshot RPC returns last N blocks (e.g., 100),
    // so the start always overlaps a healthy local chain. After state was
    // already imported successfully, rejecting block import left the node
    // with imported state at peer's tip but local chain head still behind
    // — chain.getHeight() unchanged, so the next block proposal stalls
    // (observed 2026-05-01 02:59 UTC stall — H4/H11/H13 chain fired
    // perfectly but adoption returned false here).
    //
    // Fix: filter blocks to only those AHEAD of currentHeight and import
    // the trimmed list. Blocks at or below currentHeight are already in
    // the chain index (or they're the divergent suffix we'll keep — see
    // verifyBlockChain below; the new chain history is the imported peer
    // version going forward).
    let importBlocks = blocks
    if (snapshotStartHeight <= currentHeight) {
      importBlocks = blocks.filter((b) => BigInt(b.number) > currentHeight)
      if (importBlocks.length === 0) {
        log.warn("snap block import: snapshot window fully behind local chain", {
          snapshotStart: snapshotStartHeight.toString(),
          snapshotEnd: String(incomingTip.number),
          currentHeight: currentHeight.toString(),
        })
        return false
      }
      log.info("snap block import: trimmed overlapping window", {
        originalStart: snapshotStartHeight.toString(),
        trimmedStart: importBlocks[0].number.toString(),
        snapshotEnd: String(incomingTip.number),
        currentHeight: currentHeight.toString(),
        trimmedCount: importBlocks.length,
      })
    }

    // Verify internal chain integrity (hashes, parent links); skip proposer
    // check because historical blocks may reference validators no longer active
    if (!this.verifyBlockChain(importBlocks, true)) {
      log.warn("snap block import rejected: verifyBlockChain failed", {
        snapshotStart: importBlocks[0].number.toString(),
        snapshotEnd: String(incomingTip.number),
        blockCount: importBlocks.length,
      })
      return false
    }

    // Write blocks directly to block index — no tx re-execution needed.
    // Recompute depth-finality locally; never trust remote finalized/bftFinalized flags.
    const depth = BigInt(Math.max(1, this.cfg.finalityDepth))
    const tipHeight = BigInt(incomingTip.number)
    for (const block of importBlocks) {
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
    log.info("snap block import succeeded", {
      snapshotStart: importBlocks[0].number.toString(),
      snapshotEnd: String(incomingTip.number),
      blockCount: importBlocks.length,
    })
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
        log.warn("verifyBlockChain failed: hash mismatch", {
          index: i,
          number: String(block.number),
          expectedHash,
          actualHash: block.hash,
        })
        return false
      }
      if (i === 0) {
        if (BigInt(block.number) === 1n && block.parentHash !== zeroHash()) {
          log.warn("verifyBlockChain failed: bad genesis parent hash", {
            index: i,
            number: String(block.number),
            parentHash: block.parentHash,
          })
          return false
        }
      } else {
        const prev = blocks[i - 1]
        if (block.parentHash !== prev.hash) {
          log.warn("verifyBlockChain failed: parent hash discontinuity", {
            index: i,
            number: String(block.number),
            parentHash: block.parentHash,
            prevHash: prev.hash,
          })
          return false
        }
        if (BigInt(block.number) !== BigInt(prev.number) + 1n) {
          log.warn("verifyBlockChain failed: block number discontinuity", {
            index: i,
            number: String(block.number),
            prevNumber: String(prev.number),
          })
          return false
        }
        // Verify timestamps are monotonically increasing
        if (Number(block.timestampMs) <= Number(prev.timestampMs)) {
          log.warn("verifyBlockChain failed: non-monotonic timestamp", {
            index: i,
            number: String(block.number),
            timestampMs: Number(block.timestampMs),
            prevTimestampMs: Number(prev.timestampMs),
          })
          return false
        }
      }

      const prev = i > 0 ? blocks[i - 1] : undefined
      if (!this.hasValidSnapshotWeight(prev, block)) {
        log.warn("verifyBlockChain failed: invalid snapshot cumulative weight", {
          index: i,
          number: String(block.number),
          cumulativeWeight: block.cumulativeWeight !== undefined ? String(block.cumulativeWeight) : "undefined",
          prevCumulativeWeight: prev?.cumulativeWeight !== undefined ? String(prev.cumulativeWeight) : "undefined",
        })
        return false
      }

      // Verify proposer is in validator set (skip for SnapSync — historical validators may differ)
      if (!skipProposerCheck && validators.length > 0 && !validators.includes(block.proposer)) {
        log.warn("verifyBlockChain failed: proposer not in validator set", {
          index: i,
          number: String(block.number),
          proposer: block.proposer,
        })
        return false
      }

      // Verify proposer signature if verifier available
      if (this.signatureVerifier && block.signature) {
        const canonical = `block:${block.hash}`
        if (!this.signatureVerifier.verifyNodeSig(canonical, block.signature, block.proposer)) {
          log.warn("verifyBlockChain failed: invalid proposer signature", {
            index: i,
            number: String(block.number),
            proposer: block.proposer,
          })
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
    const blockWeight = block.cumulativeWeight !== undefined ? BigInt(block.cumulativeWeight) : undefined
    const prevWeight = prev?.cumulativeWeight !== undefined ? BigInt(prev.cumulativeWeight) : undefined

    if (blockWeight === undefined) {
      return prevWeight === undefined
    }

    if (!this.governance) {
      return blockWeight === BigInt(block.number)
    }

    if (prevWeight === undefined) {
      return blockWeight > 0n
    }

    return blockWeight > prevWeight
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
