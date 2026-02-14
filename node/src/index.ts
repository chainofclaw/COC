import { parseEther, Wallet } from "ethers"
import { loadNodeConfig } from "./config.ts"
import { startRpcServer } from "./rpc.ts"
import { EvmChain } from "./evm.ts"
import { PoSeEngine } from "./pose-engine.ts"
import { ChainEngine } from "./chain-engine.ts"
import { P2PNode } from "./p2p.ts"
import { ConsensusEngine } from "./consensus.ts"
import { IpfsBlockstore } from "./ipfs-blockstore.ts"
import { UnixFsBuilder } from "./ipfs-unixfs.ts"
import { IpfsHttpServer } from "./ipfs-http.ts"
import { createNodeSigner } from "./crypto/signer.ts"
import { registerPoseRoutes } from "./pose-http.ts"

const config = await loadNodeConfig()
const evm = await EvmChain.create(config.chainId)

const prefund = (config.prefund || []).map((entry) => ({
  address: entry.address,
  balanceWei: parseEther(entry.balanceEth).toString(),
}))

await evm.prefund(prefund)

const chain = new ChainEngine(
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
await chain.init()

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
    onSnapshotRequest: () => chain.makeSnapshot(),
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
