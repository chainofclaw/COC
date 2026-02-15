import { parseEther, Wallet } from "ethers"
import { loadNodeConfig } from "./config.ts"
import { startRpcServer } from "./rpc.ts"
import { EvmChain } from "./evm.ts"
import { PoSeEngine } from "./pose-engine.ts"
import { ChainEngine } from "./chain-engine.ts"
import { PersistentChainEngine } from "./chain-engine-persistent.ts"
import type { IChainEngine } from "./chain-engine-types.ts"
import { P2PNode } from "./p2p.ts"
import type { BftMessagePayload } from "./p2p.ts"
import { ConsensusEngine } from "./consensus.ts"
import type { SnapSyncProvider } from "./consensus.ts"
import { IpfsBlockstore } from "./ipfs-blockstore.ts"
import { UnixFsBuilder } from "./ipfs-unixfs.ts"
import { IpfsHttpServer } from "./ipfs-http.ts"
import { createNodeSigner } from "./crypto/signer.ts"
import { registerPoseRoutes } from "./pose-http.ts"
import { migrateLegacySnapshot } from "./storage/migrate-legacy.ts"
import { startWsRpcServer } from "./websocket-rpc.ts"
import { handleRpcMethod } from "./rpc.ts"
import { ChainEventEmitter } from "./chain-events.ts"
import { createLogger } from "./logger.ts"
import { LevelDatabase } from "./storage/db.ts"
import { PersistentStateTrie } from "./storage/state-trie.ts"
import { PersistentStateManager } from "./storage/persistent-state-manager.ts"
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

const p2p = new P2PNode(
  {
    bind: config.p2pBind,
    port: config.p2pPort,
    peers: config.peers,
    nodeId: config.nodeId,
    enableDiscovery: true,
    peerStorePath: config.peerStorePath,
    dnsSeeds: config.dnsSeeds,
    peerMaxAgeMs: config.peerMaxAgeMs,
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
    },
    onSnapshotRequest: () => {
      // Legacy snapshot support for in-memory engine
      const snapshotEngine = chain as ChainEngine
      if (typeof snapshotEngine.makeSnapshot === "function") {
        return snapshotEngine.makeSnapshot()
      }
      return { blocks: [], updatedAtMs: Date.now() }
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
        // Export known accounts from state trie
        const addresses = config.prefund.map((p) => p.address)
        return await exportStateSnapshot(stateTrie, addresses, height, tip.hash)
      }
      : undefined,
  },
)
p2p.start()

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
        await chain.applyBlock(finalizedBlock, true)
      } catch {
        // block may already be applied during propose
      }
      try {
        await p2p.receiveBlock(finalizedBlock)
      } catch {
        // broadcast best-effort
      }
      log.info("BFT finalized block", { height: block.number.toString(), hash: block.hash })
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
      try {
        const res = await fetch(`${peerUrl}/p2p/state-snapshot`)
        if (!res.ok) return null
        return await res.json() as StateSnapshot
      } catch {
        return null
      }
    },
    async importStateSnapshot(snapshot: unknown) {
      return await importStateSnapshot(trieRef, snapshot as StateSnapshot)
    },
    async setStateRoot(root: string) {
      if (typeof trieRef.setStateRoot === "function") {
        await trieRef.setStateRoot(root)
      }
    },
  }
}

// Wire broadcast functions — will be bound after wire server setup
let wireBroadcastFn: ((block: ChainBlock) => void) | undefined
let wireTxRelayFn: ((rawTx: Hex) => void) | undefined
let wireBftBroadcastFn: ((msg: BftMessage) => void) | undefined

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

const pose = new PoSeEngine(BigInt(Math.floor(Date.now() / config.poseEpochMs)), { signer: nodeSigner })

startRpcServer(config.rpcBind, config.rpcPort, config.chainId, evm, chain, p2p, pose, undefined, config.nodeId)

// Start WebSocket RPC server for real-time subscriptions
const wsServer = startWsRpcServer(
  { port: config.wsPort, bind: config.wsBind },
  config.chainId,
  evm,
  chain,
  p2p,
  chain.events,
  handleRpcMethod,
)
log.info("WebSocket RPC configured", { bind: config.wsBind, port: config.wsPort })

// Wire protocol TCP transport
let wireServer: WireServer | undefined
const wireClients: WireClient[] = []

if (config.enableWireProtocol) {
  wireServer = new WireServer({
    port: config.wirePort,
    nodeId: config.nodeId,
    chainId: config.chainId,
    signer: nodeSigner,
    verifier: nodeSigner,
    onBlock: async (block) => {
      try {
        await chain.applyBlock(block)
      } catch {
        // ignore
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
    } catch {
      log.warn("failed to create wire client for peer", { peer: peer.id })
    }
  }
}

// DHT peer discovery
let dhtNetwork: DhtNetwork | undefined

if (config.enableDht) {
  // Build peer ID → WireClient map for O(1) lookup in DHT FIND_NODE
  const wireClientByPeerId = new Map<string, WireClient>()
  for (let idx = 0; idx < config.peers.length && idx < wireClients.length; idx++) {
    wireClientByPeerId.set(config.peers[idx].id, wireClients[idx])
  }

  dhtNetwork = new DhtNetwork({
    localId: config.nodeId,
    bootstrapPeers: config.dhtBootstrapPeers,
    wireClients,
    wireClientByPeerId,
    onPeerDiscovered: (peer) => {
      p2p.discovery.addDiscoveredPeers([{ id: peer.id, url: `http://${peer.address}` }])
    },
  })
  dhtNetwork.start()
  log.info("DHT peer discovery started", { bootstrapPeers: config.dhtBootstrapPeers.length })
}

// Graceful shutdown
process.on("SIGINT", async () => {
  log.info("shutting down...")
  wsServer.stop()
  if (wireServer) wireServer.stop()
  for (const client of wireClients) client.disconnect()
  if (dhtNetwork) dhtNetwork.stop()
  const closeable = chain as PersistentChainEngine
  if (typeof closeable.close === "function") {
    await closeable.close()
  }
  process.exit(0)
})
