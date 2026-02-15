import { readFile, writeFile, mkdir } from "node:fs/promises"
import { join } from "node:path"
import { homedir } from "node:os"
import crypto from "node:crypto"

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
  poseMaxChallengesPerEpoch: number
  poseNonceRegistryPath: string
  poseNonceRegistryTtlMs: number
  poseNonceRegistryMaxEntries: number
  // P2P peer discovery
  dnsSeeds: string[]
  peerStorePath: string
  peerMaxAgeMs: number
  p2pMaxPeers: number
  p2pMaxDiscoveredPerBatch: number
  p2pRateLimitWindowMs: number
  p2pRateLimitMaxRequests: number
  p2pRequireInboundAuth: boolean
  p2pInboundAuthMode: "off" | "monitor" | "enforce"
  p2pAuthMaxClockSkewMs: number
  p2pAuthNonceRegistryPath: string
  p2pAuthNonceTtlMs: number
  p2pAuthNonceMaxEntries: number
  poseRequireInboundAuth: boolean
  poseInboundAuthMode: "off" | "monitor" | "enforce"
  poseAuthMaxClockSkewMs: number
  poseAuthNonceRegistryPath: string
  poseAuthNonceTtlMs: number
  poseAuthNonceMaxEntries: number
  poseAllowedChallengers: string[]
  // BFT consensus
  enableBft: boolean
  bftPrepareTimeoutMs: number
  bftCommitTimeoutMs: number
  // Wire protocol (TCP transport)
  enableWireProtocol: boolean
  wirePort: number
  // DHT peer discovery
  enableDht: boolean
  dhtBootstrapPeers: Array<{ id: string; address: string; port: number }>
  // State snapshot sync
  enableSnapSync: boolean
  snapSyncThreshold: number
  // Node identity key (hex private key for signing)
  nodePrivateKey?: string
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
  const userPoseNonceRegistryPath = typeof (user as Record<string, unknown>).poseNonceRegistryPath === "string"
    ? ((user as Record<string, unknown>).poseNonceRegistryPath as string)
    : undefined
  const poseNonceRegistryPath = process.env.COC_POSE_NONCE_REGISTRY_PATH
    || userPoseNonceRegistryPath
    || join(dataDir, "pose-nonce-registry.log")
  const poseNonceRegistryTtlMsEnv = process.env.COC_POSE_NONCE_REGISTRY_TTL_MS
  const poseNonceRegistryTtlMs = poseNonceRegistryTtlMsEnv !== undefined
    ? Number(poseNonceRegistryTtlMsEnv)
    : Number((user as Record<string, unknown>).poseNonceRegistryTtlMs ?? (7 * 24 * 60 * 60 * 1000))
  const poseNonceRegistryMaxEntriesEnv = process.env.COC_POSE_NONCE_REGISTRY_MAX_ENTRIES
  const poseNonceRegistryMaxEntries = poseNonceRegistryMaxEntriesEnv !== undefined
    ? Number(poseNonceRegistryMaxEntriesEnv)
    : Number((user as Record<string, unknown>).poseNonceRegistryMaxEntries ?? 500_000)
  const p2pRequireInboundAuthEnv = process.env.COC_P2P_REQUIRE_INBOUND_AUTH
  const p2pRequireInboundAuthFromEnv = p2pRequireInboundAuthEnv !== undefined
    ? (p2pRequireInboundAuthEnv === "1" || p2pRequireInboundAuthEnv.toLowerCase() === "true")
    : undefined
  const userRequireInboundAuthRaw = (user as Record<string, unknown>).p2pRequireInboundAuth
  const p2pRequireInboundAuthFromUser = typeof userRequireInboundAuthRaw === "boolean"
    ? userRequireInboundAuthRaw
    : undefined

  const p2pInboundAuthModeEnv = process.env.COC_P2P_AUTH_MODE
  const p2pInboundAuthModeRaw = p2pInboundAuthModeEnv
    ?? (user as Record<string, unknown>).p2pInboundAuthMode
  const p2pInboundAuthMode = normalizeInboundAuthMode(p2pInboundAuthModeRaw)
    ?? (p2pRequireInboundAuthFromEnv !== undefined
      ? (p2pRequireInboundAuthFromEnv ? "enforce" : "off")
      : p2pRequireInboundAuthFromUser !== undefined
        ? (p2pRequireInboundAuthFromUser ? "enforce" : "off")
        : "enforce")
  const p2pRequireInboundAuth = p2pInboundAuthMode === "enforce"
  const p2pAuthMaxClockSkewMsEnv = process.env.COC_P2P_AUTH_MAX_CLOCK_SKEW_MS
  const p2pAuthMaxClockSkewMs = p2pAuthMaxClockSkewMsEnv !== undefined
    ? Number(p2pAuthMaxClockSkewMsEnv)
    : Number((user as Record<string, unknown>).p2pAuthMaxClockSkewMs ?? 120_000)
  const userP2PAuthNonceRegistryPath = typeof (user as Record<string, unknown>).p2pAuthNonceRegistryPath === "string"
    ? ((user as Record<string, unknown>).p2pAuthNonceRegistryPath as string)
    : undefined
  const p2pAuthNonceRegistryPath = process.env.COC_P2P_AUTH_NONCE_REGISTRY_PATH
    || userP2PAuthNonceRegistryPath
    || join(dataDir, "p2p-auth-nonce.log")
  const p2pAuthNonceTtlMsEnv = process.env.COC_P2P_AUTH_NONCE_TTL_MS
  const p2pAuthNonceTtlMs = p2pAuthNonceTtlMsEnv !== undefined
    ? Number(p2pAuthNonceTtlMsEnv)
    : Number((user as Record<string, unknown>).p2pAuthNonceTtlMs ?? (24 * 60 * 60 * 1000))
  const p2pAuthNonceMaxEntriesEnv = process.env.COC_P2P_AUTH_NONCE_MAX_ENTRIES
  const p2pAuthNonceMaxEntries = p2pAuthNonceMaxEntriesEnv !== undefined
    ? Number(p2pAuthNonceMaxEntriesEnv)
    : Number((user as Record<string, unknown>).p2pAuthNonceMaxEntries ?? 100_000)
  const poseRequireInboundAuthEnv = process.env.COC_POSE_REQUIRE_INBOUND_AUTH
  const poseRequireInboundAuthFromEnv = poseRequireInboundAuthEnv !== undefined
    ? (poseRequireInboundAuthEnv === "1" || poseRequireInboundAuthEnv.toLowerCase() === "true")
    : undefined
  const userPoseRequireInboundAuthRaw = (user as Record<string, unknown>).poseRequireInboundAuth
  const poseRequireInboundAuthFromUser = typeof userPoseRequireInboundAuthRaw === "boolean"
    ? userPoseRequireInboundAuthRaw
    : undefined
  const poseInboundAuthModeEnv = process.env.COC_POSE_AUTH_MODE
  const poseInboundAuthModeRaw = poseInboundAuthModeEnv
    ?? (user as Record<string, unknown>).poseInboundAuthMode
  const poseInboundAuthMode = normalizeInboundAuthMode(poseInboundAuthModeRaw)
    ?? (poseRequireInboundAuthFromEnv !== undefined
      ? (poseRequireInboundAuthFromEnv ? "enforce" : "off")
      : poseRequireInboundAuthFromUser !== undefined
        ? (poseRequireInboundAuthFromUser ? "enforce" : "off")
        : "enforce")
  const poseRequireInboundAuth = poseInboundAuthMode === "enforce"
  const poseAuthMaxClockSkewMsEnv = process.env.COC_POSE_AUTH_MAX_CLOCK_SKEW_MS
  const poseAuthMaxClockSkewMs = poseAuthMaxClockSkewMsEnv !== undefined
    ? Number(poseAuthMaxClockSkewMsEnv)
    : Number((user as Record<string, unknown>).poseAuthMaxClockSkewMs ?? 120_000)
  const userPoseAuthNonceRegistryPath = typeof (user as Record<string, unknown>).poseAuthNonceRegistryPath === "string"
    ? ((user as Record<string, unknown>).poseAuthNonceRegistryPath as string)
    : undefined
  const poseAuthNonceRegistryPath = process.env.COC_POSE_AUTH_NONCE_REGISTRY_PATH
    || userPoseAuthNonceRegistryPath
    || join(dataDir, "pose-auth-nonce.log")
  const poseAuthNonceTtlMsEnv = process.env.COC_POSE_AUTH_NONCE_TTL_MS
  const poseAuthNonceTtlMs = poseAuthNonceTtlMsEnv !== undefined
    ? Number(poseAuthNonceTtlMsEnv)
    : Number((user as Record<string, unknown>).poseAuthNonceTtlMs ?? (24 * 60 * 60 * 1000))
  const poseAuthNonceMaxEntriesEnv = process.env.COC_POSE_AUTH_NONCE_MAX_ENTRIES
  const poseAuthNonceMaxEntries = poseAuthNonceMaxEntriesEnv !== undefined
    ? Number(poseAuthNonceMaxEntriesEnv)
    : Number((user as Record<string, unknown>).poseAuthNonceMaxEntries ?? 100_000)
  const userPoseAllowedChallengers = (user as Record<string, unknown>).poseAllowedChallengers
  const poseAllowedChallengersFromUser = Array.isArray(userPoseAllowedChallengers)
    ? userPoseAllowedChallengers.filter((x): x is string => typeof x === "string")
    : []
  const poseAllowedChallengers = process.env.COC_POSE_ALLOWED_CHALLENGERS
    ? process.env.COC_POSE_ALLOWED_CHALLENGERS
      .split(",")
      .map((x) => x.trim())
      .filter((x) => x.length > 0)
    : poseAllowedChallengersFromUser

  // Resolve node private key: env var → file → auto-generate
  const nodePrivateKey = await resolveNodeKey(dataDir)

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
    poseMaxChallengesPerEpoch: 200,
    poseNonceRegistryPath,
    poseNonceRegistryTtlMs,
    poseNonceRegistryMaxEntries,
    dnsSeeds: [],
    peerStorePath: join(dataDir, "peers.json"),
    peerMaxAgeMs: 7 * 24 * 60 * 60 * 1000,
    p2pMaxPeers: 50,
    p2pMaxDiscoveredPerBatch: 200,
    p2pRateLimitWindowMs: 60_000,
    p2pRateLimitMaxRequests: 240,
    p2pRequireInboundAuth,
    p2pInboundAuthMode,
    p2pAuthMaxClockSkewMs,
    p2pAuthNonceRegistryPath,
    p2pAuthNonceTtlMs,
    p2pAuthNonceMaxEntries,
    poseRequireInboundAuth,
    poseInboundAuthMode,
    poseAuthMaxClockSkewMs,
    poseAuthNonceRegistryPath,
    poseAuthNonceTtlMs,
    poseAuthNonceMaxEntries,
    poseAllowedChallengers,
    enableBft: false,
    bftPrepareTimeoutMs: 5000,
    bftCommitTimeoutMs: 5000,
    enableWireProtocol: false,
    wirePort: 19781,
    enableDht: false,
    dhtBootstrapPeers: [],
    enableSnapSync: false,
    snapSyncThreshold: 100,
    nodePrivateKey,
    ...user,
    poseNonceRegistryPath,
    poseNonceRegistryTtlMs,
    poseNonceRegistryMaxEntries,
    p2pRequireInboundAuth,
    p2pInboundAuthMode,
    p2pAuthMaxClockSkewMs,
    p2pAuthNonceRegistryPath,
    p2pAuthNonceTtlMs,
    p2pAuthNonceMaxEntries,
    poseRequireInboundAuth,
    poseInboundAuthMode,
    poseAuthMaxClockSkewMs,
    poseAuthNonceRegistryPath,
    poseAuthNonceTtlMs,
    poseAuthNonceMaxEntries,
    poseAllowedChallengers,
    storage: { ...storageDefaults, ...userStorage },
  }
}

function normalizeInboundAuthMode(input: unknown): "off" | "monitor" | "enforce" | undefined {
  if (typeof input !== "string") return undefined
  const v = input.trim().toLowerCase()
  if (v === "off" || v === "monitor" || v === "enforce") {
    return v
  }
  return undefined
}

async function resolveNodeKey(dataDir: string): Promise<string> {
  // Priority 1: environment variable
  if (process.env.COC_NODE_KEY) return process.env.COC_NODE_KEY

  // Priority 2: file on disk
  const keyPath = join(dataDir, "node-key")
  try {
    const key = (await readFile(keyPath, "utf-8")).trim()
    if (key.startsWith("0x") && key.length === 66) return key
  } catch {
    // file doesn't exist, generate
  }

  // Priority 3: auto-generate and persist
  const key = "0x" + crypto.randomBytes(32).toString("hex")
  await mkdir(dataDir, { recursive: true })
  await writeFile(keyPath, key + "\n", { mode: 0o600 })
  return key
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

  if (cfg.p2pMaxPeers !== undefined) {
    if (!Number.isInteger(cfg.p2pMaxPeers) || cfg.p2pMaxPeers < 1) {
      errors.push("p2pMaxPeers must be a positive integer")
    }
  }

  if (cfg.p2pMaxDiscoveredPerBatch !== undefined) {
    if (!Number.isInteger(cfg.p2pMaxDiscoveredPerBatch) || cfg.p2pMaxDiscoveredPerBatch < 1) {
      errors.push("p2pMaxDiscoveredPerBatch must be a positive integer")
    }
  }

  if (cfg.p2pRateLimitWindowMs !== undefined) {
    if (!Number.isInteger(cfg.p2pRateLimitWindowMs) || cfg.p2pRateLimitWindowMs < 100) {
      errors.push("p2pRateLimitWindowMs must be >= 100")
    }
  }

  if (cfg.p2pRateLimitMaxRequests !== undefined) {
    if (!Number.isInteger(cfg.p2pRateLimitMaxRequests) || cfg.p2pRateLimitMaxRequests < 1) {
      errors.push("p2pRateLimitMaxRequests must be a positive integer")
    }
  }

  if (cfg.p2pRequireInboundAuth !== undefined && typeof cfg.p2pRequireInboundAuth !== "boolean") {
    errors.push("p2pRequireInboundAuth must be a boolean")
  }

  if (cfg.p2pInboundAuthMode !== undefined) {
    if (cfg.p2pInboundAuthMode !== "off" && cfg.p2pInboundAuthMode !== "monitor" && cfg.p2pInboundAuthMode !== "enforce") {
      errors.push("p2pInboundAuthMode must be one of: off, monitor, enforce")
    }
  }

  if (cfg.p2pAuthMaxClockSkewMs !== undefined) {
    if (!Number.isInteger(cfg.p2pAuthMaxClockSkewMs) || cfg.p2pAuthMaxClockSkewMs < 1000) {
      errors.push("p2pAuthMaxClockSkewMs must be >= 1000")
    }
  }

  if (cfg.p2pAuthNonceRegistryPath !== undefined) {
    if (typeof cfg.p2pAuthNonceRegistryPath !== "string" || cfg.p2pAuthNonceRegistryPath.trim().length === 0) {
      errors.push("p2pAuthNonceRegistryPath must be a non-empty string")
    }
  }

  if (cfg.p2pAuthNonceTtlMs !== undefined) {
    if (!Number.isInteger(cfg.p2pAuthNonceTtlMs) || cfg.p2pAuthNonceTtlMs < 60_000) {
      errors.push("p2pAuthNonceTtlMs must be >= 60000")
    }
  }

  if (cfg.p2pAuthNonceMaxEntries !== undefined) {
    if (!Number.isInteger(cfg.p2pAuthNonceMaxEntries) || cfg.p2pAuthNonceMaxEntries < 1) {
      errors.push("p2pAuthNonceMaxEntries must be a positive integer")
    }
  }

  if (cfg.poseRequireInboundAuth !== undefined && typeof cfg.poseRequireInboundAuth !== "boolean") {
    errors.push("poseRequireInboundAuth must be a boolean")
  }

  if (cfg.poseInboundAuthMode !== undefined) {
    if (cfg.poseInboundAuthMode !== "off" && cfg.poseInboundAuthMode !== "monitor" && cfg.poseInboundAuthMode !== "enforce") {
      errors.push("poseInboundAuthMode must be one of: off, monitor, enforce")
    }
  }

  if (cfg.poseAuthMaxClockSkewMs !== undefined) {
    if (!Number.isInteger(cfg.poseAuthMaxClockSkewMs) || cfg.poseAuthMaxClockSkewMs < 1000) {
      errors.push("poseAuthMaxClockSkewMs must be >= 1000")
    }
  }

  if (cfg.poseAuthNonceRegistryPath !== undefined) {
    if (typeof cfg.poseAuthNonceRegistryPath !== "string" || cfg.poseAuthNonceRegistryPath.trim().length === 0) {
      errors.push("poseAuthNonceRegistryPath must be a non-empty string")
    }
  }

  if (cfg.poseAuthNonceTtlMs !== undefined) {
    if (!Number.isInteger(cfg.poseAuthNonceTtlMs) || cfg.poseAuthNonceTtlMs < 60_000) {
      errors.push("poseAuthNonceTtlMs must be >= 60000")
    }
  }

  if (cfg.poseAuthNonceMaxEntries !== undefined) {
    if (!Number.isInteger(cfg.poseAuthNonceMaxEntries) || cfg.poseAuthNonceMaxEntries < 1) {
      errors.push("poseAuthNonceMaxEntries must be a positive integer")
    }
  }

  if (cfg.poseAllowedChallengers !== undefined) {
    if (!Array.isArray(cfg.poseAllowedChallengers)) {
      errors.push("poseAllowedChallengers must be an array")
    } else {
      const addrRe = /^0x[0-9a-fA-F]{40}$/
      for (const challenger of cfg.poseAllowedChallengers) {
        if (typeof challenger !== "string" || !addrRe.test(challenger)) {
          errors.push(`poseAllowedChallengers contains invalid address: ${String(challenger)}`)
        }
      }
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

  if (cfg.poseMaxChallengesPerEpoch !== undefined) {
    if (!Number.isInteger(cfg.poseMaxChallengesPerEpoch) || cfg.poseMaxChallengesPerEpoch < 1) {
      errors.push("poseMaxChallengesPerEpoch must be a positive integer")
    }
  }

  if (cfg.poseNonceRegistryPath !== undefined) {
    if (typeof cfg.poseNonceRegistryPath !== "string" || cfg.poseNonceRegistryPath.trim().length === 0) {
      errors.push("poseNonceRegistryPath must be a non-empty string")
    }
  }

  if (cfg.poseNonceRegistryTtlMs !== undefined) {
    if (!Number.isInteger(cfg.poseNonceRegistryTtlMs) || cfg.poseNonceRegistryTtlMs < 60_000) {
      errors.push("poseNonceRegistryTtlMs must be >= 60000")
    }
  }

  if (cfg.poseNonceRegistryMaxEntries !== undefined) {
    if (!Number.isInteger(cfg.poseNonceRegistryMaxEntries) || cfg.poseNonceRegistryMaxEntries < 1) {
      errors.push("poseNonceRegistryMaxEntries must be a positive integer")
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
