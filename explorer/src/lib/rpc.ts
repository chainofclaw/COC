import { RPC_URL } from './provider'

let rpcId = 1

/**
 * Send a raw JSON-RPC call to the COC node.
 */
export async function rpcCall<T = unknown>(method: string, params: unknown[] = []): Promise<T> {
  const res = await fetch(RPC_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: rpcId++, method, params }),
    cache: 'no-store',
  })
  const json = await res.json()
  if (json.error) throw new Error(json.error.message)
  return json.result as T
}

export interface AddressTx {
  hash: string
  from: string
  to: string | null
  blockNumber: string
  blockHash: string
  gasUsed: string
  status: string
  input: string
  logs: Array<{ address: string; topics: string[]; data: string }>
}

/**
 * Fetch transaction history for an address via custom RPC.
 */
export async function getTransactionsByAddress(
  address: string,
  limit = 50,
  reverse = true,
): Promise<AddressTx[]> {
  return rpcCall<AddressTx[]>('coc_getTransactionsByAddress', [address, limit, reverse])
}
