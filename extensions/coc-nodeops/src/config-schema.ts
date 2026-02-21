import { z } from "zod"

export const NodeEntrySchema = z.object({
  name: z.string(),
  type: z.enum(["validator", "fullnode", "archive", "gateway", "dev"]),
  network: z.string().default("local"),
  dataDir: z.string(),
  services: z.array(z.enum(["node", "agent", "relayer"])).default(["node"]),
  createdAt: z.string(),
})

export const CocConfigSchema = z.object({
  enabled: z.boolean().default(true).describe("Enable COC node ops extension"),
  runtimeDir: z.string().optional().describe("COC runtime scripts directory"),
  dataDir: z.string().default("~/.clawdbot/coc").describe("COC runtime data directory"),
  node: z.object({
    enabled: z.boolean().default(true).describe("Enable coc-node"),
    port: z.number().default(18780).describe("coc-node HTTP port"),
    bind: z.string().default("127.0.0.1").describe("coc-node bind address"),
  }).default({}),
  agent: z.object({
    enabled: z.boolean().default(true).describe("Enable coc-agent"),
    intervalMs: z.number().default(60000).describe("Agent poll interval"),
    batchSize: z.number().default(5).describe("Agent batch size"),
    sampleSize: z.number().default(2).describe("Agent sample proof count"),
  }).default({}),
  relayer: z.object({
    enabled: z.boolean().default(true).describe("Enable coc-relayer"),
    intervalMs: z.number().default(60000).describe("Relayer poll interval"),
    l1RpcUrl: z.string().optional().describe("L1 RPC URL"),
    l2RpcUrl: z.string().optional().describe("L2 RPC URL"),
  }).default({}),
  endpoints: z.object({
    nodeUrl: z.string().default("http://127.0.0.1:18780").describe("coc-node access URL"),
  }).default({}),
  nodes: z.array(NodeEntrySchema).default([]),
})

export type CocConfig = z.infer<typeof CocConfigSchema>
