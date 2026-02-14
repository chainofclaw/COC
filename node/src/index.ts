import { parseEther, Wallet } from "ethers"
import { loadNodeConfig } from "./config.ts"
import { startRpcServer } from "./rpc.ts"
import { EvmChain } from "./evm.ts"
import { PoSeEngine } from "./pose-engine.ts"
import { ChainEngine } from "./chain-engine.ts"
import { PersistentChainEngine } from "./chain-engine-persistent.ts"
import type { IChainEngine } from "./chain-engine-types.ts"
import { P2PNode } from "./p2p.ts"
import { ConsensusEngine } from "./consensus.ts"
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

const log = createLogger("node")

const config = await loadNodeConfig()
const evm = await EvmChain.create(config.chainId)

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

if (usePersistent) {
  const persistentEngine = new PersistentChainEngine(
    {
      dataDir: config.dataDir,
      nodeId: config.nodeId,
      validators: config.validators,
      finalityDepth: config.finalityDepth,
      maxTxPerBlock: config.maxTxPerBlock,
      minGasPriceWei: BigInt(config.minGasPriceWei),
      prefundAccounts: prefund,
    },
    evm,
  )
  await persistentEngine.init()
  chain = persistentEngine
  log.info("using persistent storage backend (LevelDB)")
} else {
  await evm.prefund(prefund)
  const memoryEngine = new ChainEngine(
    {
      dataDir: config.dataDir,
      nodeId: config.nodeId,
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

const p2p = new P2PNode(
  {
    bind: config.p2pBind,
    port: config.p2pPort,
    peers: config.peers,
  },
  {
    onTx: async (rawTx) => {
      try {
        await chain.addRawTx(rawTx)
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
  },
)
p2p.start()

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
ipfs.start()

const consensus = new ConsensusEngine(chain, p2p, {
  blockTimeMs: config.blockTimeMs,
  syncIntervalMs: config.syncIntervalMs,
})
consensus.start()

const nodePrivateKey = process.env.COC_NODE_PK || Wallet.createRandom().privateKey
const nodeSigner = createNodeSigner(nodePrivateKey)
const pose = new PoSeEngine(BigInt(Math.floor(Date.now() / config.poseEpochMs)), { signer: nodeSigner })

startRpcServer(config.rpcBind, config.rpcPort, config.chainId, evm, chain, p2p, pose)

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

// Graceful shutdown
process.on("SIGINT", async () => {
  log.info("shutting down...")
  wsServer.stop()
  const closeable = chain as PersistentChainEngine
  if (typeof closeable.close === "function") {
    await closeable.close()
  }
  process.exit(0)
})
