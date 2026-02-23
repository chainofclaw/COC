import { parseEther, Wallet } from "ethers"
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
import type { BftMessagePayload } from "./p2p.ts"
import { ConsensusEngine } from "./consensus.ts"
import type { SnapSyncProvider } from "./consensus.ts"
import { IpfsBlockstore } from "./ipfs-blockstore.ts"
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
import { BftCoordinator } from "./bft-coordinator.ts"
import type { BftMessage } from "./bft.ts"
import { WireServer } from "./wire-server.ts"
import { WireClient } from "./wire-client.ts"
import { MessageType, encodeJsonPayload } from "./wire-protocol.ts"
import { DhtNetwork } from "./dht-network.ts"
import { exportStateSnapshot, importStateSnapshot } from "./state-snapshot.ts"
import type { StateSnapshot } from "./state-snapshot.ts"
import type { IStateTrie } from "./storage/state-trie.ts"
import { startMetricsServer } from "./metrics-server.ts"
import { metrics } from "./metrics.ts"

const log = createLogger("node")

const config = await loadNodeConfig()

const prefund = (config.prefund || []).map((entry) => ({
  address: entry.address,
  balanceWei: parseEther(entry.balanceEth).toString(),
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

if (usePersistent) {
  // Create persistent state trie backed by LevelDB
  const stateDb = new LevelDatabase(config.dataDir, "state")
  await stateDb.open()
  const trie = new PersistentStateTrie(stateDb)
  await trie.init()
  stateTrie = trie

  // Create state manager adapter and pass to EVM
  const stateManager = new PersistentStateManager(trie)
  evm = await EvmChain.create(config.chainId, stateManager)

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
    },
    evm,
  )
  await persistentEngine.init()
  chain = persistentEngine
  log.info("using persistent storage backend (LevelDB) with EVM state persistence")
} else {
  evm = await EvmChain.create(config.chainId)
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
    },
    evm,
  )
  await memoryEngine.init()
  chain = memoryEngine
  log.info("using memory storage backend")
}

// Node identity signer — created early so Wire/BFT/PoSe all share the same key
const nodePrivateKey = config.nodePrivateKey ?? process.env.COC_NODE_PK ?? Wallet.createRandom().privateKey
const nodeSigner = createNodeSigner(nodePrivateKey)

// Attach signer to chain engine for block proposer signatures
if (typeof (chain as PersistentChainEngine).setNodeSigner === "function") {
  (chain as PersistentChainEngine).setNodeSigner(nodeSigner, nodeSigner)
} else if (typeof (chain as ChainEngine).setNodeSigner === "function") {
  (chain as ChainEngine).setNodeSigner(nodeSigner, nodeSigner)
}

// BFT coordinator setup
let bftCoordinator: BftCoordinator | undefined
const bftEnabled = config.enableBft && config.validators.length >= 3

// State snapshot export cache (30s TTL, keyed by tip hash)
let cachedStateSnapshot: { snapshot: StateSnapshot; tipHash: Hex; cachedAtMs: number } | null = null
const STATE_SNAPSHOT_CACHE_TTL_MS = 30_000

const p2p = new P2PNode(
  {
    bind: config.p2pBind,
    port: config.p2pPort,
    peers: config.peers,
    nodeId: config.nodeId,
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
      try {
        await chain.applyBlock(block)
      } catch {
        // ignore invalid/duplicate blocks from peers
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
        await bftCoordinator.handleMessage(bftMsg)
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

// BFT equivocation evidence store — persists slash evidence for relayer consumption
const bftEvidencePath = `${config.dataDir}/evidence-bft.jsonl`
const bftEvidenceStore = new EvidenceStore(1000, bftEvidencePath)

// Initialize BFT coordinator after P2P is ready
if (bftEnabled) {
  const validators = config.validators.map((id) => ({
    id,
    stake: 1_000_000_000_000_000_000n, // 1 ETH default stake
  }))

  bftCoordinator = new BftCoordinator({
    localId: config.nodeId,
    validators,
    prepareTimeoutMs: config.bftPrepareTimeoutMs,
    commitTimeoutMs: config.bftCommitTimeoutMs,
    signer: nodeSigner,
    verifier: nodeSigner,
    onEquivocation: (evidence: EquivocationEvidence) => {
      log.warn("BFT equivocation detected", {
        validator: evidence.validatorId,
        height: evidence.height.toString(),
        phase: evidence.phase,
        hash1: evidence.blockHash1,
        hash2: evidence.blockHash2,
      })
      // Persist as SlashEvidence for relayer pickup
      const nodeIdHex = evidence.validatorId.startsWith("0x")
        ? evidence.validatorId.padEnd(66, "0")
        : `0x${evidence.validatorId.padStart(64, "0")}`
      const rawEvidence: Record<string, unknown> = {
        type: "bft-equivocation",
        validatorId: evidence.validatorId,
        height: evidence.height.toString(),
        phase: evidence.phase,
        blockHash1: evidence.blockHash1,
        blockHash2: evidence.blockHash2,
        detectedAtMs: evidence.detectedAtMs,
      }
      const evidenceJson = JSON.stringify(rawEvidence)
      const evidenceHash = `0x${Buffer.from(evidenceJson).toString("hex").slice(0, 64).padEnd(64, "0")}` as `0x${string}`
      bftEvidenceStore.push({
        nodeId: nodeIdHex as `0x${string}`,
        reasonCode: 6, // BFT equivocation (new reason code beyond existing 1-5)
        evidenceHash,
        rawEvidence,
      })
    },
    broadcastMessage: async (msg: BftMessage) => {
      await p2p.broadcastBft({
        type: msg.type,
        height: msg.height.toString(),
        blockHash: msg.blockHash,
        senderId: msg.senderId,
        signature: msg.signature,
      })
      // Also broadcast BFT messages via wire protocol (dual transport)
      wireBftBroadcastFn?.(msg)
    },
    onFinalized: async (block) => {
      const finalizedBlock = { ...block, bftFinalized: true }
      try {
        await chain.applyBlock(finalizedBlock)
      } catch {
        // block may already be applied during propose — persist bftFinalized flag
        const persistentEngine = chain as { blockIndex?: { getBlockByHash(h: string): Promise<ChainBlock | null>; updateBlock(b: ChainBlock): Promise<void> } }
        if (persistentEngine.blockIndex) {
          try {
            const existing = await persistentEngine.blockIndex.getBlockByHash(block.hash)
            if (existing && !existing.bftFinalized) {
              existing.bftFinalized = true
              await persistentEngine.blockIndex.updateBlock(existing)
            }
          } catch {
            // best-effort finality persistence
          }
        }
      }
      // Only broadcast if block exists locally (avoid ghost block relay)
      const localBlock = await chain.getBlockByHash(block.hash).catch(() => null)
      if (localBlock) {
        try {
          await p2p.receiveBlock({ ...localBlock, bftFinalized: true })
        } catch {
          // broadcast best-effort
        }
      }
      log.info("BFT finalized block", { height: block.number.toString(), hash: block.hash })
      // Sync BFT validator set with governance after each finalized block
      if (hasGovernance(chain)) {
        const active = chain.governance.getActiveValidators()
        bftCoordinator?.updateValidators(active.map((v) => ({ id: v.id, stake: v.stake })))
      }
    },
  })
  log.info("BFT consensus enabled", { validators: config.validators.length })
}

const ipfsStore = new IpfsBlockstore(config.storageDir)
await ipfsStore.init()
const unixfs = new UnixFsBuilder(ipfsStore)
const ipfs = new IpfsHttpServer(
  {
    bind: config.ipfsBind,
    port: config.ipfsPort,
    storageDir: config.storageDir,
    nodeId: config.nodeId,
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
          if (!res.ok) return null
          // Read body with size limit
          const reader = res.body?.getReader()
          if (!reader) return null
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
      } catch {
        return null
      }
    },
    async importStateSnapshot(snapshot: unknown, expectedStateRoot?: string) {
      return await importStateSnapshot(trieRef, snapshot as StateSnapshot, expectedStateRoot)
    },
    async setStateRoot(root: string) {
      if (typeof trieRef.setStateRoot === "function") {
        await trieRef.setStateRoot(root)
      }
    },
    restoreGovernance(validators: Array<{ id: string; address: string; stake: bigint; active: boolean }>) {
      if (hasGovernance(chain) && chain.governance && typeof (chain.governance as { initGenesis?: unknown }).initGenesis === "function") {
        (chain.governance as { initGenesis(v: Array<{ id: string; address: string; stake: bigint }>): void }).initGenesis(validators)
        log.info("governance validators restored from snap sync", { count: validators.length })
      }
      // Sync BFT coordinator validator set with restored governance
      if (bftCoordinator) {
        const activeValidators = validators.filter((v) => v.active)
        bftCoordinator.updateValidators(activeValidators.map((v) => ({ id: v.id, stake: v.stake })))
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
}, {
  bft: bftCoordinator,
  snapSync: snapSyncProvider,
  wireBroadcast: (block) => wireBroadcastFn?.(block),
})
consensus.start()

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
setInterval(() => poseAuthNonceTracker.cleanup(), 300_000).unref()
if (config.poseAuthNonceRegistryPath) {
  setInterval(() => poseAuthNonceTracker.compact(), 60 * 60 * 1000).unref()
}
const poseChallengerDynamicResolver = resolvePoseChallengerDynamicResolver(config, chain)
const poseChallengerAuthorizer = poseChallengerDynamicResolver
  ? createPoseChallengerAuthorizer({
      staticAllowlist: config.poseAllowedChallengers,
      cacheTtlMs: config.poseChallengerAuthCacheTtlMs,
      failOpen: config.poseOnchainAuthFailOpen,
      dynamicResolver: poseChallengerDynamicResolver,
    })
  : undefined

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
  },
  {
    authToken: config.rpcAuthToken,
    enableAdminRpc: config.enableAdminRpc,
  },
)

// Start WebSocket RPC server for real-time subscriptions
const wsServer = startWsRpcServer(
  { port: config.wsPort, bind: config.wsBind, authToken: config.rpcAuthToken },
  config.chainId,
  evm,
  chain,
  p2p,
  chain.events,
  handleRpcMethod,
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
      try {
        await chain.applyBlock(block)
      } catch {
        // ignore
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
    ws.broadcastFrame(encodeJsonPayload(wireType, {
      type: msg.type,
      height: msg.height.toString(),
      blockHash: msg.blockHash,
      senderId: msg.senderId,
      signature: msg.signature,
    }))
  }

  // Build peer ID → wire port mapping from dhtBootstrapPeers config
  const peerWirePortMap = new Map<string, number>()
  for (const bp of config.dhtBootstrapPeers) {
    peerWirePortMap.set(bp.id, bp.port)
  }

  // Connect to known peers via wire protocol
  for (const peer of config.peers) {
    try {
      const url = new URL(peer.url)
      // Use per-peer wire port from DHT bootstrap config, fallback to local wirePort
      const peerWirePort = peerWirePortMap.get(peer.id) ?? config.wirePort
      const client = new WireClient({
        host: url.hostname,
        port: peerWirePort,
        nodeId: config.nodeId,
        chainId: config.chainId,
        signer: nodeSigner,
        verifier: nodeSigner,
        onConnected: () => log.info("wire client connected", { peer: peer.id }),
        onDisconnected: () => log.info("wire client disconnected", { peer: peer.id }),
      })
      client.connect()
      wireClients.push(client)
      wireClientByPeerId.set(peer.id, client)
    } catch {
      log.warn("failed to create wire client for peer", { peer: peer.id })
    }
  }
}

if (config.enableDht) {
  dhtNetwork = new DhtNetwork({
    localId: config.nodeId,
    localAddress: `${config.p2pBind}:${config.wirePort}`,
    chainId: config.chainId,
    bootstrapPeers: config.dhtBootstrapPeers,
    wireClients,
    signer: nodeSigner,
    verifier: nodeSigner,
    requireAuthenticatedVerify: config.dhtRequireAuthenticatedVerify,
    wireClientByPeerId,
    onPeerDiscovered: (peer) => {
      p2p.discovery.addDiscoveredPeers([{ id: peer.id, url: `http://${peer.address}` }])
    },
  })
  dhtNetwork.start()
  log.info("DHT peer discovery started", { bootstrapPeers: config.dhtBootstrapPeers.length })
}

// Prometheus metrics server
const metricsPort = Number(process.env.COC_METRICS_PORT ?? 9100)
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
}, { port: metricsPort })

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
  pubsub.stop()
  // Allow in-flight block production/sync to drain before closing DB
  await new Promise((resolve) => setTimeout(resolve, 500))
  const closeable = chain as PersistentChainEngine
  if (typeof closeable.close === "function") {
    await closeable.close()
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
      const activeValidators = chain.governance.getActiveValidators()
      return activeValidators.some((v) =>
        v.active && (
          v.id.toLowerCase() === senderId ||
          v.address.toLowerCase() === senderId
        ),
      )
    }
  }

  return undefined
}
