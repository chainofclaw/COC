import { RPC_URL } from './provider'

let rpcId = 1

export async function rpcCall<T>(method: string, params: unknown[] = []): Promise<T> {
  const response = await fetch(RPC_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      method,
      params,
      id: rpcId++,
    }),
    cache: 'no-store',
  })

  if (!response.ok) {
    throw new Error(`RPC call failed: ${response.statusText}`)
  }

  const json = await response.json()

  if (json.error) {
    throw new Error(json.error.message || 'RPC error')
  }

  return json.result as T
}
