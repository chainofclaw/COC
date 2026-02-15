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
  // P2P peer discovery
  dnsSeeds: string[]
  peerStorePath: string
  peerMaxAgeMs: number
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
    dnsSeeds: [],
    peerStorePath: join(dataDir, "peers.json"),
    peerMaxAgeMs: 7 * 24 * 60 * 60 * 1000,
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

/**
 * Validate a node config object. Returns an array of error messages (empty = valid).
 */
export function validateConfig(cfg: Partial<NodeConfig>): string[] {
  const errors: string[] = []

  if (cfg.chainId !== undefined) {
    if (!Number.isInteger(cfg.chainId) || cfg.chainId < 1) {
      errors.push("chainId must be a positive integer")
    }
  }

  if (cfg.rpcPort !== undefined) {
    if (!Number.isInteger(cfg.rpcPort) || cfg.rpcPort < 1 || cfg.rpcPort > 65535) {
      errors.push("rpcPort must be between 1 and 65535")
    }
  }

  if (cfg.wsPort !== undefined) {
    if (!Number.isInteger(cfg.wsPort) || cfg.wsPort < 1 || cfg.wsPort > 65535) {
      errors.push("wsPort must be between 1 and 65535")
    }
  }

  if (cfg.p2pPort !== undefined) {
    if (!Number.isInteger(cfg.p2pPort) || cfg.p2pPort < 1 || cfg.p2pPort > 65535) {
      errors.push("p2pPort must be between 1 and 65535")
    }
  }

  if (cfg.ipfsPort !== undefined) {
    if (!Number.isInteger(cfg.ipfsPort) || cfg.ipfsPort < 1 || cfg.ipfsPort > 65535) {
      errors.push("ipfsPort must be between 1 and 65535")
    }
  }

  if (cfg.blockTimeMs !== undefined) {
    if (!Number.isInteger(cfg.blockTimeMs) || cfg.blockTimeMs < 100) {
      errors.push("blockTimeMs must be >= 100")
    }
  }

  if (cfg.syncIntervalMs !== undefined) {
    if (!Number.isInteger(cfg.syncIntervalMs) || cfg.syncIntervalMs < 100) {
      errors.push("syncIntervalMs must be >= 100")
    }
  }

  if (cfg.finalityDepth !== undefined) {
    if (!Number.isInteger(cfg.finalityDepth) || cfg.finalityDepth < 1) {
      errors.push("finalityDepth must be a positive integer")
    }
  }

  if (cfg.maxTxPerBlock !== undefined) {
    if (!Number.isInteger(cfg.maxTxPerBlock) || cfg.maxTxPerBlock < 1) {
      errors.push("maxTxPerBlock must be a positive integer")
    }
  }

  if (cfg.validators !== undefined) {
    if (!Array.isArray(cfg.validators) || cfg.validators.length === 0) {
      errors.push("validators must be a non-empty array")
    }
  }

  if (cfg.prefund !== undefined) {
    if (!Array.isArray(cfg.prefund)) {
      errors.push("prefund must be an array")
    } else {
      for (const entry of cfg.prefund) {
        if (!entry.address || !entry.address.startsWith("0x")) {
          errors.push(`prefund address invalid: ${entry.address}`)
        }
      }
    }
  }

  if (cfg.storage !== undefined) {
    if (cfg.storage.backend && cfg.storage.backend !== "memory" && cfg.storage.backend !== "leveldb") {
      errors.push("storage.backend must be 'memory' or 'leveldb'")
    }
    if (cfg.storage.cacheSize !== undefined && cfg.storage.cacheSize < 0) {
      errors.push("storage.cacheSize must be >= 0")
    }
    if (cfg.storage.nonceRetentionDays !== undefined && cfg.storage.nonceRetentionDays < 1) {
      errors.push("storage.nonceRetentionDays must be >= 1")
    }
  }

  return errors
}
