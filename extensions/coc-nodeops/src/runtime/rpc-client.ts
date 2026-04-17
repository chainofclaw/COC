import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { resolveDataDir } from "../shared/paths.ts"

export const ALLOWED_RPC_METHODS = [
  "eth_blockNumber",
  "eth_getBlockByNumber",
  "eth_getBlockByHash",
  "net_peerCount",
  "coc_chainStats",
  "coc_getBftStatus",
  "eth_getBalance",
  "eth_syncing",
  "eth_getTransactionByHash",
  "eth_getTransactionReceipt",
] as const

export type AllowedRpcMethod = (typeof ALLOWED_RPC_METHODS)[number]

export async function rpcCall(url: string, method: string, params: unknown[]): Promise<unknown> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    signal: AbortSignal.timeout(5000),
  })
  const json = (await res.json()) as { result?: unknown; error?: { message: string } }
  if (json.error) throw new Error(json.error.message)
  return json.result
}

export async function resolveNodeRpcUrl(dataDir: string): Promise<string> {
  const resolved = resolveDataDir(dataDir)
  let rpcPort = 18780
  let rpcBind = "127.0.0.1"
  try {
    const configPath = join(resolved, "node-config.json")
    const raw = await readFile(configPath, "utf-8")
    const cfg = JSON.parse(raw) as Record<string, unknown>
    if (typeof cfg.rpcPort === "number") rpcPort = cfg.rpcPort
    if (typeof cfg.rpcBind === "string") rpcBind = cfg.rpcBind
  } catch {
    // use defaults
  }
  const host = rpcBind === "0.0.0.0" ? "127.0.0.1" : rpcBind
  return `http://${host}:${rpcPort}`
}

export async function safeRpcQuery(
  dataDir: string,
  method: string,
  params: unknown[],
): Promise<{ result: unknown }> {
  if (!ALLOWED_RPC_METHODS.includes(method as AllowedRpcMethod)) {
    throw new Error(
      `RPC method "${method}" is not allowed. Allowed methods: ${ALLOWED_RPC_METHODS.join(", ")}`,
    )
  }
  const url = await resolveNodeRpcUrl(dataDir)
  const result = await rpcCall(url, method, params)
  return { result }
}
