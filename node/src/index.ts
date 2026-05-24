import { keccak256, parseEther } from "ethers"
import { appendFileSync, existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { loadNodeConfig } from "./config.ts"
import { startRpcServer } from "./rpc.ts"
import { EvmChain } from "./evm.ts"
import { PoSeEngine } from "./pose-engine.ts"
import { ChainEngine } from "./chain-engine.ts"
import { PersistentChainEngine } from "./chain-engine-persistent.ts"
import type { IChainEngine } from "./chain-engine-types.ts"
import type { ChainBlock } from "./blockchain-types.ts"
import { hasGovernance } from "./chain-engine-types.ts"
import { P2PNode, buildSignedGetAuth } from "./p2p.ts"
import type { BftMessagePayload, BftEvidencePayload } from "./p2p.ts"
import { ConsensusEngine } from "./consensus.ts"
import type { SnapSyncProvider } from "./consensus.ts"
import { IpfsBlockstore, cidMatchesBytes } from "./ipfs-blockstore.ts"
import { UnixFsBuilder } from "./ipfs-unixfs.ts"
import { IpfsHttpServer } from "./ipfs-http.ts"
import { createNodeSigner } from "./crypto/signer.ts"
import { PersistentPoseAuthNonceTracker } from "./pose-http.ts"
import { createPoseChallengerAuthorizer } from "./pose-authorizer.ts"
import { createOnchainOperatorResolver } from "./pose-onchain-authorizer.ts"
import { migrateLegacySnapshot } from "./storage/migrate-legacy.ts"
import { startWsRpcServer } from "./websocket-rpc.ts"
import { handleRpcMethod } from "./rpc.ts"
import { ChainEventEmitter } from "./chain-events.ts"
import { createLogger } from "./logger.ts"
import { LevelDatabase } from "./storage/db.ts"
import { PersistentStateTrie } from "./storage/state-trie.ts"
import { PersistentStateManager } from "./storage/persistent-state-manager.ts"
import { NonceRegistry } from "../../services/verifier/nonce-registry.ts"
import { EvidenceStore } from "../../runtime/lib/evidence-store.ts"
import type { EquivocationEvidence } from "./bft.ts"
import { IpfsMfs } from "./ipfs-mfs.ts"
import { IpfsPubsub } from "./ipfs-pubsub.ts"
import type { PubsubMessage } from "./ipfs-pubsub.ts"
import { BftCoordinator, bftCanonicalMessage } from "./bft-coordinator.ts"
import type { BftMessage } from "./bft.ts"
import { WireServer } from "./wire-server.ts"
import { WireClient } from "./wire-client.ts"
import { MessageType, encodeJsonPayload } from "./wire-protocol.ts"
import { DhtNetwork } from "./dht-network.ts"
import { buildCocIpfsWiring } from "./coc-ipfs-wiring.ts"
import { IpfsRepairLoop } from "./coc-ipfs-repair.ts"
import { exportStateSnapshot, importStateSnapshot } from "./state-snapshot.ts"
import type { StateSnapshot } from "./state-snapshot.ts"
import type { IStateTrie } from "./storage/state-trie.ts"
import { startMetricsServer } from "./metrics-server.ts"
import { metrics } from "./metrics.ts"
import { BftSlashingHandler } from "./bft-slashing.ts"
import { EvidenceReason } from "../../services/verifier/anti-cheat-policy.ts"
import { hashSlashEvidencePayload, resolveEvidencePaths } from "../../services/common/slash-evidence.ts"
import { ValidatorRegistryReader } from "../../runtime/lib/validator-registry-reader.ts"
import type { ValidatorEntry } from "../../runtime/lib/validator-registry-reader.ts"

const log = createLogger("node")

const config = await loadNodeConfig()

const prefund = (config.prefund || []).map((entry) => ({
  address: entry.address,
  balanceWei: parseEther(entry.balanceCoc ?? entry.balanceEth ?? "0").toString(),
}))

const usePersistent = config.storage.backend === "leveldb"

// Auto-migrate legacy chain.json if switching to persistent backend
if (usePersistent) {
  const migration = await migrateLegacySnapshot(config.dataDir)
  if (migration.blocksImported > 0) {
    log.info("legacy migration complete", {
      blocks: migration.blocksImported,
      nonces: migration.noncesMarked,
    })
  }
}

let chain: IChainEngine
let evm: EvmChain
let stateTrie: IStateTrie | null = null
let stateDb: LevelDatabase | null = null

if (usePersistent) {
  // Create persistent state trie backed by LevelDB
  stateDb = new LevelDatabase(config.dataDir, "state")
  await stateDb.open()
  const trie = new PersistentStateTrie(stateDb)
  await trie.init()
  stateTrie = trie

  // Create state manager adapter and pass to EVM
  const stateManager = new PersistentStateManager(trie)
  evm = await EvmChain.create(config.chainId, stateManager, {
    hardfork: config.hardfork,
    hardforkSchedule: config.hardforkSchedule,
  })

  const persistentEngine = new PersistentChainEngine(
    {
      dataDir: config.dataDir,
      nodeId: config.nodeId,
      chainId: config.chainId,
      validators: config.validators,
      finalityDepth: config.finalityDepth,
      maxTxPerBlock: config.maxTxPerBlock,
      minGasPriceWei: BigInt(config.minGasPriceWei),
      signatureEnforcement: config.signatureEnforcement,
      prefundAccounts: prefund,
      stateTrie: trie,
      enableGovernance: config.enableGovernance,
      validatorStakes: config.validatorStakes.map((v) => ({ ...v, stake: BigInt(v.stake) })),
      enableBlockReward: config.enableBlockReward,
      blockRewardWei: BigInt(config.blockRewardWei),
      blockRewardHalvingInterval: BigInt(config.blockRewardHalvingIntervalBlocks),
      enableFeeDistribution: config.enableFeeDistribution,
    },
    evm,
  )
  await persistentEngine.init()
  chain = persistentEngine

  // Configure pruner based on nodeMode
  if (persistentEngine.blockIndex) {
    const retentionBlocks = config.nodeMode === "archive" ? Infinity
      : config.nodeMode === "light" ? 128 : 10_000
    const prunerCfg = {
      retentionBlocks,
      enableAutoPrune: config.nodeMode !== "archive" && config.storage.enablePruning,
    }
    log.info("pruner config", { nodeMode: config.nodeMode, retentionBlocks: prunerCfg.retentionBlocks })
  }

  log.info("using persistent storage backend (LevelDB) with EVM state persistence")
} else {
  evm = await EvmChain.create(config.chainId, undefined, {
    hardfork: config.hardfork,
    hardforkSchedule: config.hardforkSchedule,
  })
  await evm.prefund(prefund)
  const memoryEngine = new ChainEngine(
    {
      dataDir: config.dataDir,
      nodeId: config.nodeId,
      chainId: config.chainId,
      validators: config.validators,
      finalityDepth: config.finalityDepth,
      maxTxPerBlock: config.maxTxPerBlock,
      minGasPriceWei: BigInt(config.minGasPriceWei),
      signatureEnforcement: config.signatureEnforcement,
      enableGovernance: config.enableGovernance,
      validatorStakes: config.validatorStakes.map((v) => ({ ...v, stake: BigInt(v.stake) })),
    },
    evm,
  )
  await memoryEngine.init()
  chain = memoryEngine
  log.info("using memory storage backend")
}

// Persistent poison store — survives process restart. Work-slot-failed
// triggers process.exit(1) to force a fresh BFT state, but without
// reloading this set gossip would re-deliver the same hung tx and we
// would crash-loop. Path lives under dataDir so multi-node deployments
// get independent stores per node.
const poisonStorePath = join(config.dataDir, "poisoned-txs.txt")
if (existsSync(poisonStorePath)) {
  try {
    const hashes = readFileSync(poisonStorePath, "utf-8")
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.length === 66 && l.startsWith("0x"))
      .map((l) => l.toLowerCase() as Hex)
    chain.mempool.loadPoisonedHashes(hashes)
    log.info("mempool poison set loaded", { count: hashes.length, path: poisonStorePath })
  } catch (err) {
    log.warn("mempool poison set load failed", { error: String(err) })
  }
}

// Node identity signer — created early so Wire/BFT/PoSe all share the same key.
// loadNodeConfig resolves COC_NODE_KEY/COC_NODE_PK, persisted node-key, or a new key.
const nodePrivateKey = config.nodePrivateKey
const nodeSigner = createNodeSigner(nodePrivateKey)

// Attach signer to chain engine for block proposer signatures
if (typeof (chain as PersistentChainEngine).setNodeSigner === "function") {
  (chain as PersistentChainEngine).setNodeSigner(nodeSigner, nodeSigner)
} else if (typeof (chain as ChainEngine).setNodeSigner === "function") {
  (chain as ChainEngine).setNodeSigner(nodeSigner, nodeSigner)
}

// Build validator address map for identity alignment (nodeId → ETH address)
if (config.validatorAddresses) {
  const addrMap = new Map<string, string>(Object.entries(config.validatorAddresses))
  if (typeof (chain as PersistentChainEngine).setValidatorAddressMap === "function") {
    (chain as PersistentChainEngine).setValidatorAddressMap(addrMap)
  } else if (typeof (chain as ChainEngine).setValidatorAddressMap === "function") {
    (chain as ChainEngine).setValidatorAddressMap(addrMap)
  }
  log.info("validator address map loaded", { entries: addrMap.size })
}

// BFT coordinator setup
let bftCoordinator: BftCoordinator | undefined

// Phase H4: rate-limit immediate snap-sync triggered by BFT peer-quorum
// divergence so a divergence storm doesn't spawn parallel sync attempts.
// Module-scope so the cooldown survives across BftCoordinator callbacks.
let lastPeerDivergenceSyncMs = 0
const PEER_DIVERGENCE_SYNC_COOLDOWN_MS = 60_000

// Phase H5: rate-limit forced state-snapshot import (the "manual rsync"
// equivalent). Much longer cooldown than H4 — escalation should NOT happen
// often and a misfiring recovery loop overwriting state would be worse than
// just letting the chain stay stuck for human intervention.
let lastForceSnapSyncMs = 0
const FORCE_SNAP_SYNC_COOLDOWN_MS = 15 * 60 * 1000
const bftEnabled = config.enableBft && config.validators.length >= 3

// State snapshot export cache (30s TTL, keyed by tip hash)
let cachedStateSnapshot: { snapshot: StateSnapshot; tipHash: Hex; cachedAtMs: number } | null = null
const STATE_SNAPSHOT_CACHE_TTL_MS = 30_000

// #622 (issue #620): forward-declared so the p2p `onBftEvidence` handler
// (created at p2p init, BEFORE the bft init block runs) can dispatch into
// the shared equivocation-processing path. The bft init block (later)
// assigns the actual implementation. When BFT is disabled or the init
// hasn't run yet, this stays null and `onBftEvidence` drops inbound
// evidence as a no-op.
let handleEquivocationEvidence: ((ev: EquivocationEvidence) => void) | null = null

const p2p = new P2PNode(
  {
    bind: config.p2pBind,
    port: config.p2pPort,
    peers: config.peers,
    nodeId: config.nodeId,
    advertisedUrl: config.advertisedP2pUrl,
    maxPeers: config.p2pMaxPeers,
    enableDiscovery: true,
    peerStorePath: config.peerStorePath,
    dnsSeeds: config.dnsSeeds,
    peerMaxAgeMs: config.peerMaxAgeMs,
    maxDiscoveredPerBatch: config.p2pMaxDiscoveredPerBatch,
    inboundRateLimitWindowMs: config.p2pRateLimitWindowMs,
    inboundRateLimitMaxRequests: config.p2pRateLimitMaxRequests,
    inboundAuthMode: config.p2pInboundAuthMode,
    enableInboundAuth: config.p2pRequireInboundAuth,
    authMaxClockSkewMs: config.p2pAuthMaxClockSkewMs,
    authNonceRegistryPath: config.p2pAuthNonceRegistryPath,
    authNonceTtlMs: config.p2pAuthNonceTtlMs,
    authNonceMaxEntries: config.p2pAuthNonceMaxEntries,
    signer: nodeSigner,
    verifier: nodeSigner,
  },
  {
    onTx: async (rawTx) => {
      try {
        await chain.addRawTx(rawTx)
        // Relay to wire-connected peers (if wire protocol enabled)
        wireTxRelayFn?.(rawTx)
      } catch {
        // ignore duplicate or invalid gossip tx
      }
    },
    onBlock: async (block) => {
      // When BFT is enabled, defer block execution to onFinalized to prevent
      // EVM state pollution from speculative gossip-path execution. The BFT
      // coordinator only needs block metadata for voting, not executed state.
      if (!bftCoordinator) {
        try {
          await chain.applyBlock(block)
        } catch {
          // ignore invalid/duplicate blocks from peers
        }
      } else {
        // Pre-remove the block's transactions from mempool so the next proposer
        // doesn't re-include them (mempool desync prevention).
        if (block.txs.length > 0) {
          for (const rawTx of block.txs) {
            try {
              chain.mempool.remove(keccak256(rawTx) as Hex)
            } catch { /* ignore */ }
          }
        }
      }
      // Non-proposer nodes: join BFT round for blocks received via gossip
      if (bftCoordinator) {
        try {
          await bftCoordinator.handleReceivedBlock(block)
        } catch {
          // ignore if round already active or block invalid
        }
      }
    },
    onSnapshotRequest: async () => {
      // In-memory engine has makeSnapshot()
      const snapshotEngine = chain as ChainEngine
      if (typeof snapshotEngine.makeSnapshot === "function") {
        return snapshotEngine.makeSnapshot()
      }
      // Persistent engine: return recent blocks only (cap to prevent DoS).
      // NOTE: nodes that fall behind by more than this window cannot block-sync;
      // consensus.trySync() detects the gap and falls back to SnapSync when enabled.
      const MAX_SNAPSHOT_BLOCKS = 1000
      const height = await chain.getHeight()
      if (height === 0n) return { blocks: [], updatedAtMs: Date.now() }
      const startBlock = height > BigInt(MAX_SNAPSHOT_BLOCKS) ? height - BigInt(MAX_SNAPSHOT_BLOCKS) + 1n : 1n
      const blocks: ChainBlock[] = []
      for (let i = startBlock; i <= height; i++) {
        const block = await chain.getBlockByNumber(i)
        if (block) blocks.push(block)
      }
      return { blocks, updatedAtMs: Date.now() }
    },
    onBftMessage: bftEnabled
      ? async (msg: BftMessagePayload) => {
        if (!bftCoordinator) return
        const bftMsg: BftMessage = {
          type: msg.type,
          height: BigInt(msg.height),
          blockHash: msg.blockHash,
          senderId: msg.senderId,
          signature: (msg.signature ?? "") as Hex,
        }
        // Propagate stateRoot (part of BFT quorum on (hash, stateRoot)).
        if (msg.stateRoot) bftMsg.stateRoot = msg.stateRoot
        await bftCoordinator.handleMessage(bftMsg)
      }
      : undefined,
    // #622 (issue #620): receive equivocation evidence from peers, verify
    // signatures, dedup, import into the local detector. When import
    // succeeds (status "imported"), the local `onEquivocation` callback
    // fires — applying the slash, persisting for relayer pickup, AND
    // re-gossiping to peers. The receiver re-broadcast is what makes the
    // network converge in ~one gossip round even when the original
    // witness only reached a subset of peers.
    onBftEvidence: bftEnabled
      ? async (msg: BftEvidencePayload) => {
        if (!bftCoordinator) return
        const ev: EquivocationEvidence = {
          validatorId: msg.validatorId,
          height: BigInt(msg.height),
          phase: msg.phase,
          blockHash1: msg.blockHash1,
          blockHash2: msg.blockHash2,
          detectedAtMs: msg.detectedAtMs,
          signature1: msg.signature1 as Hex,
          signature2: msg.signature2 as Hex,
        }
        const result = bftCoordinator.equivocationDetector.importEvidence(
          ev,
          bftCanonicalMessage,
          (canonical, signature, expectedAddress) =>
            nodeSigner.verifyNodeSig(canonical, signature, expectedAddress),
        )
        if (result === "imported") {
          // Fire the same downstream path as locally-detected equivocation:
          // local slash + relayer pickup + RE-GOSSIP. Imports converge the
          // network on the same evidence set in O(log N) gossip rounds.
          handleEquivocationEvidence?.(ev)
        } else if (result === "invalid") {
          log.warn("rejected bogus BFT evidence from peer", {
            validator: msg.validatorId,
            height: msg.height,
            phase: msg.phase,
          })
        }
        // "duplicate" → silent drop (expected during gossip steady-state)
      }
      : undefined,
    onStateSnapshotRequest: (stateTrie && config.enableSnapSync)
      ? async () => {
        const tip = await Promise.resolve(chain.getTip())
        const height = await Promise.resolve(chain.getHeight())
        if (!tip || !stateTrie) return null
        // Return cached snapshot if tip unchanged and TTL fresh
        if (
          cachedStateSnapshot &&
          cachedStateSnapshot.tipHash === tip.hash &&
          Date.now() - cachedStateSnapshot.cachedAtMs < STATE_SNAPSHOT_CACHE_TTL_MS
        ) {
          return cachedStateSnapshot.snapshot
        }
        // Export full state (all accounts + storage) + governance validators for snap sync
        const validators = hasGovernance(chain)
          ? chain.governance.getActiveValidators().map((v) => ({ id: v.id, address: v.address, stake: v.stake, active: v.active }))
          : undefined
        const exported = await exportStateSnapshot(stateTrie, undefined, height, tip.hash, validators)
        cachedStateSnapshot = { snapshot: exported, tipHash: tip.hash, cachedAtMs: Date.now() }
        return exported
      }
      : undefined,
  },
)
p2p.start()

// PR-1G (2026-05-11): verify the persistent-engine local tip against peer
// snapshots before consensus joins any BFT round. The T4 dual-stop drill
// surfaced a failure mode where a validator that propose-then-stops can
// leave a self-finalized phantom block in leveldb; PR-1D's
// repairLatestPointer then promotes that phantom to LATEST on restart, and
// Phase R's self-equivocation guard refuses to re-prepare a different hash
// at the same height — deadlocking the cluster cluster-wide.
//
// This check runs once on startup. We give peers ~6 s to complete wire
// handshakes (so /p2p/chain-snapshot has a chance of succeeding), then ask
// peers for their tips. If peer-quorum disagrees with our LATEST, we
// demote LATEST backward to the deepest peer-confirmed height. Set
// `COC_PR1G_DISABLE=1` to bypass (escape hatch for operators in case of a
// pathological peer set). Set `COC_PR1G_PRUNE=1` to additionally drop
// stale b:N / h:hash rows above the demoted height.
{
  const persistentChain = chain as PersistentChainEngine
  const hasVerify = typeof persistentChain.verifyAndPromoteTipWithPeers === "function"
  const hasPeers = (config.peers?.length ?? 0) > 0
  if (process.env.COC_PR1G_DISABLE === "1") {
    log.warn("PR-1G: disabled via COC_PR1G_DISABLE=1 — skipping tip verification")
  } else if (hasVerify && hasPeers) {
    const PR1G_PEER_WAIT_MS = Number(process.env.COC_PR1G_WAIT_MS ?? 6000)
    await new Promise((resolve) => setTimeout(resolve, PR1G_PEER_WAIT_MS))
    try {
      const result = await persistentChain.verifyAndPromoteTipWithPeers(p2p, {
        quorumFraction: Number(process.env.COC_PR1G_QUORUM_FRACTION ?? 0.5),
        prune: process.env.COC_PR1G_PRUNE === "1",
      })
      log.info("PR-1G: tip verification complete", {
        verified: result.verified,
        demoted: result.demoted,
        from: result.demotedFrom?.toString() ?? "<none>",
        to: result.demotedTo?.toString() ?? "<none>",
        reason: result.reason,
        peerCount: result.peerCount,
        pruned: result.prunedCount ?? 0,
      })
    } catch (err) {
      log.warn("PR-1G: tip verification threw — proceeding with current LATEST", {
        error: String(err),
      })
    }
  } else if (hasVerify && !hasPeers) {
    log.info("PR-1G: skipped — no peers configured (single-node bootstrap)")
  }
}

// BFT equivocation evidence store — persists slash evidence for relayer consumption
const bftEvidenceStore = new EvidenceStore(1000, resolveEvidencePaths(config.dataDir).writePath)

// BFT slashing handler — applies immediate governance penalties on equivocation
const bftSlashingHandler = hasGovernance(chain)
  ? new BftSlashingHandler(chain.governance, { slashPercent: 10, autoRemove: true })
  : null

// Initialize BFT coordinator after P2P is ready
if (bftEnabled) {
  // Default validators come from hardcoded config. When
  // validatorRegistryAddress is set (Sprint 4 of Phase F+G), the
  // ValidatorRegistryReader below replaces this initial set with the
  // contract's active set and keeps it in sync via add/remove events.
  // Phase X1 (2026-05-06): when `validatorStakes` is configured, use it to
  // give per-validator stake weights to BftCoordinator. Without this, all
  // validators have an equal 1 ETH default and a 4-external + 3-core cluster
  // can't quorum without the cores. Per-validator stakes let us weight the
  // 4 externals at 200 ETH and the 3 cores at 100 ETH so that 4/4 externals
  // = 800 ETH > quorum threshold (1100 × 2 / 3 = 733) — the chain can
  // continue if all cores are stopped.
  const stakeOverride = new Map<string, bigint>()
  for (const v of config.validatorStakes) {
    if (v.address) stakeOverride.set(v.address.toLowerCase(), BigInt(v.stake))
  }
  const validators = config.validators.map((id) => ({
    id,
    stake: stakeOverride.get(id.toLowerCase()) ?? 1_000_000_000_000_000_000n,
  }))

  // Serialization queue for onFinalized — prevents re-entrant applyBlock
  // when BFT finalizes consecutive blocks within milliseconds.
  let onFinalizedQueue = Promise.resolve()

  // Phase H2 Track B: relaxedQuorum dev flag. When set, BFT quorum drops
  // the strict `+1 wei` requirement so a 3-validator equal-stake cluster
  // reaches quorum at 2-of-3 instead of 3-of-3. Loses Byzantine safety;
  // ONLY for testnet/devnet where the cluster has known
  // divergent-but-non-malicious validators (e.g. 2026-04-30 testnet's
  // node-1 shadow state corruption). Production deployments must NOT
  // set this env var.
  const relaxedQuorum = process.env.COC_DEV_RELAXED_QUORUM === "1"
  if (relaxedQuorum) {
    log.warn(
      "⚠ COC_DEV_RELAXED_QUORUM=1 — BFT quorum threshold relaxed; Byzantine safety LOST",
      { validators: config.validators.length, chainId: config.chainId },
    )
  }

  // #622 (issue #620): factored out of `onEquivocation` so peer-imported
  // evidence flows through the SAME local-slash + relayer + re-gossip path
  // as locally-detected evidence. Assigned to the file-scoped forward-
  // declared `handleEquivocationEvidence` so the p2p `onBftEvidence`
  // handler (initialized earlier) can dispatch into it.
  handleEquivocationEvidence = (evidence: EquivocationEvidence) => {
    log.warn("BFT equivocation detected", {
      validator: evidence.validatorId,
      height: evidence.height.toString(),
      phase: evidence.phase,
      hash1: evidence.blockHash1,
      hash2: evidence.blockHash2,
    })

    // Apply immediate governance slash penalty
    if (bftSlashingHandler) {
      const slashEvent = bftSlashingHandler.handleEquivocation(evidence)
      if (slashEvent) {
        log.warn("BFT equivocation slash applied", {
          validatorId: slashEvent.validatorId,
          slashedAmount: slashEvent.slashedAmount.toString(),
          remaining: slashEvent.remainingStake.toString(),
          removed: slashEvent.removed,
        })
      }
    }

    // Persist as SlashEvidence for relayer pickup
    const nodeIdHex = evidence.validatorId.startsWith("0x")
      ? evidence.validatorId.padEnd(66, "0")
      : `0x${evidence.validatorId.padStart(64, "0")}`
    const rawEvidence: Record<string, unknown> = {
      type: "bft-equivocation",
      nodeId: nodeIdHex,
      validatorId: evidence.validatorId,
      height: evidence.height.toString(),
      phase: evidence.phase,
      blockHash1: evidence.blockHash1,
      blockHash2: evidence.blockHash2,
      detectedAtMs: evidence.detectedAtMs,
      // #725: carry the two BFT signatures through to the evidence store /
      // coc_getEquivocations RPC / relayer. Without them the relayer's
      // on-chain EquivocationDetector submission path always trips its
      // missing-signatures guard and the permissionless slashing layer
      // never runs.
      ...(evidence.signature1 ? { signature1: evidence.signature1 } : {}),
      ...(evidence.signature2 ? { signature2: evidence.signature2 } : {}),
    }
    bftEvidenceStore.push({
      nodeId: nodeIdHex as `0x${string}`,
      reasonCode: EvidenceReason.BftEquivocation,
      evidenceHash: hashSlashEvidencePayload(nodeIdHex as `0x${string}`, rawEvidence),
      rawEvidence,
    })

    // #622: gossip evidence to peers so the equivocation history converges
    // across the network. Without this, only the node that directly
    // witnessed both conflicting votes can detect the equivocation; nodes
    // that received only one vote stay unaware, making slashing
    // inconsistent and on-chain reporting depend on a single relayer
    // happening to run alongside the witness. Signatures are mandatory
    // on the wire — pre-PR-I3b paths can produce sig-less evidence, skip
    // those (peers have nothing to verify against).
    if (evidence.signature1 && evidence.signature2) {
      const broadcastPayload: BftEvidencePayload = {
        validatorId: evidence.validatorId,
        height: evidence.height.toString(),
        phase: evidence.phase,
        blockHash1: evidence.blockHash1,
        blockHash2: evidence.blockHash2,
        signature1: evidence.signature1,
        signature2: evidence.signature2,
        detectedAtMs: evidence.detectedAtMs,
      }
      p2p.broadcastBftEvidence(broadcastPayload).catch((err) => {
        log.warn("broadcastBftEvidence failed", {
          validator: evidence.validatorId,
          height: evidence.height.toString(),
          error: String(err),
        })
      })
    }
  }

  bftCoordinator = new BftCoordinator({
    localId: config.nodeId,
    validators,
    prepareTimeoutMs: config.bftPrepareTimeoutMs,
    commitTimeoutMs: config.bftCommitTimeoutMs,
    signer: nodeSigner,
    verifier: nodeSigner,
    relaxedQuorum,
    // Issue #73: gate startRound + processDeferredBlock against stale
    // proposals (height ≤ chain tip). `lastFinalizedHeight` alone misses
    // gossip-block catch-up after a restart; this closes the gap.
    getChainHeight: () => chain.getHeight(),
    // PR-1A (2026-05-10): when a BFT round times out at a peer's slot, mark
    // that proposer unreachable so consensus.checkNoProgressWatchdog's fast
    // path (~15s) takes over from the conservative 600s H15 timeout.
    onProposerStuck: (proposerId: string, height: bigint) => {
      if (!consensus) return
      log.warn("PR-1A: BFT round timed out — marking proposer unreachable", {
        proposerId,
        height: height.toString(),
      })
      consensus.markProposerUnreachable(proposerId)
    },
    onEquivocation: (evidence: EquivocationEvidence) => handleEquivocationEvidence?.(evidence),
    broadcastMessage: async (msg: BftMessage) => {
      const payload: BftMessagePayload = {
        type: msg.type as "prepare" | "commit",
        height: msg.height.toString(),
        blockHash: msg.blockHash,
        senderId: msg.senderId,
        signature: msg.signature,
      }
      if (msg.stateRoot) payload.stateRoot = msg.stateRoot
      await p2p.broadcastBft(payload)
      // Also broadcast BFT messages via wire protocol (dual transport)
      wireBftBroadcastFn?.(msg)
    },
    // Speculatively execute `block` against current state and return the
    // post-execution stateRoot that this node would commit to — lets BFT
    // quorum require agreement on (blockHash, stateRoot) instead of hash
    // alone. If chain engine doesn't support speculative execution, return
    // undefined and BFT falls back to hash-only quorum.
    computeLocalStateRoot: async (block: ChainBlock) => {
      const engine = chain as unknown as { speculativelyComputeStateRoot?: (b: ChainBlock) => Promise<Hex | undefined> }
      if (!engine.speculativelyComputeStateRoot) return undefined
      return engine.speculativelyComputeStateRoot(block)
    },
    onFinalized: (block) => {
      // Queue onFinalized calls to prevent re-entrant applyBlock.
      // BFT can finalize consecutive blocks within milliseconds when buffered
      // messages cause immediate finalization of deferred blocks.
      const work = async () => {
      // Always remove finalized block's transactions from mempool, even before
      // applyBlock succeeds. This prevents other proposers from re-including
      // already-confirmed transactions in subsequent blocks (mempool desync).
      if (block.txs.length > 0) {
        for (const rawTx of block.txs) {
          try {
            const txHash = keccak256(rawTx)
            chain.mempool.remove(txHash as Hex)
          } catch { /* best-effort */ }
        }
      }

      const finalizedBlock = { ...block, bftFinalized: true }
      // Guard against applyBlock hanging (observed: node-1/node-2 stuck
      // 10+ min in "BFT round finalized" with no "BFT finalized block" log,
      // no error, and an indefinitely pending onFinalizedQueue that blocked
      // every subsequent BFT round). A hard timeout converts the hang into
      // a surfaced error so the queue can progress and trySync can recover.
      const applyTimeoutMs = 30_000
      const applyWithTimeout = async (retry: boolean) => {
        let timer: NodeJS.Timeout | undefined
        const timeout = new Promise<never>((_, rej) => {
          timer = setTimeout(
            () => rej(new Error(`applyBlock timeout ${applyTimeoutMs}ms${retry ? " (retry)" : ""}`)),
            applyTimeoutMs,
          )
        })
        try {
          log.info("BFT onFinalized: applyBlock begin", { height: block.number.toString(), retry })
          await Promise.race([chain.applyBlock(finalizedBlock, true), timeout])
          log.info("BFT onFinalized: applyBlock end", { height: block.number.toString(), retry })
        } finally {
          if (timer) clearTimeout(timer)
        }
      }
      try {
        await applyWithTimeout(false)
      } catch (applyErr) {
        // block may already be applied during propose — persist bftFinalized flag
        const persistentEngine = chain as { blockIndex?: { getBlockByHash(h: string): Promise<ChainBlock | null>; updateBlock(b: ChainBlock): Promise<void> } }
        if (persistentEngine.blockIndex) {
          try {
            const existing = await persistentEngine.blockIndex.getBlockByHash(block.hash)
            if (existing && !existing.bftFinalized) {
              const updated = { ...existing, bftFinalized: true }
              await persistentEngine.blockIndex.updateBlock(updated)
            } else if (!existing) {
              // Block was NOT previously applied — this is a real failure, not a duplicate.
              // Block not found locally — likely gossip applyBlock failed but
              // EVM/trie state was atomically reverted (via overlay buffering).
              // Retry after a short delay to let gossip settle.
              log.warn("BFT onFinalized: block not found locally, retrying apply", {
                height: block.number.toString(),
                hash: block.hash,
                error: String(applyErr),
              })
              try {
                // With trie overlay protecting LevelDB, a full EVM reset +
                // rebuild from persisted blocks is safe and guarantees clean state.
                // #671: the reset + rebuild mutates the shared state trie
                // (resetExecution recreates the VM; rebuildFromPersisted does
                // setStateRoot / block replay). Unserialized, it raced a
                // concurrent (gossiped) applyBlock and corrupted the trie —
                // run it on the engine's state-exclusive queue. rebuildFrom
                // Persisted already resets the EVM internally, so the explicit
                // resetExecution() is only the height==0 edge.
                const pe = chain as {
                  evm?: { resetExecution?: () => Promise<void> }
                  rebuildFromPersisted?: (h: bigint) => Promise<void>
                  runStateExclusive?: <T>(fn: () => Promise<T>) => Promise<T>
                }
                if (pe.evm?.resetExecution && pe.rebuildFromPersisted && pe.runStateExclusive) {
                  const currentHeight = await Promise.resolve(chain.getHeight())
                  await pe.runStateExclusive(async () => {
                    if (currentHeight > 0n) {
                      await pe.rebuildFromPersisted!(currentHeight)
                    } else {
                      await pe.evm!.resetExecution!()
                    }
                  })
                }
                await applyWithTimeout(true)
                log.info("BFT onFinalized: EVM reset + retry succeeded", { height: block.number.toString() })
              } catch (retryErr) {
                log.error("BFT onFinalized: apply failed after EVM reset — block NOT stored", {
                  height: block.number.toString(),
                  hash: block.hash,
                  error: String(retryErr),
                })
                // Do NOT force-store the block. Force-storing without tx execution
                // causes permanent EVM state divergence (stateRoot mismatch).
                // The block is intentionally left unapplied — the node will be
                // behind by 1+ blocks. Trigger an IMMEDIATE sync attempt so the
                // node catches up from peers instead of waiting for the next
                // syncIntervalMs tick — the interval-based recovery path was
                // observed to leave nodes permanently behind when a single
                // block's apply failed and no further divergence-widening
                // events occurred to nudge it.
                //
                // Phase H11: escalate to forceSnapSync rather than
                // requestSyncNow. requestSyncNow respects the gap-based
                // snap-sync threshold; with the typical post-H10 path of
                // gap=1-3 blocks, it would fall into block-level adoption
                // → applyBlock → H10 throws → infinite retry loop
                // (observed 2026-04-30 22:40 stall). forceSnapSync pulls a
                // full state snapshot from peers, replacing the divergent
                // local state in one shot.
                try {
                  await consensus.forceSnapSync()
                } catch (syncErr) {
                  log.warn("BFT onFinalized: forceSnapSync failed", {
                    error: String(syncErr),
                  })
                }
              }
            }
          } catch {
            // best-effort finality persistence
          }
        }
      }
      // Only broadcast if block exists locally (avoid ghost block relay)
      const localBlock = await Promise.resolve(chain.getBlockByHash(block.hash)).catch(() => null)
      if (localBlock) {
        try {
          await p2p.receiveBlock({ ...localBlock, bftFinalized: true })
        } catch {
          // broadcast best-effort
        }
      }
      log.info("BFT finalized block", { height: block.number.toString(), hash: block.hash })
      // Phase H15: reset the no-progress watchdog baseline on every successful finalize
      consensus?.notifyBftProgress()
      // Sync BFT validator set with governance after each finalized block.
      // PR-1B: route through onValidatorSetChange so consensus also clears
      // its lastProposed cache when membership changes — preventing stale
      // re-broadcast on round timeout against the new rotation.
      if (hasGovernance(chain)) {
        const active = chain.governance.getActiveValidators()
        const next = active.map((v) => ({ id: v.id, stake: v.stake }))
        if (consensus) {
          consensus.onValidatorSetChange(next)
        } else {
          bftCoordinator?.updateValidators(next)
        }
      }
      } // end of work()
      // Wall-clock timeout around the entire work() body. Observed on testnet:
      // after the inner applyBlock timed out, the retry path (EVM reset +
      // rebuildFromPersisted) also hung indefinitely — no "retry succeeded"
      // and no "apply failed" log ever emitted, and every subsequent round
      // stalled behind it. A 75s outer cap (> inner 30s + inner-retry 30s)
      // guarantees the work slot always resolves so the next BFT round can
      // make progress; an unapplied block is recoverable via snap-sync, but
      // an indefinitely-pending promise is not.
      const workTimeoutMs = 75_000
      const workWithTimeout = async () => {
        let timer: NodeJS.Timeout | undefined
        const timeout = new Promise<never>((_, rej) => {
          timer = setTimeout(
            () => rej(new Error(`onFinalized work timeout ${workTimeoutMs}ms`)),
            workTimeoutMs,
          )
        })
        try {
          await Promise.race([work(), timeout])
        } catch (err) {
          log.error("BFT onFinalized: work slot failed", {
            height: block.number.toString(),
            hash: block.hash,
            error: String(err),
          })
          // Poison every tx this block tried to execute: one of them hangs
          // applyBlock (likely @ethereumjs/vm runTx microtask starvation that
          // no Promise.race timer can interrupt from the main thread).
          // Marking them here prevents the mempool and proposer from re-
          // including the same tx into the next block and re-triggering the
          // deadlock every time.
          let poisonedCount = 0
          try {
            const poisoned: string[] = []
            for (const rawTx of block.txs) {
              const txHash = keccak256(rawTx) as Hex
              chain.mempool.poison(txHash)
              poisoned.push(txHash)
            }
            poisonedCount = poisoned.length
            if (poisoned.length > 0) {
              // Persist immediately (sync) so the set survives the imminent
              // process.exit(1). appendFileSync guarantees the write lands
              // before we die; without it a restart would re-enter the same
              // deadlock via gossip re-delivering the poisoned tx.
              try {
                appendFileSync(poisonStorePath, poisoned.join("\n") + "\n")
              } catch (persistErr) {
                log.error("BFT onFinalized: poison persist failed", {
                  error: String(persistErr),
                })
              }
              log.warn("BFT onFinalized: poisoned txs after work slot failure", {
                height: block.number.toString(),
                count: poisoned.length,
                sample: poisoned.slice(0, 5),
              })
            }
          } catch (poisonErr) {
            log.warn("BFT onFinalized: poison failed", { error: String(poisonErr) })
          }
          // The hung applyBlock never reached its finally block, so the
          // re-entrant guard stays pinned true and blocks every future
          // applyBlock call. Force-clear it now that the work slot has
          // been given up on — without this, the chain never recovers
          // even after the poisoned tx is removed.
          try {
            const pe = chain as { resetApplyingFlag?: () => void }
            if (typeof pe.resetApplyingFlag === "function") {
              pe.resetApplyingFlag()
              log.warn("BFT onFinalized: cleared applyingBlock guard", {
                height: block.number.toString(),
              })
            }
          } catch (resetErr) {
            log.warn("BFT onFinalized: reset failed", { error: String(resetErr) })
          }
          // Pre-exit diagnostic dump: full JS + native stack trace, async
          // hook state, heap stats, and libuv handles. This is the only way
          // to localize the upstream @ethereumjs/vm hang — the applyBlock
          // phase marker tells us which tx, but not *where inside runTx*
          // the promise stopped resolving. Report lands under dataDir; a
          // worker follow-up grepping these reports can pinpoint the
          // hanging await/native call across multiple recurrences.
          try {
            const reportPath = join(config.dataDir, `hang-report-${Date.now()}.json`)
            // @ts-ignore — report API exists on Node 22 process at runtime
            process.report?.writeReport?.(reportPath)
            log.error("BFT onFinalized: hang diagnostic dumped", {
              height: block.number.toString(),
              path: reportPath,
            })
          } catch (reportErr) {
            log.warn("BFT onFinalized: report dump failed", { error: String(reportErr) })
          }
          // Also dump the full raw tx bytes so they can be replayed against
          // a stock @ethereumjs/vm in isolation — the hash alone is not
          // enough for offline reproduction, we need the signed payload
          // plus the block context (baseFee, timestamp, parent stateRoot).
          try {
            const txDumpPath = join(config.dataDir, `hang-txs-${Date.now()}.json`)
            const dump = {
              timestamp: Date.now(),
              blockHeight: block.number.toString(),
              blockHash: block.hash,
              parentHash: block.parentHash,
              baseFee: block.baseFee?.toString(),
              timestampMs: block.timestampMs,
              txs: block.txs,
            }
            appendFileSync(txDumpPath, JSON.stringify(dump) + "\n")
            log.error("BFT onFinalized: hang txs dumped", {
              height: block.number.toString(),
              path: txDumpPath,
              txCount: block.txs.length,
            })
          } catch (txDumpErr) {
            log.warn("BFT onFinalized: tx dump failed", { error: String(txDumpErr) })
          }
          // Nuclear recovery: BftCoordinator's lastFinalizedHeight now believes
          // this block is finalized, but the chain engine never applied it, so
          // getTip() is one behind. Every future round at this height gets
          // buffered/rejected by peers (also desynced), producing a soft
          // livelock where prepareVotes never reach quorum. In-process
          // reconciliation is brittle (risks equivocation); exit instead and
          // let docker's restart policy (unless-stopped) rebuild BFT state
          // from scratch. Poisoned tx set is persisted above so gossip can't
          // re-trigger the same hang post-restart.
          log.error("BFT onFinalized: exiting to recover from BFT/chain state desync", {
            height: block.number.toString(),
            poisonedCount,
          })
          setTimeout(() => process.exit(1), 500)
          // Swallow — the queue must keep advancing.
        } finally {
          if (timer) clearTimeout(timer)
        }
      }
      // Chain this work after the prior one completes. Return the CURRENT
      // slot's promise so a hung or slow work() cannot propagate wait time
      // to future callers of onFinalized.
      const prior = onFinalizedQueue
      const current = prior.then(workWithTimeout, workWithTimeout)
      onFinalizedQueue = current
      return current
    },
    onPeerQuorumDiverged: (info): boolean => {
      // Phase H4 + H11: peers reached relaxedQuorum on a (blockHash,
      // stateRoot) pair we couldn't reproduce. They WILL finalize and
      // advance past us; the proposer round-robin will eventually rotate
      // back to this lagging node and the chain will deadlock unless we
      // catch up first.
      //
      // Original H4 (PR #26) called requestSyncNow, which respects the
      // gap-based snap-sync threshold (default 100 blocks). With small
      // gaps (1-3 blocks — the typical relaxedQuorum-diverge case), the
      // path falls into block-level adoption: tries to applyBlock the
      // canonical block. After H10's invariant lands, that apply throws
      // because local computed root != peer claimed root → adoption fails
      // → no recovery. Chain stalls (observed 2026-04-30 22:40 UTC at
      // height 154,358 — H4 fired once, then 3+ hours of silence).
      //
      // H11 fix: escalate directly to forceSnapSync. forceSnapSync
      // bypasses the gap threshold and pulls a full state snapshot from
      // peers — the in-process equivalent of the manual rsync recovery.
      // Cooldown remains 60s so a divergence storm doesn't spawn parallel
      // syncs; H5's longer 15-min cooldown is the secondary safety after
      // 3 consecutive divergences.
      //
      // Phase J1.1 corner-case fix (2026-05-06): the boolean return value
      // signals to the BftCoordinator's per-height dedup whether this
      // fire was actually accepted. Returning false lets J1.1 roll back
      // its dedup so the next prepare at the same height re-fires the
      // gate — closing the stall pattern observed in
      // docs/phase-j-stall-2026-05-06-corner-case.md.
      if (!consensus) return false
      const nowMs = Date.now()
      const sinceLastMs = nowMs - lastPeerDivergenceSyncMs
      if (sinceLastMs < PEER_DIVERGENCE_SYNC_COOLDOWN_MS) {
        log.info("BFT peer-quorum sync skipped (cooldown)", {
          height: info.height.toString(),
          remainingMs: PEER_DIVERGENCE_SYNC_COOLDOWN_MS - sinceLastMs,
        })
        return false
      }
      if (consensus.isSnapSyncInFlight()) {
        log.info("BFT peer-quorum sync skipped — sync already in flight", {
          height: info.height.toString(),
        })
        return false
      }
      lastPeerDivergenceSyncMs = nowMs
      log.warn("BFT peer-quorum divergence — triggering forceSnapSync (H11)", {
        height: info.height.toString(),
        peerBlockHash: info.peerBlockHash,
        peerStateRoot: info.peerStateRoot,
        localStateRoot: info.localStateRoot ?? "<unset>",
      })
      // forceSnapSync's only known-failure path is when peers haven't
      // exposed a snapshot endpoint yet (bootstrap window). Catch and log
      // so a transient peer issue doesn't crash the listener; the next
      // round timeout will retry under cooldown.
      consensus.forceSnapSync().catch((err) => {
        log.warn("BFT peer-quorum forceSnapSync failed", { error: String(err) })
      })
      return true
    },
    persistentDivergenceThreshold: process.env.COC_PERSISTENT_DIVERGENCE_THRESHOLD
      ? Number(process.env.COC_PERSISTENT_DIVERGENCE_THRESHOLD)
      : undefined,
    onPersistentDivergence: process.env.COC_BFT_AUTO_RECOVERY === "1"
      ? (info) => {
          // Phase H5: H4's incremental snap-sync didn't cure the divergence
          // — usually because the local leveldb is on-disk corrupted and
          // block replay re-produces the same divergent state. Escalate to
          // forceSnapSync which imports a full state snapshot from peers
          // (the in-process equivalent of `rsync leveldb-state +
          // leveldb-chain` we've been doing manually).
          //
          // Default-OFF in production via COC_BFT_AUTO_RECOVERY=1 env gate
          // because a misfiring recovery loop overwriting good state would
          // be catastrophic. testnet enables to validate the path.
          if (!consensus) return
          const nowMs = Date.now()
          const sinceLastMs = nowMs - lastForceSnapSyncMs
          if (sinceLastMs < FORCE_SNAP_SYNC_COOLDOWN_MS) {
            log.warn("BFT persistent-divergence forceSnapSync skipped (cooldown)", {
              height: info.height.toString(),
              consecutiveCount: info.consecutiveCount,
              remainingMs: FORCE_SNAP_SYNC_COOLDOWN_MS - sinceLastMs,
            })
            return
          }
          lastForceSnapSyncMs = nowMs
          log.error("BFT persistent peer-quorum divergence — triggering forceSnapSync (auto-recovery)", {
            height: info.height.toString(),
            consecutiveCount: info.consecutiveCount,
            lastPeerBlockHash: info.lastPeerBlockHash,
            lastPeerStateRoot: info.lastPeerStateRoot,
          })
          consensus.forceSnapSync().catch((err) => {
            log.error("BFT forceSnapSync failed", { error: String(err) })
          })
        }
      : undefined,
  })
  log.info("BFT consensus enabled", { validators: config.validators.length })

  // Sprint 4 of Phase F+G: when a ValidatorRegistry contract is configured,
  // bootstrap the BFT validator set from it and keep it in sync via event
  // polling. The hardcoded `validators` config above remains the fallback
  // path (no `validatorRegistryAddress` ⇒ this branch is skipped).
  if (config.validatorRegistryAddress) {
    const reader = new ValidatorRegistryReader({
      rpcUrl: process.env.COC_VALIDATOR_REGISTRY_RPC_URL || `http://127.0.0.1:${config.rpcPort}`,
      address: config.validatorRegistryAddress as `0x${string}`,
      persistPath: join(config.dataDir, "validator-registry-reader.state.json"),
      pollIntervalMs: config.validatorRegistryPollIntervalMs,
      fromBlock: config.validatorRegistryFromBlock !== undefined
        ? BigInt(config.validatorRegistryFromBlock)
        : undefined,
    })

    const applyActiveSet = () => {
      const active = reader.getActiveSet()
      if (active.length === 0) {
        log.warn("ValidatorRegistry returned empty active set; keeping fallback validators", {
          fallbackCount: validators.length,
        })
        return
      }
      const next = active.map((e: ValidatorEntry) => ({
        // Match BFT's lowercase-address convention. nodeId's trailing 20 B
        // hex is the validator's EVM address (per ValidatorRegistry's
        // keccak256(pubkey[1:]) convention).
        id: ("0x" + e.nodeId.slice(-40)).toLowerCase(),
        stake: e.stake,
      }))
      // PR-1B (2026-05-10): route through consensus.onValidatorSetChange so
      // the lastProposed cache is invalidated alongside the BFT cache. The
      // 2026-05-09 attempt #1 fingerprint was reader-driven N=3→N=8 keeping
      // a stale cached block in consensus, which Phase R then refused as
      // self-equivocation. Falls back to direct BFT update if consensus
      // hasn't been constructed yet (only happens during init race).
      if (consensus) {
        consensus.onValidatorSetChange(next)
      } else {
        bftCoordinator?.updateValidators(next)
      }
      log.info("BFT validator set updated from ValidatorRegistry", {
        count: next.length,
        ids: next.map((v) => v.id),
      })
    }

    reader.on("validatorAdded", applyActiveSet)
    reader.on("validatorRemoved", applyActiveSet)

    // Init can race with our own RPC server: when the reader points at
    // 127.0.0.1:<rpcPort> (the default), it fires before startRpcServer
    // is called below at the bottom of this file, so the first init()
    // hits ECONNREFUSED. Solution: bound retry with backoff. The reader's
    // poll loop also re-scans on every tick, so even a permanent init()
    // failure self-heals once RPC comes up — but eager retry shortens the
    // gap between node startup and the first BFT validator-set update.
    const initWithRetry = async (): Promise<void> => {
      const MAX_ATTEMPTS = 6
      const BACKOFF_MS = 5_000
      for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
        try {
          await reader.init()
          applyActiveSet()
          reader.start()
          return
        } catch (err) {
          const isLast = attempt === MAX_ATTEMPTS
          log.warn("ValidatorRegistryReader init attempt failed", {
            attempt,
            maxAttempts: MAX_ATTEMPTS,
            error: String(err),
            willRetry: !isLast,
          })
          if (isLast) {
            log.error("ValidatorRegistryReader init exhausted retries; starting poll loop in fallback mode", {
              address: config.validatorRegistryAddress,
            })
            // Even after init failure, run start() so the periodic
            // scanToTip eventually picks up the active set when RPC
            // becomes reachable. Without this, the reader is permanently
            // dead and the BFT set is stuck on hardcoded fallback.
            reader.start()
            return
          }
          await new Promise((r) => setTimeout(r, BACKOFF_MS))
        }
      }
    }
    void initWithRetry()
  }
}

const ipfsStore = new IpfsBlockstore(
  config.storageDir,
  undefined,
  // Phase S1/S2: light-mode peers cap their blockstore via
  // `ipfsMaxStorageBytes`; archive nodes leave it undefined for unlimited.
  config.ipfsMaxStorageBytes !== undefined ? { maxBytes: config.ipfsMaxStorageBytes } : undefined,
)
await ipfsStore.init()
const unixfs = new UnixFsBuilder(ipfsStore)
const ipfs = new IpfsHttpServer(
  {
    bind: config.ipfsBind,
    port: config.ipfsPort,
    storageDir: config.storageDir,
    nodeId: config.nodeId,
    // #9: thread the admin token + anonymous /api/v0/add policy through.
    // Pre-fix the IPFS server received none of these — `COC_IPFS_ADMIN_TOKEN`
    // was documented in the source but never read, so admin auth degraded
    // to loopback-only and /api/v0/add was wide-open to anonymous DoS.
    adminAuthToken: config.ipfsAdminAuthToken,
    anonymousAdd: config.ipfsAnonymousAddAllowed
      ? {
          allowed: true,
          perIpBytes: config.ipfsAnonymousAddPerIpBytes,
          totalBytes: config.ipfsAnonymousAddTotalBytes,
          windowMs: config.ipfsAnonymousAddWindowMs,
        }
      : undefined,
  },
  ipfsStore,
  unixfs,
)

// Initialize MFS and Pubsub subsystems
const mfs = new IpfsMfs(ipfsStore, unixfs)
const pubsub = new IpfsPubsub({ nodeId: config.nodeId })
pubsub.start()
ipfs.attachSubsystems({ mfs, pubsub })

// Wire pubsub to P2P layer for cross-node messaging
pubsub.setPeerForwarder({
  async forwardPubsubMessage(topic, msg) {
    await p2p.broadcastPubsub(topic, msg)
  },
})
p2p.setPubsubHandler((topic, message) => {
  pubsub.receiveFromPeer(topic, message as PubsubMessage)
})

ipfs.start()

// Build snap sync provider if state trie is available
let snapSyncProvider: SnapSyncProvider | undefined
if (stateTrie && config.enableSnapSync) {
  const trieRef = stateTrie
  snapSyncProvider = {
    async fetchStateSnapshot(peerUrl: string) {
      const SNAP_FETCH_TIMEOUT_MS = 30_000
      const SNAP_MAX_RESPONSE_BYTES = 16 * 1024 * 1024 // 16 MiB
      try {
        const controller = new AbortController()
        const timer = setTimeout(() => controller.abort(), SNAP_FETCH_TIMEOUT_MS)
        try {
          const headers: Record<string, string> = {}
          if (nodeSigner) {
            headers["x-p2p-auth"] = buildSignedGetAuth("/p2p/state-snapshot", nodeSigner)
          }
          const res = await fetch(`${peerUrl}/p2p/state-snapshot`, { signal: controller.signal, headers })
          if (!res.ok) {
            // Phase H12: log the non-OK status so we can diagnose why snap-sync
            // can't recover. Pre-H12 this returned null silently and the caller
            // (forceSnapSync) eventually surfaced "no peer provided valid state
            // snapshot" with no clue what went wrong (rate limit? auth? 404?).
            const bodyText = await res.text().catch(() => "<unreadable>")
            log.warn("snap sync: peer returned non-OK", {
              peer: peerUrl,
              status: res.status,
              statusText: res.statusText,
              body: bodyText.slice(0, 200),
            })
            return null
          }
          // Read body with size limit
          const reader = res.body?.getReader()
          if (!reader) {
            log.warn("snap sync: peer response has no body reader", { peer: peerUrl })
            return null
          }
          const chunks: Uint8Array[] = []
          let totalBytes = 0
          for (;;) {
            const { done, value } = await reader.read()
            if (done) break
            totalBytes += value.byteLength
            if (totalBytes > SNAP_MAX_RESPONSE_BYTES) {
              reader.cancel()
              log.warn("snap sync: response too large, aborting", { peer: peerUrl, bytes: totalBytes })
              return null
            }
            chunks.push(value)
          }
          const text = Buffer.concat(chunks).toString("utf8")
          return JSON.parse(text) as StateSnapshot
        } finally {
          clearTimeout(timer)
        }
      } catch (err) {
        // Phase H12: log catch-path errors instead of silently returning null.
        // Network errors, abort timeouts, JSON parse failures all land here —
        // surfacing them is critical for understanding why forceSnapSync's
        // recovery escalation doesn't actually recover.
        log.warn("snap sync: fetchStateSnapshot threw", {
          peer: peerUrl,
          error: String(err),
        })
        return null
      }
    },
    async importStateSnapshot(snapshot: unknown, expectedStateRoot?: string) {
      // #671: importStateSnapshot does checkpoint / put / putStorageAt / commit
      // on the shared PersistentStateTrie. forceSnapSync ran this completely
      // unserialized against applyBlock, so an in-flight applyBlock interleaved
      // with the import at an `await` boundary, corrupted the trie, and the
      // node could never recover (forceSnapSync returned ok:false forever →
      // chain deadlock). Run the import — AND pin the resulting root — inside
      // the engine's state-exclusive queue so applyBlock cannot interleave.
      // Pinning the root in the SAME critical section makes import+setStateRoot
      // atomic: no applyBlock can slip between them and then be rolled back.
      const runExclusive = (chain as { runStateExclusive?: <T>(fn: () => Promise<T>) => Promise<T> }).runStateExclusive?.bind(chain)
      const doImport = async () => {
        const result = await importStateSnapshot(trieRef, snapshot as StateSnapshot, expectedStateRoot)
        if (expectedStateRoot && typeof trieRef.setStateRoot === "function") {
          await trieRef.setStateRoot(expectedStateRoot)
        }
        return result
      }
      return runExclusive ? await runExclusive(doImport) : await doImport()
    },
    async setStateRoot(root: string) {
      if (typeof trieRef.setStateRoot !== "function") return
      // #671: serialize the root-set against applyBlock too. The forceSnapSync
      // path no longer calls this separately (importStateSnapshot pins the
      // root atomically above); kept for any other caller.
      const runExclusive = (chain as { runStateExclusive?: <T>(fn: () => Promise<T>) => Promise<T> }).runStateExclusive?.bind(chain)
      const setIt = () => trieRef.setStateRoot!(root)
      if (runExclusive) { await runExclusive(setIt) } else { await setIt() }
    },
    restoreGovernance(validators: Array<{ id: string; address: string; stake: bigint; active: boolean }>) {
      if (hasGovernance(chain) && chain.governance && typeof (chain.governance as { initGenesis?: unknown }).initGenesis === "function") {
        (chain.governance as { initGenesis(v: Array<{ id: string; address: string; stake: bigint }>): void }).initGenesis(validators)
        log.info("governance validators restored from snap sync", { count: validators.length })
      }
      // Sync BFT coordinator validator set with restored governance.
      // PR-1B: also invalidate consensus.lastProposed if consensus exists.
      if (bftCoordinator) {
        const activeValidators = validators.filter((v) => v.active)
        const next = activeValidators.map((v) => ({ id: v.id, stake: v.stake }))
        if (consensus) {
          consensus.onValidatorSetChange(next)
        } else {
          bftCoordinator.updateValidators(next)
        }
        log.info("BFT coordinator validators synced after governance restore", { count: activeValidators.length })
      }
    },
  }
}

// Wire broadcast functions — will be bound after wire server setup
let wireBroadcastFn: ((block: ChainBlock) => void) | undefined
let wireTxRelayFn: ((rawTx: Hex) => void) | undefined
let wireBftBroadcastFn: ((msg: BftMessage) => void) | undefined
let wireServer: WireServer | undefined
const wireClients: WireClient[] = []
const wireClientByPeerId = new Map<string, WireClient>()
let dhtNetwork: DhtNetwork | undefined

const consensus = new ConsensusEngine(chain, p2p, {
  blockTimeMs: config.blockTimeMs,
  syncIntervalMs: config.syncIntervalMs,
  enableSnapSync: config.enableSnapSync,
  snapSyncThreshold: config.snapSyncThreshold,
  sequencerMode: config.nodeMode === "sequencer",
}, {
  bft: bftCoordinator,
  snapSync: snapSyncProvider,
  wireBroadcast: (block) => wireBroadcastFn?.(block),
  nodeId: config.nodeId,
  // PR-1A (2026-05-10): expose wire-layer reachability so
  // checkNoProgressWatchdog can detect a disconnected proposer immediately
  // (rather than waiting for the 600s H15 timeout). `wireClients` is
  // populated when the wire layer initialises later in this module — the
  // closure captures the array reference, so this provider works as soon
  // as the wire connections come up.
  reachabilityProvider: (): Set<string> => {
    const set = new Set<string>()
    for (const c of wireClients) {
      if (!c.isConnected()) continue
      const id = c.getRemoteNodeId()
      if (id) set.add(id.toLowerCase())
    }
    return set
  },
  // PR-1J (2026-05-11): provide live active-validator count so consensus
  // can disable PR-1A on small clusters (N < PR1A_MIN_VALIDATORS, default 4).
  // Prefers on-chain governance set when active, otherwise the hardcoded
  // validators array from config (post-init it reflects ValidatorRegistry).
  validatorCountProvider: (): number => {
    if (hasGovernance(chain)) {
      const active = chain.governance.getActiveValidators()
      if (active.length > 0) return active.length
    }
    return config.validators?.length ?? 0
  },
})
consensus.start()

// Phase J1.3: route chain-engine local apply rejection (stateRoot
// mismatch on a non-locally-proposed block) into consensus.requestSyncNow.
// Closes the H4/H5 deadzone where a stateRoot-corrupted node never enters
// a BFT round (block validation rejects parent-state, prepareVotes stay
// empty, detectPeerQuorumDivergence returns null) and therefore never
// triggers the existing peer-quorum-divergence catch-up path.
const onLocalApplyRejected = (info: {
  height: bigint
  blockHash: Hex
  expectedRoot: Hex
  actualRoot: Hex
  reason: string
}): void => {
  log.warn("Phase J1.3: chain engine rejected non-local block — requesting sync", {
    height: info.height.toString(),
    blockHash: info.blockHash,
    expectedRoot: info.expectedRoot,
    actualRoot: info.actualRoot,
    reason: info.reason,
  })
  consensus.requestSyncNow().catch((err) => {
    log.warn("Phase J1.3: requestSyncNow after local apply rejection failed", {
      error: String(err),
    })
  })
}
if (typeof (chain as PersistentChainEngine).setOnLocalApplyRejected === "function") {
  (chain as PersistentChainEngine).setOnLocalApplyRejected(onLocalApplyRejected)
} else if (typeof (chain as ChainEngine).setOnLocalApplyRejected === "function") {
  (chain as ChainEngine).setOnLocalApplyRejected(onLocalApplyRejected)
}

const pose = new PoSeEngine(BigInt(Math.floor(Date.now() / config.poseEpochMs)), {
  signer: nodeSigner,
  nonceRegistry: new NonceRegistry({
    persistencePath: config.poseNonceRegistryPath,
    ttlMs: config.poseNonceRegistryTtlMs,
    maxEntries: config.poseNonceRegistryMaxEntries,
  }),
  maxChallengesPerEpoch: config.poseMaxChallengesPerEpoch,
})
const poseAuthNonceTracker = new PersistentPoseAuthNonceTracker({
  persistencePath: config.poseAuthNonceRegistryPath,
  ttlMs: config.poseAuthNonceTtlMs,
  maxSize: config.poseAuthNonceMaxEntries,
})
const poseCleanupTimer = setInterval(() => poseAuthNonceTracker.cleanup(), 300_000)
poseCleanupTimer.unref()
const poseCompactTimer = config.poseAuthNonceRegistryPath
  ? setInterval(() => poseAuthNonceTracker.compact(), 60 * 60 * 1000)
  : null
poseCompactTimer?.unref()
const poseChallengerDynamicResolver = resolvePoseChallengerDynamicResolver(config, chain)
const poseChallengerAuthorizer = poseChallengerDynamicResolver
  ? createPoseChallengerAuthorizer({
      staticAllowlist: config.poseAllowedChallengers,
      cacheTtlMs: config.poseChallengerAuthCacheTtlMs,
      failOpen: config.poseOnchainAuthFailOpen,
      dynamicResolver: poseChallengerDynamicResolver,
    })
  : undefined

// DID identity layer (optional — requires contract addresses in config)
// Uses in-process EVM callRaw() for contract reads — no HTTP loopback, no auth issues
let didResolverInstance: { resolve: (did: string) => Promise<unknown> } | undefined
let didDataProviderInstance: ReturnType<typeof import("./did/did-data-provider.ts").createContractDIDDataProvider> | undefined
if (config.soulRegistryAddress && config.didRegistryAddress) {
  const { createContractDIDDataProvider } = await import("./did/did-data-provider.ts")
  const { createDIDResolver } = await import("./did/did-resolver.ts")
  const ethCall = async (to: string, data: string): Promise<string> => {
    const result = await evm.callRaw({ to, data })
    return result.returnValue
  }
  const didProvider = createContractDIDDataProvider({
    soulRegistryAddress: config.soulRegistryAddress,
    didRegistryAddress: config.didRegistryAddress,
    ethCall,
  })
  const resolver = createDIDResolver({ defaultChainId: config.chainId, provider: didProvider })
  didResolverInstance = resolver
  didDataProviderInstance = didProvider
  console.log(`[DID] Resolver configured: SoulRegistry=${config.soulRegistryAddress}, DIDRegistry=${config.didRegistryAddress}`)
}

startRpcServer(
  config.rpcBind,
  config.rpcPort,
  config.chainId,
  evm,
  chain,
  p2p,
  pose,
  bftCoordinator,
  config.nodeId,
  {
    enableInboundAuth: config.poseRequireInboundAuth,
    inboundAuthMode: config.poseInboundAuthMode,
    authMaxClockSkewMs: config.poseAuthMaxClockSkewMs,
    verifier: nodeSigner,
    nonceTracker: poseAuthNonceTracker,
    allowedChallengers: config.poseAllowedChallengers,
    challengerAuthorizer: poseChallengerAuthorizer,
  },
  {
    nodeId: config.nodeId,
    getP2PStats: () => p2p.getStats(),
    getWireStats: () => wireServer?.getStats(),
    getDhtStats: () => dhtNetwork?.getStats(),
    findProviders: (cid: string, maxK?: number) => dhtNetwork?.findProviders(cid, maxK ?? 3) ?? [],
    fetchBlockFromPeer: async (cid: string, excludePeerId?: string) => {
      // Phase C2.4: resolve providers via the DHT, optionally exclude
      // the prover (passed in by the auditor), ask the first reachable
      // non-excluded peer for the chunk via the wire BlockRequest
      // frame (C1.2). Returns null when nobody served within the
      // per-peer pull timeout.
      if (!dhtNetwork) return null
      const providers = dhtNetwork.findProviders(cid, 5)
      const excluded = excludePeerId ? excludePeerId.toLowerCase() : null
      const independents = excluded ? providers.filter((p) => p.toLowerCase() !== excluded) : providers
      if (independents.length === 0) return null
      // Walk the connected WireClient set and pick the first one whose
      // remote ID matches an independent provider. Iteration is cheap
      // (wireClients is capped well below 100 peers per node).
      const peerSet = new Set(independents.map((p) => p.toLowerCase()))
      for (const client of wireClients) {
        if (!client.isConnected()) continue
        const remoteId = client.getRemoteNodeId()
        if (!remoteId || !peerSet.has(remoteId.toLowerCase())) continue
        const bytes = await client.requestBlock(cid, 5000)
        if (!bytes || bytes.length === 0) continue
        // Content-addressing enforcement. This pull bypasses the
        // IpfsBlockstore (and its #658 verification), so a peer could
        // otherwise serve forged bytes for `cid` straight back to the
        // coc_ipfsFetchBlockFromPeer RPC caller — and, for the C2.4 audit
        // sampling use case, a malicious "independent" peer could forge a
        // false audit failure against an honest prover. A block that does
        // not hash to `cid` is discarded; try the next provider.
        if (!(await cidMatchesBytes(cid, bytes))) continue
        return bytes
      }
      return null
    },
    getSyncProgress: () => consensus.getSyncProgress(),
    rewardManifestDir: join(config.dataDir, "reward-manifests"),
    getBftEquivocations: (sinceMs: number) => bftEvidenceStore.peek().filter(
      (e) => (e.rawEvidence?.detectedAtMs ?? 0) > sinceMs
    ),
    getErasureStatus: async (cid: string) => {
      // #108: RPC bridge for the existing /api/v0/erasure/status handler.
      // Resolve the CID into an ErasureManifest (throws if it's not one
      // or the blocks are missing), then compute per-stripe availability.
      // #358: pre-fix the dynamic import destructured `ErasureError`
      // from `./ipfs-erasure-reader.ts`, but that module *imports*
      // ErasureError (from ./ipfs-erasure.ts) without re-exporting it.
      // So `ErasureError` resolved to `undefined` at runtime, and the
      // `err instanceof ErasureError` check below threw V8 TypeError
      // "Right-hand side of 'instanceof' is not an object" — caught
      // by the RPC layer and surfaced as -32603 with the V8 message
      // leaked through. Import ErasureError directly from its real
      // owning module instead.
      const { resolveCid, erasureStatus } = await import("./ipfs-erasure-reader.ts")
      const { ErasureError } = await import("./ipfs-erasure.ts")
      try {
        const resolved = await resolveCid(cid, ipfsStore)
        if (resolved.kind !== "erasure" || !resolved.manifest) {
          throw { code: -32604, message: `CID ${cid} is not an erasure manifest` }
        }
        return await erasureStatus(resolved.manifest, ipfsStore)
      } catch (err) {
        if (err instanceof ErasureError) {
          if (err.code === "invalid_cid") throw { code: -32602, message: err.message }
          if (err.code === "not_found") throw { code: -32604, message: err.message }
          throw { code: -32603, message: err.message }
        }
        throw err
      }
    },
    didResolver: didResolverInstance,
    didDataProvider: didDataProviderInstance,
  },
  {
    authToken: config.rpcAuthToken,
    enableAdminRpc: config.enableAdminRpc,
    allowLoopbackRpcAuth: config.allowLoopbackRpcAuth,
  },
)

// Start WebSocket RPC server for real-time subscriptions
// Bind bftCoordinator into the handler closure so WS RPC can access BFT state (e.g. coc_bftRoundState)
const wsDidOpts: Record<string, unknown> = {}
if (didResolverInstance) wsDidOpts.didResolver = didResolverInstance
if (didDataProviderInstance) wsDidOpts.didDataProvider = didDataProviderInstance
const wsHandleRpcMethod = (method: string, params: unknown[], cId: number, e: EvmChain, c: IChainEngine, p: P2PNode) =>
  handleRpcMethod(method, params, cId, e, c, p, bftCoordinator, Object.keys(wsDidOpts).length > 0 ? wsDidOpts : undefined)
const wsServer = startWsRpcServer(
  { port: config.wsPort, bind: config.wsBind, authToken: config.rpcAuthToken },
  config.chainId,
  evm,
  chain,
  p2p,
  chain.events,
  wsHandleRpcMethod,
)
log.info("WebSocket RPC configured", { bind: config.wsBind, port: config.wsPort })

if (config.enableWireProtocol) {
  wireServer = new WireServer({
    port: config.wirePort,
    bind: config.wireBind,
    nodeId: config.nodeId,
    chainId: config.chainId,
    signer: nodeSigner,
    verifier: nodeSigner,
    peerScoring: { recordInvalidData: (ip) => p2p.scoring.recordInvalidData(ip) },
    sharedSeenTx: p2p.seenTx,
    sharedSeenBlocks: p2p.seenBlocks,
    onBlock: async (block) => {
      if (!bftCoordinator) {
        try { await chain.applyBlock(block) } catch { /* ignore */ }
      } else if (block.txs.length > 0) {
        for (const rawTx of block.txs) {
          try { chain.mempool.remove(keccak256(rawTx) as Hex) } catch { /* ignore */ }
        }
      }
      if (bftCoordinator) {
        try {
          await bftCoordinator.handleReceivedBlock(block)
        } catch {
          // ignore
        }
      }
    },
    onTx: async (rawTx) => {
      try {
        await chain.addRawTx(rawTx)
      } catch {
        // ignore
      }
    },
    onBftMessage: bftCoordinator
      ? async (msg) => { await bftCoordinator!.handleMessage(msg) }
      : undefined,
    onFindNode: (targetId: string) => {
      if (dhtNetwork) {
        return dhtNetwork.routingTable.findClosest(targetId, 20).map((p) => ({
          id: p.id,
          address: p.address,
        }))
      }
      return []
    },
    getHeight: () => Promise.resolve(chain.getHeight()),
    // Cross-protocol relay: Wire → HTTP gossip
    onTxRelay: async (rawTx) => {
      try { await p2p.receiveTx(rawTx) } catch { /* dedup in P2P layer */ }
    },
    onBlockRelay: async (block) => {
      try { await p2p.receiveBlock(block) } catch { /* dedup in P2P layer */ }
    },
  })
  wireServer.start()
  log.info("wire protocol TCP server started", { port: config.wirePort })

  // Bind wire broadcast for dual HTTP+TCP block and transaction propagation
  const ws = wireServer
  wireBroadcastFn = (block) => {
    const data = encodeJsonPayload(MessageType.Block, block)
    ws.broadcastFrame(data)
  }
  wireTxRelayFn = (rawTx: Hex) => {
    const data = encodeJsonPayload(MessageType.Transaction, { rawTx })
    ws.broadcastFrame(data)
  }

  // BFT messages via wire protocol
  wireBftBroadcastFn = (msg: BftMessage) => {
    const wireType = msg.type === "prepare" ? MessageType.BftPrepare : MessageType.BftCommit
    const framePayload: Record<string, unknown> = {
      type: msg.type,
      height: msg.height.toString(),
      blockHash: msg.blockHash,
      senderId: msg.senderId,
      signature: msg.signature,
    }
    // Carry stateRoot on wire transport so BFT (hash, stateRoot) quorum works
    // regardless of whether peers reach us via HTTP gossip or binary wire.
    if (msg.stateRoot) framePayload.stateRoot = msg.stateRoot
    ws.broadcastFrame(encodeJsonPayload(wireType, framePayload))
  }

  // Build peer ID → wire port mapping from dhtBootstrapPeers config
  const peerWirePortMap = new Map<string, number>()
  for (const bp of config.dhtBootstrapPeers) {
    peerWirePortMap.set(bp.id, bp.port)
  }

  // Issue #72: when a peer's handshake reports a height materially ahead
  // of ours, kick off snap-sync directly instead of waiting for the
  // 600 s no-progress watchdog. Threshold + cooldown tuned 2026-05-08
  // post-#72 deploy: original (3 blocks / 30 s) caused server-3 to
  // forceSnapSync ~17×/hour on a 1 block/s chain because normal ±1 BFT
  // lag transiently exceeded 3. Bumped to 20 blocks / 120 s — a real
  // restart still triggers (typically 100+ block gap before catch-up
  // begins) but transient lag during normal operation does not.
  const PEER_HEIGHT_SYNC_THRESHOLD = 20n
  // Cooldown so reconnect storms don't spawn parallel forceSnapSync calls.
  let lastPeerHeightSyncMs = 0
  const PEER_HEIGHT_SYNC_COOLDOWN_MS = 120_000
  const onPeerHeightAdvance = (remoteHeight: bigint, peerId: string): void => {
    void (async () => {
      try {
        const localHeight = BigInt(await Promise.resolve(chain.getHeight()))
        if (remoteHeight <= localHeight + PEER_HEIGHT_SYNC_THRESHOLD) return
        const now = Date.now()
        if (now - lastPeerHeightSyncMs < PEER_HEIGHT_SYNC_COOLDOWN_MS) {
          log.debug("peer-height advance: forceSnapSync skipped (cooldown)", {
            peer: peerId,
            localHeight: localHeight.toString(),
            remoteHeight: remoteHeight.toString(),
            cooldownMsRemaining: PEER_HEIGHT_SYNC_COOLDOWN_MS - (now - lastPeerHeightSyncMs),
          })
          return
        }
        lastPeerHeightSyncMs = now
        log.warn("peer-height advance — triggering forceSnapSync (#72)", {
          peer: peerId,
          localHeight: localHeight.toString(),
          remoteHeight: remoteHeight.toString(),
          gap: (remoteHeight - localHeight).toString(),
        })
        consensus.forceSnapSync().catch((err) => {
          log.warn("peer-height forceSnapSync failed", { peer: peerId, error: String(err) })
        })
      } catch (err) {
        log.warn("peer-height advance handler threw", { peer: peerId, error: String(err) })
      }
    })()
  }

  // Connect to known peers via wire protocol
  for (const peer of config.peers) {
    try {
      const url = new URL(peer.url)
      // peer.url carries the P2P/HTTP gossip port (e.g. 29782) — the wire
      // port lives in dhtBootstrapPeers (29783). When a peer is absent
      // from dhtBootstrapPeers (e.g. ext validators added post-bootstrap),
      // skip it instead of falling back to `config.wirePort`, which would
      // dial the local node's own wire port and trigger a self-connection
      // storm (observed 2026-05-06 X2 recovery).
      const peerWirePort = peerWirePortMap.get(peer.id)
      if (peerWirePort === undefined) {
        log.warn("skipping wire client: peer not in dhtBootstrapPeers", { peer: peer.id })
        continue
      }
      const client = new WireClient({
        host: url.hostname,
        port: peerWirePort,
        nodeId: config.nodeId,
        chainId: config.chainId,
        signer: nodeSigner,
        verifier: nodeSigner,
        // Issue #72: advertise current chain height so peers don't
        // mistake us for genesis, and react when peers report ahead of us.
        getHeight: () => chain.getHeight(),
        onPeerHeight: onPeerHeightAdvance,
        onConnected: () => log.info("wire client connected", { peer: peer.id }),
        onDisconnected: () => log.info("wire client disconnected", { peer: peer.id }),
      })
      client.connect()
      wireClients.push(client)
      // Issue #70: normalise the key to lowercase so DHT-sourced lookups
      // (routing-table peer IDs are lowercase) and config-sourced lookups
      // (config.peers id is EIP-55 mixed-case) hit the same entry.
      wireClientByPeerId.set(peer.id.toLowerCase(), client)
    } catch {
      log.warn("failed to create wire client for peer", { peer: peer.id })
    }
  }
}

if (config.enableDht) {
  // Map peerId → HTTP P2P URL so DHT-discovered peers can be added to
  // the HTTP discovery layer with the correct port. DhtPeer.address is
  // `host:wirePort` (TCP wire protocol), but PeerDiscovery's identity
  // verification + state-snapshot + bft-message gossip all speak HTTP
  // on `p2pPort` (≠ wirePort). The previous behavior built
  // `http://${peer.address}` which pointed HTTP requests at the wire
  // port and 404'd, forcing operators to disable
  // `dhtRequireAuthenticatedVerify` to avoid spurious reject-loops.
  const peerIdToHttpUrl = new Map<string, string>()
  for (const p of config.peers) {
    peerIdToHttpUrl.set(p.id, p.advertisedUrl ?? p.url)
  }

  dhtNetwork = new DhtNetwork({
    localId: config.nodeId,
    localAddress: `${config.p2pBind}:${config.wirePort}`,
    chainId: config.chainId,
    bootstrapPeers: config.dhtBootstrapPeers,
    wireClients,
    signer: nodeSigner,
    verifier: nodeSigner,
    requireAuthenticatedVerify: config.dhtRequireAuthenticatedVerify,
    providerStorePath: config.dhtProviderStorePath,
    wireClientByPeerId,
    onPeerDiscovered: (peer) => {
      const httpUrl = peerIdToHttpUrl.get(peer.id)
      if (!httpUrl) {
        // Wire-only peer: identity is already verified by the signed
        // wire handshake, but we have no HTTP endpoint for it. Skipping
        // is strictly safer than the old `http://${peer.address}` build
        // which would 404 every HTTP gossip attempt and drop the peer's
        // discovery score.
        log.debug("DHT peer has no configured HTTP URL — skipping HTTP discovery add", { peer: peer.id })
        return
      }
      p2p.discovery.addDiscoveredPeers([{ id: peer.id, url: httpUrl }])
    },
  })
  dhtNetwork.start()
  log.info("DHT peer discovery started", { bootstrapPeers: config.dhtBootstrapPeers.length })
}

// Phase C wiring: glue IpfsBlockstore <-> DhtNetwork <-> Wire so that
// local PUTs announce + replicate to K peers, remote misses fall back
// to peer fetch, and the HTTP PUT handler can surface replica shortfalls.
// Only attach when both Wire and DHT are enabled — without either,
// the wiring has no peers to talk to.
let ipfsRepairLoop: IpfsRepairLoop | undefined
if (wireServer && dhtNetwork) {
  // Adapter that matches the subset of WireConnectionManager that
  // buildCocIpfsWiring uses: findByNodeId (push side) and
  // requestBlockFromAny (pull side). index.ts keeps its own
  // wireClients array + wireClientByPeerId Map rather than owning a
  // WireConnectionManager, so we bridge without changing construction.
  // Issue #70: every comparison here must be case-insensitive. The wire
  // handshake stores `getRemoteNodeId()` in EIP-55 mixed-case (taken from
  // the peer's `config.nodeId`), and `wireClientByPeerId` is keyed by the
  // mixed-case `peer.id` from `config.peers`. Meanwhile `DhtNetwork`'s
  // routing table normalises every peer ID to lowercase on insert, so
  // `findProviders` returns lowercase. A strict `Map.get` or `===`
  // comparison silently misses every cross-node fetchRemote — the
  // exact symptom of #70 (and the root cause of Q+1's live-verification
  // failure). Lowercasing both sides matches the convention DHT already
  // uses internally.
  const connMgrAdapter = {
    findByNodeId(nodeId: string) {
      const want = nodeId.toLowerCase()
      // Map keys are always lowercased (set in `wireClientByPeerId.set`
      // above), so this hits regardless of the caller's input case.
      const direct = wireClientByPeerId.get(want)
      if (direct && direct.isConnected()) return direct
      // Defence-in-depth scan: in case a wire client was registered via
      // a non-config-driven path (none today, but keeps the adapter
      // robust if that changes) — match by the wire-handshake's reported
      // remote ID, also lowercased.
      for (const c of wireClients) {
        const remote = c.getRemoteNodeId()
        if (c.isConnected() && remote && remote.toLowerCase() === want) return c
      }
      return undefined
    },
    listConnectedPeerIds(): string[] {
      const ids: string[] = []
      for (const c of wireClients) {
        if (!c.isConnected()) continue
        const id = c.getRemoteNodeId()
        if (id) ids.push(id)
      }
      return ids
    },
    async requestBlockFromAny(
      peerIds: string[],
      cid: string,
      opts?: { concurrency?: number; timeoutMs?: number },
    ): Promise<Uint8Array | null> {
      if (peerIds.length === 0) return null
      const timeoutMs = opts?.timeoutMs ?? 5000
      for (const peerId of peerIds) {
        const client = this.findByNodeId(peerId)
        if (!client) continue
        try {
          const bytes = await client.requestBlock(cid, timeoutMs)
          if (bytes && bytes.length > 0) return bytes
        } catch { /* try next */ }
      }
      return null
    },
  } as unknown as import("./wire-connection-manager.ts").WireConnectionManager

  const wiring = buildCocIpfsWiring({
    localNodeId: config.nodeId,
    blockstore: ipfsStore,
    dht: dhtNetwork,
    connMgr: connMgrAdapter,
    replicationFactor: config.ipfsReplicationFactor,
  })
  ipfsStore.setHooks(wiring.blockstoreHooks)
  wireServer.setOnBlockRequest(wiring.onBlockRequest)
  // Cross-node DHT provider gossip: when a peer says "I hold X",
  // add (X, peer) to our local DHT. Authenticated sender ID comes
  // from the wire-server handshake, NOT from the payload.
  wireServer.setOnProviderAdvertise((cid, providerId, ttlMs) => {
    dhtNetwork!.putProvider(cid, providerId, ttlMs)
  })
  ipfs.setAwaitReplicationResult(wiring.awaitReplicationResult, config.ipfsMinReplicas)
  ipfs.setPushStripe(wiring.pushStripe)

  // Phase C3.3 repair loop: 10 min sweep tops up under-replicated pins.
  ipfsRepairLoop = new IpfsRepairLoop({
    blockstore: ipfsStore,
    dht: dhtNetwork,
    pushToK: wiring.pushToK,
  })
  ipfsRepairLoop.start()
  log.info("Phase C IPFS wiring attached", {
    replicationFactor: config.ipfsReplicationFactor,
    minReplicas: config.ipfsMinReplicas,
  })
}

// Prometheus metrics server
const metricsPort = Number(process.env.COC_METRICS_PORT ?? 9100)
const metricsBind = process.env.COC_METRICS_BIND ?? "127.0.0.1"
const metricsHandle = startMetricsServer({
  getBlockHeight: () => chain.getHeight(),
  getTxPoolPending: () => chain.mempool.stats().size,
  getTxPoolQueued: () => 0,
  getPeersConnected: () => p2p.discovery.getActivePeers().length,
  getWireConnections: wireServer ? () => wireServer!.getStats().connections : undefined,
  getBftRoundHeight: bftCoordinator ? () => {
    const state = bftCoordinator!.getRoundState()
    return state.height !== null ? Number(state.height) : 0
  } : undefined,
  getConsensusState: () => consensus.getStatus().status,
  getDhtPeers: dhtNetwork ? () => dhtNetwork!.getStats().totalPeers : undefined,
  getP2PAuthRejected: () => p2p.getStats().authRejectedRequests,
  // Phase M1.4: emit equivocation counter + fork-choice depth gauge so the
  // EquivocationDetected and ForkDetected alert rules in
  // ops/alerts/prometheus-rules.yml have a real series to evaluate.
  getEquivocationsTotal: bftCoordinator ? () => bftCoordinator!.getEquivocationsTotal() : undefined,
  getForkChoiceMaxDepth: () => consensus.getForkChoiceMaxDepth(),
}, { port: metricsPort, bind: metricsBind })

// Graceful shutdown — shared by SIGINT and SIGTERM
let shuttingDown = false
async function shutdown(signal: string) {
  if (shuttingDown) return
  shuttingDown = true
  log.info(`received ${signal}, shutting down...`)
  consensus.stop()
  metricsHandle.stop()
  wsServer.stop()
  if (wireServer) wireServer.stop()
  for (const client of wireClients) client.disconnect()
  if (dhtNetwork) dhtNetwork.stop()
  if (ipfsRepairLoop) ipfsRepairLoop.stop()
  await p2p.stop()
  pubsub.stop()
  await ipfs.stop()
  clearInterval(poseCleanupTimer)
  if (poseCompactTimer) clearInterval(poseCompactTimer)
  // Allow in-flight block production/sync to drain before closing DB
  await new Promise((resolve) => setTimeout(resolve, 500))
  const closeable = chain as PersistentChainEngine
  if (typeof closeable.close === "function") {
    await closeable.close()
  }
  // Close the separate state trie LevelDB (not covered by PersistentChainEngine.close)
  if (stateDb) {
    try { await stateDb.close() } catch { /* best-effort */ }
  }
  log.info("shutdown complete")
  process.exit(0)
}
process.on("SIGINT", () => shutdown("SIGINT"))
process.on("SIGTERM", () => shutdown("SIGTERM"))

function resolvePoseChallengerDynamicResolver(
  config: Awaited<ReturnType<typeof loadNodeConfig>>,
  chain: IChainEngine,
): ((senderId: string) => Promise<boolean>) | undefined {
  if (config.poseUseOnchainChallengerAuth) {
    try {
      return createOnchainOperatorResolver({
        rpcUrl: config.poseOnchainAuthRpcUrl,
        poseManagerAddress: config.poseOnchainAuthPoseManagerAddress,
        minOperatorNodes: config.poseOnchainAuthMinOperatorNodes,
        timeoutMs: config.poseOnchainAuthTimeoutMs,
      })
    } catch (error) {
      log.error("failed to initialize on-chain challenger authorizer; using deny-all fallback", {
        error: String(error),
      })
      return async () => false
    }
  }

  if (config.poseUseGovernanceChallengerAuth) {
    return async (senderId) => {
      if (!hasGovernance(chain)) return false
      const senderLower = senderId.toLowerCase()
      const activeValidators = chain.governance.getActiveValidators()
      return activeValidators.some((v) =>
        v.active && (
          v.id.toLowerCase() === senderLower ||
          v.address.toLowerCase() === senderLower
        ),
      )
    }
  }

  return undefined
}
