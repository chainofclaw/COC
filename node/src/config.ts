import { readFile, mkdir } from "node:fs/promises"
import { join } from "node:path"
import { homedir } from "node:os"

export interface StorageConfig {
  backend: "memory" | "leveldb"
  leveldbDir: string
  cacheSize: number // LRU cache entries
  enablePruning: boolean
  nonceRetentionDays: number
}

export interface NodeConfig {
  dataDir: string
  nodeId: string
  chainId: number
  rpcBind: string
  rpcPort: number
  wsBind: string
  wsPort: number
  ipfsBind: string
  ipfsPort: number
  storageDir: string
  storage: StorageConfig
  p2pBind: string
  p2pPort: number
  peers: Array<{ id: string; url: string }>
  validators: string[]
  blockTimeMs: number
  syncIntervalMs: number
  finalityDepth: number
  maxTxPerBlock: number
  minGasPriceWei: string
  prefund: Array<{ address: string; balanceEth: string }>
  poseEpochMs: number
}

export async function loadNodeConfig(): Promise<NodeConfig> {
  const dataDir = resolveDataDir()
  await mkdir(dataDir, { recursive: true })
  const configPath = process.env.COC_NODE_CONFIG || join(dataDir, "node-config.json")

  let user = {}
  try {
    const raw = await readFile(configPath, "utf-8")
    user = JSON.parse(raw)
  } catch {
    user = {}
  }

  const storageDefaults: StorageConfig = {
    backend: "leveldb",
    leveldbDir: join(dataDir, "leveldb"),
    cacheSize: 1000,
    enablePruning: false,
    nonceRetentionDays: 7,
  }

  const userStorage = (user as Record<string, unknown>).storage as Partial<StorageConfig> | undefined

  return {
    dataDir,
    nodeId: "node-1",
    chainId: 18780,
    rpcBind: "127.0.0.1",
    rpcPort: 18780,
    wsBind: "127.0.0.1",
    wsPort: 18781,
    ipfsBind: "127.0.0.1",
    ipfsPort: 5001,
    storageDir: join(dataDir, "storage"),
    storage: { ...storageDefaults, ...userStorage },
    p2pBind: "127.0.0.1",
    p2pPort: 19780,
    peers: [],
    validators: ["node-1"],
    blockTimeMs: 3000,
    syncIntervalMs: 5000,
    finalityDepth: 3,
    maxTxPerBlock: 50,
    minGasPriceWei: "1",
    prefund: [
      { address: "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266", balanceEth: "10000" }
    ],
    poseEpochMs: 60 * 60 * 1000,
    ...user,
    storage: { ...storageDefaults, ...userStorage },
  }
}

function resolveDataDir(): string {
  const raw = process.env.COC_DATA_DIR || `${homedir()}/.clawdbot/coc`
  if (raw.startsWith("~/")) {
    return join(homedir(), raw.slice(2))
  }
  return raw
}
