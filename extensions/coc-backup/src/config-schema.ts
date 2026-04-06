import { z } from "zod"

export const CocBackupConfigSchema = z.object({
  enabled: z.boolean().default(true).describe("Enable COC soul backup extension"),
  rpcUrl: z.string().default("http://127.0.0.1:18780").describe("COC chain RPC URL"),
  ipfsUrl: z.string().default("http://127.0.0.1:18790").describe("COC IPFS API URL"),
  contractAddress: z.string().regex(/^0x[0-9a-fA-F]{40}$/, "Must be a valid Ethereum address (0x + 40 hex chars)").describe("SoulRegistry contract address"),
  rpcAuthToken: z.string().optional().describe("Bearer token for authenticated RPC (must match node's rpcAuthToken)"),
  privateKey: z.string().regex(/^(0x)?[0-9a-fA-F]{64}$/, "Must be a valid hex private key (64 hex chars)").describe("Ethereum private key for signing"),
  dataDir: z.string().default("~/.openclaw").describe("OpenClaw data directory to back up"),
  autoBackupEnabled: z.boolean().default(true).describe("Enable automatic periodic backups"),
  autoBackupIntervalMs: z.number().default(3600000).describe("Auto-backup interval (default 1 hour)"),
  encryptMemory: z.boolean().default(false).describe("Encrypt memory files (MEMORY.md, daily logs)"),
  encryptionPassword: z.string().optional().describe("Password for encryption KDF (overrides privateKey-derived key)"),
  maxIncrementalChain: z.number().int().min(1).default(10).describe("Max incremental backups before forcing full backup"),
  didRegistryAddress: z.string().regex(/^0x[0-9a-fA-F]{40}$/).optional().describe("DIDRegistry contract address (enables DID CLI commands)"),
  backupOnSessionEnd: z.boolean().default(true).describe("Trigger backup when agent session ends"),
  carrier: z.object({
    enabled: z.boolean().default(false).describe("Enable carrier daemon mode"),
    carrierId: z.string().optional().describe("This carrier's registered ID (bytes32)"),
    agentEntryScript: z.string().optional().describe("Path to OpenClaw entry script"),
    workDir: z.string().default("/tmp/coc-resurrections").describe("Working directory for restored agents"),
    watchedAgents: z.array(z.string()).default([]).describe("Agent IDs to monitor"),
    pendingRequestIds: z.array(z.object({
      requestId: z.string(),
      agentId: z.string(),
    })).default([]).describe("Pre-known pending resurrection requests targeting this carrier"),
    pollIntervalMs: z.number().default(60_000),
    readinessTimeoutMs: z.number().default(86_400_000).describe("Max wait for guardian quorum (24h)"),
    readinessPollMs: z.number().default(30_000),
  }).default({
    enabled: false,
    workDir: "/tmp/coc-resurrections",
    watchedAgents: [],
    pendingRequestIds: [],
    pollIntervalMs: 60_000,
    readinessTimeoutMs: 86_400_000,
    readinessPollMs: 30_000,
  }),
  categories: z.object({
    identity: z.boolean().default(true).describe("Backup identity files (IDENTITY.md, SOUL.md)"),
    config: z.boolean().default(true).describe("Backup config files (auth.json, device.json)"),
    memory: z.boolean().default(true).describe("Backup memory files"),
    chat: z.boolean().default(true).describe("Backup chat history"),
    workspace: z.boolean().default(true).describe("Backup workspace state"),
    database: z.boolean().default(true).describe("Backup database files (SQLite, LanceDB)"),
  }).default({ identity: true, config: true, memory: true, chat: true, workspace: true, database: true }),
})

export type CocBackupConfig = z.infer<typeof CocBackupConfigSchema>
