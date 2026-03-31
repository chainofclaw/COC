import { z } from "zod"

export const CocBackupConfigSchema = z.object({
  enabled: z.boolean().default(true).describe("Enable COC soul backup extension"),
  rpcUrl: z.string().default("http://127.0.0.1:18780").describe("COC chain RPC URL"),
  ipfsUrl: z.string().default("http://127.0.0.1:18790").describe("COC IPFS API URL"),
  contractAddress: z.string().regex(/^0x[0-9a-fA-F]{40}$/, "Must be a valid Ethereum address (0x + 40 hex chars)").describe("SoulRegistry contract address"),
  privateKey: z.string().regex(/^(0x)?[0-9a-fA-F]{64}$/, "Must be a valid hex private key (64 hex chars)").describe("Ethereum private key for signing"),
  dataDir: z.string().default("~/.openclaw").describe("OpenClaw data directory to back up"),
  autoBackupEnabled: z.boolean().default(true).describe("Enable automatic periodic backups"),
  autoBackupIntervalMs: z.number().default(3600000).describe("Auto-backup interval (default 1 hour)"),
  encryptMemory: z.boolean().default(false).describe("Encrypt memory files (MEMORY.md, daily logs)"),
  encryptionPassword: z.string().optional().describe("Password for encryption KDF (overrides privateKey-derived key)"),
  maxIncrementalChain: z.number().int().min(1).default(10).describe("Max incremental backups before forcing full backup"),
  backupOnSessionEnd: z.boolean().default(true).describe("Trigger backup when agent session ends"),
  categories: z.object({
    identity: z.boolean().default(true).describe("Backup identity files (IDENTITY.md, SOUL.md)"),
    config: z.boolean().default(true).describe("Backup config files (auth.json, device.json)"),
    memory: z.boolean().default(true).describe("Backup memory files"),
    chat: z.boolean().default(true).describe("Backup chat history"),
    workspace: z.boolean().default(true).describe("Backup workspace state"),
  }).default({ identity: true, config: true, memory: true, chat: true, workspace: true }),
})

export type CocBackupConfig = z.infer<typeof CocBackupConfigSchema>
