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
}

export interface ChainSnapshot {
  blocks: ChainBlock[]
  updatedAtMs: number
}

export interface NodePeer {
  id: string
  url: string
}

export interface PendingFilter {
  id: string
  fromBlock: bigint
  toBlock?: bigint
  address?: Hex
  topics?: Array<Hex | null>
  lastCursor: bigint
}
