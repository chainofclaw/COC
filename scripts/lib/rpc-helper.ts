/**
 * Shared JSON-RPC helper for COC stress / probe scripts.
 *
 * Consolidates the ad-hoc `rpc()` fetch wrappers previously duplicated across
 * scripts/stress-advanced.ts, scripts/tps-benchmark.ts and the throwaway
 * Ralph-loop probes. Pure functions, no shared mutable state.
 */

export interface JsonRpcResponse<T = unknown> {
  jsonrpc: "2.0"
  id: number
  result?: T
  error?: { code: number; message: string; data?: unknown }
}

const DEFAULT_TIMEOUT_MS = 10_000

/**
 * Raw JSON-RPC call. Returns the full envelope (result OR error).
 * Throws only on network / non-JSON failure.
 */
export async function rpc<T = unknown>(
  url: string,
  method: string,
  params: unknown[] = [],
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<JsonRpcResponse<T>> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    signal: AbortSignal.timeout(timeoutMs),
  })
  const text = await res.text()
  try {
    return JSON.parse(text) as JsonRpcResponse<T>
  } catch {
    throw new Error(`non-JSON RPC response (http ${res.status}): ${text.slice(0, 120)}`)
  }
}

/** JSON-RPC call that returns `.result` or throws on `.error`. */
export async function rpcResult<T = unknown>(
  url: string,
  method: string,
  params: unknown[] = [],
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<T> {
  const r = await rpc<T>(url, method, params, timeoutMs)
  if (r.error) {
    throw new Error(`RPC ${method} error ${r.error.code}: ${r.error.message}`)
  }
  if (r.result === undefined) {
    throw new Error(`RPC ${method} returned neither result nor error`)
  }
  return r.result
}

/** Current head block number as a JS number. */
export async function getHead(url: string, timeoutMs: number = DEFAULT_TIMEOUT_MS): Promise<number> {
  const hex = await rpcResult<string>(url, "eth_blockNumber", [], timeoutMs)
  return parseInt(hex, 16)
}

/** Best-effort head; returns null instead of throwing (for monitoring loops). */
export async function tryGetHead(url: string, timeoutMs: number = DEFAULT_TIMEOUT_MS): Promise<number | null> {
  try {
    return await getHead(url, timeoutMs)
  } catch {
    return null
  }
}

export interface HeadSkew {
  heads: Record<string, number | null>
  reachable: number
  /** max - min across reachable nodes; null if <2 reachable. */
  skew: number | null
}

/** Query several endpoints and report head divergence (cross-node consistency). */
export async function crossCheckHeads(urls: string[], timeoutMs: number = DEFAULT_TIMEOUT_MS): Promise<HeadSkew> {
  const entries = await Promise.all(
    urls.map(async (u) => [u, await tryGetHead(u, timeoutMs)] as const),
  )
  const heads: Record<string, number | null> = {}
  for (const [u, h] of entries) heads[u] = h
  const live = entries.map(([, h]) => h).filter((h): h is number => h !== null)
  return {
    heads,
    reachable: live.length,
    skew: live.length >= 2 ? Math.max(...live) - Math.min(...live) : null,
  }
}

export interface TxReceipt {
  blockNumber: string
  status: string
  gasUsed: string
  cumulativeGasUsed: string
  effectiveGasPrice?: string
  contractAddress: string | null
  logs: unknown[]
  logsBloom: string
}

/** Poll `eth_getTransactionReceipt` until mined or the deadline passes. */
export async function waitForReceipt(
  url: string,
  hash: string,
  opts: { timeoutMs?: number; pollMs?: number } = {},
): Promise<TxReceipt | null> {
  const timeoutMs = opts.timeoutMs ?? 60_000
  const pollMs = opts.pollMs ?? 1_500
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const r = await rpc<TxReceipt | null>(url, "eth_getTransactionReceipt", [hash])
    if (r.result) return r.result
    await new Promise((res) => setTimeout(res, pollMs))
  }
  return null
}
