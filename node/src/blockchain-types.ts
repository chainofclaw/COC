export type Hex = `0x${string}`

export interface MempoolTx {
  hash: Hex
  rawTx: Hex
  from: Hex
  nonce: bigint
  gasPrice: bigint
  maxFeePerGas: bigint
  maxPriorityFeePerGas: bigint
  gasLimit: bigint
  /**
   * Tx call value in wei. Phase H3 (2026-04-30) added this for the
   * mempool affordability check: upfront cost = effectiveGasPrice *
   * gasLimit + value, and we drop txs whose sender can't cover that
   * before they get included in a block.
   */
  value: bigint
  receivedAtMs: number
}

export interface ChainBlock {
  number: bigint
  hash: Hex
  parentHash: Hex
  proposer: string
  timestampMs: number
  txs: Hex[]
  finalized: boolean
  bftFinalized?: boolean
  signature?: Hex
  stateRootSig?: Hex
  stateRoot?: Hex
  baseFee?: bigint
  gasUsed?: bigint
  cumulativeWeight?: bigint
  blobGasUsed?: bigint
  excessBlobGas?: bigint
  parentBeaconBlockRoot?: Hex
}

export interface ChainSnapshot {
  blocks: ChainBlock[]
  updatedAtMs: number
}

export interface NodePeer {
  id: string
  url: string
  /**
   * Externally-reachable URL to advertise to other peers during gossip.
   * When a node runs behind NAT or a docker-compose bridge, the `url` used
   * by cluster-internal peers (e.g. http://node-2:19780) is not reachable
   * from outside. Setting `advertisedUrl` lets /p2p/peers responses publish
   * the external URL while keeping `url` for direct connections.
   * Optional; falls back to `url` for backward compatibility.
   */
  advertisedUrl?: string
}

export interface PendingFilter {
  id: string
  // Which RPC method created this filter — drives the eth_getFilterChanges
  // dispatch. Older snapshots may omit the field; callers should treat
  // undefined as "log" to preserve the original behaviour for any persisted
  // filters created before this field existed.
  kind?: "log" | "block" | "pendingTx"
  fromBlock: bigint
  toBlock?: bigint
  address?: Hex
  addresses?: Hex[]
  topics?: Array<Hex | null>
  lastCursor: bigint
  createdAtMs?: number
  // Last time the filter was polled via eth_getFilterChanges /
  // eth_getFilterLogs. The cleanup pass uses this (not createdAtMs) to
  // decide whether a filter has been idle long enough to reap, so
  // long-lived polling subscribers don't get GC'd out from under
  // themselves after FILTER_TTL_MS since creation.
  lastAccessedAtMs?: number
  // pendingTx-only: set of tx hashes already returned to this filter, so
  // a second poll only sees newly-arrived hashes. Kept per filter so two
  // independent pendingTx subscribers each get their own diff.
  seenPendingTxs?: Set<Hex>
}
