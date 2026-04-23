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
  fromBlock: bigint
  toBlock?: bigint
  address?: Hex
  addresses?: Hex[]
  topics?: Array<Hex | null>
  lastCursor: bigint
  createdAtMs?: number
}
